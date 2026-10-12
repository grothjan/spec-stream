/**
 * sync-back command.
 *
 * Walks the local model directory, diffs it against the last-known manifest state
 * (sync-manifest.json written by sync, sync-back-ids.json written by previous
 * sync-back runs), builds API operations from the diff, and executes them against
 * the prooph board REST API.
 *
 * No git dependency — works whether or not the model directory is tracked by git,
 * gitignored, or git is not installed.
 *
 * Can be called from a git pre-commit hook (optional) or run manually at any time:
 *
 *   spec-stream sync-back [--dry-run] [--verbose]
 */

import { resolve } from "node:path";
import { loadConfig, resolveApiKey } from "../config/load.js";
import { loadDotenv } from "../config/dotenv.js";
import { ConfigError } from "../config/schema.js";
import { RestClient } from "../sync/restClient.js";
import { computeManifestDiff, computeDiskHash } from "./manifestDiff.js";
import { buildOperations } from "./operationBuilder.js";
import { executeOperations } from "./executor.js";
import {
  loadManifest,
  saveManifest,
  syncBackIdsPath,
  syncManifestPath,
  readEntityFields,
  readEntityContentHashes,
  type ManifestEntry,
  type ScenarioExpectationSnapshot,
} from "./manifest.js";

export interface SyncBackOptions {
  /** Path to the config file (optional, defaults to discovery). */
  configPath?: string;
  /** When true, log operations but do not call the API. */
  dryRun?: boolean;
  /** Enable verbose output. */
  verbose?: boolean;
  /** Working directory (defaults to process.cwd()). */
  cwd?: string;
  /** Override fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
}

export interface SyncBackResult {
  /** Number of operations that were executed (or would be, in dry-run). */
  operationCount: number;
  /** Number of successfully executed operations. */
  executed: number;
  /** Number of skipped operations (dry-run). */
  skipped: number;
  /** Number of failed operations. */
  failed: number;
  errors: Array<{ operation: unknown; error: string }>;
}

/**
 * Run the sync-back command.
 *
 * Loads config, computes manifest diff, builds operations, executes them.
 * After execution, persists new entity ids to sync-back-ids.json so the next
 * run can identify those entities without needing the sync process to have
 * processed the corresponding changelog events yet.
 *
 * Returns a result summary. Throws on fatal errors (bad config, etc.).
 */
export async function runSyncBack(opts: SyncBackOptions = {}): Promise<SyncBackResult> {
  const cwd = opts.cwd ?? process.cwd();
  const dryRun = opts.dryRun ?? false;
  const verbose = opts.verbose ?? false;

  const log = (msg: string) => {
    process.stdout.write(msg + "\n");
  };
  const debug = verbose ? log : (_msg: string) => {};

  // ─── Load config ────────────────────────────────────────────────────────
  loadDotenv(cwd);
  if (opts.configPath) loadDotenv(resolve(cwd, opts.configPath, ".."));

  let loaded;
  try {
    loaded = loadConfig({ configPath: opts.configPath });
  } catch (err) {
    if (err instanceof ConfigError) throw new Error(`Config error: ${err.message}`);
    throw err;
  }
  const { config } = loaded;

  // ─── Validate localSync config ───────────────────────────────────────────
  if (!config.localSync?.enabled) {
    throw new Error(
      "sync-back requires localSync to be enabled in proophboard.spec-stream.json. " +
      "Add: { \"localSync\": { \"enabled\": true, \"dir\": \".spec-stream/model\" } }",
    );
  }

  const syncDir = config.localSync.dir ?? ".spec-stream/model";
  const syncDirAbs = resolve(cwd, syncDir);

  debug(`Sync root: ${syncDirAbs}`);

  // ─── API key ─────────────────────────────────────────────────────────────
  let apiKey: string;
  try {
    apiKey = resolveApiKey();
  } catch (err) {
    if (err instanceof ConfigError) throw new Error(`Config error: ${err.message}`);
    throw err;
  }

  // ─── Compute manifest diff ────────────────────────────────────────────────
  const diffs = computeManifestDiff({ syncRootAbs: syncDirAbs });

  debug(`Found ${diffs.length} changed entity/entities`);

  if (diffs.length === 0) {
    log("No changes detected — nothing to sync back.");
    return { operationCount: 0, executed: 0, skipped: 0, failed: 0, errors: [] };
  }

  if (verbose) {
    for (const d of diffs) {
      const extra = d.oldEntityDir ? ` (was: ${d.oldEntityDir})` : "";
      debug(`  ${d.status.toUpperCase().padEnd(6)} ${d.kind} @ ${d.entityDir}${extra}`);
    }
  }

  // ─── Build operations ─────────────────────────────────────────────────────
  const operations = await buildOperations({ syncRootAbs: syncDirAbs, diffs });

  if (operations.length === 0) {
    log("No sync-back operations to perform.");
    return { operationCount: 0, executed: 0, skipped: 0, failed: 0, errors: [] };
  }

  log(`${dryRun ? "[dry-run] " : ""}Syncing ${operations.length} operation(s) back to prooph board…`);

  // ─── Execute ──────────────────────────────────────────────────────────────
  const client = new RestClient({
    endpoint: config.endpoint,
    apiKey,
    fetchImpl: opts.fetchImpl,
  });

  const execResult = await executeOperations(client, operations, { dryRun, log });

  // ─── Persist state to sync-back-ids.json ─────────────────────────────────
  // Write new ids from creates AND updated content hashes for updates/renames.
  // This allows the next sync-back run to skip entities whose content hasn't
  // changed, rather than emitting update operations for every entity on disk.
  // Not written in dry-run mode.
  if (!dryRun) {
    const idsPath = syncBackIdsPath(syncDirAbs);
    const existing = loadManifest(idsPath);
    let wrote = 0;

    for (const diff of diffs) {
      if (diff.status === "delete") continue; // deletes remove from manifest — sync handles this

      // Skip if any operation for this entity failed. This ensures the next sync-back
      // run retries the failed operations rather than silently treating the entity as
      // up-to-date (which would happen if we advanced the content hash here).
      if (execResult.failedEntityDirs.has(diff.entityDir)) {
        debug(`Skipping manifest update for ${diff.entityDir} (operation failed — will retry next run)`);
        continue;
      }

      const id = diff.id ?? execResult.newIds.get(diff.entityDir);
      if (!id) continue; // create failed — no id returned, skip

      // Compute current disk hash and fields snapshot for next-run change detection.
      const hash = computeDiskHash(syncDirAbs, diff.entityDir, diff.kind);
      const fields = readEntityFields(syncDirAbs, diff.entityDir, diff.kind);
      const contentHashes = readEntityContentHashes(syncDirAbs, diff.entityDir);

      const entry: ManifestEntry = {
        id,
        hash,
        ...(Object.keys(fields).length > 0 && { fields }),
        ...(Object.keys(contentHashes).length > 0 && { contentHashes }),
      };

      // For scenarios, persist the current expectations array so the next sync-back
      // run can diff against it and emit scenario.remove-expectation operations when
      // expectations are deleted locally (BUG-005).
      if (diff.kind === "scenario") {
        const scenarioExpectations = readScenarioExpectations(syncDirAbs, diff.entityDir);
        if (scenarioExpectations !== null) {
          entry.extra = { expectations: scenarioExpectations };
        }
      }

      existing.entities[diff.entityDir] = entry;
      wrote++;
    }

    // ── GC: remove stale sync-back-ids entries superseded by sync-manifest ──────
    // When the sync process renames an entity directory on disk (because the board
    // sent back an element-renamed / chapter-renamed / etc. event after sync-back
    // pushed the rename), it updates sync-manifest.json to the new dir but leaves
    // the old entry in sync-back-ids.json.  On the next run, both dirs appear in the
    // merged manifest while only the new dir exists on disk — causing a spurious
    // delete.  computeManifestDiff already guards against this, but we also GC here
    // so the stale entry doesn't accumulate forever.
    const syncManifest = loadManifest(syncManifestPath(syncDirAbs));
    // Build a map from id → canonical dir according to sync-manifest.
    const manifestIdToDir = new Map<string, string>();
    for (const [dir, entry] of Object.entries(syncManifest.entities)) {
      manifestIdToDir.set(entry.id, dir);
    }
    let gcCount = 0;
    for (const [dir, entry] of Object.entries(existing.entities)) {
      const canonicalDir = manifestIdToDir.get(entry.id);
      if (canonicalDir !== undefined && canonicalDir !== dir) {
        // sync-manifest tracks this id under a different (newer) directory —
        // this sync-back-ids entry is stale; remove it.
        delete existing.entities[dir];
        gcCount++;
      }
    }
    if (gcCount > 0) {
      wrote += gcCount; // ensure we save
      debug(`GC: removed ${gcCount} stale sync-back-ids entr${gcCount === 1 ? "y" : "ies"} superseded by sync-manifest`);
    }

    if (wrote > 0) {
      existing.updatedAt = new Date().toISOString();
      try {
        saveManifest(idsPath, existing);
        debug(`Updated sync-back-ids.json: ${wrote} entry/entries`);
      } catch (err) {
        log(`Warning: could not write sync-back-ids.json: ${(err as Error).message}`);
      }
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  const total = operations.length;
  if (dryRun) {
    log(`Done (dry-run): ${total} operation(s) would be executed.`);
  } else {
    const parts: string[] = [];
    if (execResult.executed > 0) parts.push(`${execResult.executed} succeeded`);
    if (execResult.failed > 0) parts.push(`${execResult.failed} failed`);
    log(`Done: ${parts.join(", ")}.`);
  }

  return {
    operationCount: total,
    executed: execResult.executed,
    skipped: execResult.skipped,
    failed: execResult.failed,
    errors: execResult.errors,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Read the expectations array from a scenario.json on disk.
 * Returns the array (possibly empty) if the file exists, or null if the file
 * is missing or unreadable.
 */
function readScenarioExpectations(
  syncRootAbs: string,
  entityDir: string,
): ScenarioExpectationSnapshot[] | null {
  try {
    const absPath = join(syncRootAbs, entityDir, "scenario.json");
    if (!existsSync(absPath)) return null;
    const parsed = JSON.parse(readFileSync(absPath, "utf8")) as { expectations?: unknown[] };
    return Array.isArray(parsed.expectations)
      ? (parsed.expectations as ScenarioExpectationSnapshot[])
      : [];
  } catch {
    return null;
  }
}
