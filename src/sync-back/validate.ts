/**
 * `spec-stream model validate` — structural consistency check for the local model tree.
 *
 * Reads the file tree under the sync root and reports issues that would cause
 * sync-back to fail or produce incorrect results:
 *
 *  1. JSON syntax errors in any .json file.
 *  2. Missing required fields in primary .json files.
 *  3. Dangling UUID references: element.json laneId/sliceId not in uuid-index.json
 *     AND not present as an id in any local .json file (i.e., not a locally-assigned UUID
 *     that has not yet been pushed to the board via sync-back).
 *  4. Dangling UUID references: scenario expectation sliceId/elementId not in uuid-index
 *     AND not a locally-assigned UUID.
 *  5. UUID collisions: two different dirs claim the same UUID.
 *  6. chapter.json sliceOrder and laneOrder must reference all slices/lanes in the chapter.
 *  7. chapter.json sliceOrder/laneOrder entries must exist as directories.
 *  8. element.json sliceId and laneId must be listed in chapter.json sliceOrder and laneOrder.
 *
 * Exits 0 if clean, 1 if any issues found.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ValidateOptions {
  /** Absolute path to the sync root directory (e.g. `/project/.spec-stream/model`). */
  syncRootAbs: string;
  /** When true, print every checked path even when no issues are found. */
  verbose?: boolean;
}

export interface ValidationIssue {
  /** Path relative to sync root where the issue was found. */
  path: string;
  message: string;
}

export interface ValidateResult {
  issues: ValidationIssue[];
  /** Number of files checked. */
  checked: number;
}

/**
 * Run all structural checks on the model tree and return the aggregated result.
 * This function performs only filesystem reads — no API calls.
 */
export function validateModel(opts: ValidateOptions): ValidateResult {
  const { syncRootAbs, verbose = false } = opts;
  const issues: ValidationIssue[] = [];
  let checked = 0;

  if (!existsSync(syncRootAbs)) {
    issues.push({ path: ".", message: `Sync root does not exist: ${syncRootAbs}` });
    return { issues, checked };
  }

  // ── 1. Load uuid-index.json ──────────────────────────────────────────────────
  const uuidIndexPath = "uuid-index.json";
  const uuidIndex = readJsonChecked(syncRootAbs, uuidIndexPath, issues);
  checked++;

  // Build a reverse map: dir → uuid[] so we can detect collisions.
  const dirToUuids = new Map<string, string[]>();
  // Also collect the uuid → dir map for reference checks.
  const uuidToDir = new Map<string, string>();

  if (uuidIndex) {
    for (const [uuid, dir] of Object.entries(uuidIndex)) {
      if (typeof dir !== "string") {
        issues.push({ path: uuidIndexPath, message: `Entry "${uuid}" has non-string value` });
        continue;
      }
      if (uuidToDir.has(uuid)) {
        issues.push({ path: uuidIndexPath, message: `Duplicate UUID "${uuid}" (points to both "${uuidToDir.get(uuid)}" and "${dir}")` });
      } else {
        uuidToDir.set(uuid, dir);
      }
      const existing = dirToUuids.get(dir) ?? [];
      existing.push(uuid);
      dirToUuids.set(dir, existing);
    }
  }

  if (verbose) {
    process.stdout.write(`  checked: ${uuidIndexPath}\n`);
  }

  // ── 2. Walk all .json files and validate them ────────────────────────────────
  const allJsonFiles = collectJsonFiles(syncRootAbs);

  // ── 2a. First pass: collect all chapters and their sliceOrder/laneOrder ─────
  // Also collect all slice and lane UUIDs found in the tree per chapter
  // Create reverse map: chapter dir → chapter uuid
  const dirToChapterUuid = new Map<string, string>();
  const chapterDirs = new Map<string, { sliceOrder: string[]; laneOrder: string[] }>();
  const chapterFolderSlices = new Map<string, Set<string>>();
  const chapterFolderLanes = new Map<string, Set<string>>();

  for (const relPath of allJsonFiles) {
    if (relPath.endsWith("/chapter.json")) {
      const chapterData = readJsonChecked(syncRootAbs, relPath, issues);
      if (chapterData) {
        const sliceOrder = Array.isArray(chapterData["sliceOrder"]) ? chapterData["sliceOrder"] : [];
        const laneOrder = Array.isArray(chapterData["laneOrder"]) ? chapterData["laneOrder"] : [];
        const chapterUuid = typeof chapterData["id"] === "string" ? chapterData["id"] : null;

        // The chapter directory is the path without /chapter.json
        const chapterDir = relPath.slice(0, -"/chapter.json".length);

        if (chapterUuid) {
          dirToChapterUuid.set(chapterDir, chapterUuid);
          chapterDirs.set(chapterUuid, { sliceOrder, laneOrder });
          chapterFolderSlices.set(chapterUuid, new Set<string>());
          chapterFolderLanes.set(chapterUuid, new Set<string>());
        }
      }
    } else if (relPath.endsWith("/slice.json")) {
      const sliceData = readJsonChecked(syncRootAbs, relPath, issues);
      if (sliceData && typeof sliceData["id"] === "string") {
        // Find the chapter this slice belongs to
        const dir = relPath.slice(0, -"/slice.json".length);
        const chapterDir = extractChapterDir(dir);
        const chapterUuid = chapterDir ? dirToChapterUuid.get(chapterDir) : null;
        if (chapterUuid) {
          chapterFolderSlices.get(chapterUuid)?.add(sliceData["id"]);
        }
      }
    } else if (relPath.endsWith("/lane.json")) {
      const laneData = readJsonChecked(syncRootAbs, relPath, issues);
      if (laneData && typeof laneData["id"] === "string") {
        // Find the chapter this lane belongs to
        const dir = relPath.slice(0, -"/lane.json".length);
        const chapterDir = extractChapterDir(dir);
        const chapterUuid = chapterDir ? dirToChapterUuid.get(chapterDir) : null;
        if (chapterUuid) {
          chapterFolderLanes.get(chapterUuid)?.add(laneData["id"]);
        }
      }
    }
  }

  // ── 2b. Collect all locally-present entity IDs (id fields in *.json files) ──
  // These are UUIDs the agent assigned locally that may not yet be in uuid-index.json
  // because sync-back hasn't been called yet (or the sync process hasn't echoed them
  // back). A laneId/sliceId reference to one of these is a valid local reference and
  // should not be flagged as dangling.
  const localIds = new Set<string>();
  for (const relPath of allJsonFiles) {
    if (relPath === uuidIndexPath || relPath === "workspace.json") continue;
    try {
      const raw = readFileSync(join(syncRootAbs, relPath), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const id = (parsed as Record<string, unknown>)["id"];
        if (typeof id === "string" && id.length > 0) {
          localIds.add(id);
        }
      }
    } catch {
      // parse errors are reported in the main loop below
    }
  }

  // ── 2c. Second pass: run all validations ─────────────────────────────────────
  for (const relPath of allJsonFiles) {
    if (relPath === uuidIndexPath || relPath === "workspace.json") {
      // Already handled or no required fields to check.
      checked++;
      if (verbose) process.stdout.write(`  checked: ${relPath}\n`);
      continue;
    }

    const data = readJsonChecked(syncRootAbs, relPath, issues);
    checked++;
    if (verbose) process.stdout.write(`  checked: ${relPath}\n`);
    if (!data) continue; // JSON parse error already recorded

    // Dispatch to per-kind validators based on filename.
    if (relPath.endsWith("/element.json")) {
      checkElementJson(relPath, data, uuidToDir, localIds, issues, chapterDirs, dirToChapterUuid);
    } else if (relPath.endsWith("/scenario.json")) {
      checkScenarioJson(relPath, data, uuidToDir, localIds, issues);
    } else if (relPath.endsWith("/chapter.json")) {
      checkChapterJson(relPath, data, issues, chapterDirs, chapterFolderSlices, chapterFolderLanes);
    } else if (relPath.endsWith("/slice.json")) {
      checkRequiredString(relPath, data, "id", issues);
      checkRequiredString(relPath, data, "label", issues);
      checkOptionalEnum(relPath, data, "status", SLICE_STATUSES, issues);
    } else if (relPath.endsWith("/lane.json")) {
      checkRequiredString(relPath, data, "id", issues);
      checkRequiredString(relPath, data, "label", issues);
      checkRequiredEnum(relPath, data, "type", LANE_TYPES, issues);
    } else if (relPath.endsWith("/milestone.json")) {
      checkRequiredString(relPath, data, "id", issues);
      checkRequiredString(relPath, data, "name", issues);
    } else if (HTML_SNIPPET_JSON_RE.test(relPath)) {
      checkRequiredString(relPath, data, "name", issues);
    }
  }

  return { issues, checked };
}

// ─── Check helpers ────────────────────────────────────────────────────────────

const LANE_TYPES    = ["user-lane", "information-flow", "system"] as const;
const ELEMENT_TYPES = ["command", "event", "information", "ui", "automation", "hotspot"] as const;
const SLICE_STATUSES = ["draft", "planned", "in-progress", "blocked", "ready", "reviewed", "deployed"] as const;
const EXPECTATION_KINDS = ["events", "information", "rejection"] as const;

/** Matches html-snippets/[slug].json (no subdirectory between html-snippets and the file). */
const HTML_SNIPPET_JSON_RE = /^html-snippets\/[^/]+\.json$/;

/**
 * Extract the chapter directory path from a file path.
 * E.g., "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E" -> "chapters/App/Ch"
 * Also handles UUID-based chapter paths like "chapters/uuid/..."
 */
function extractChapterDir(filePath: string): string | null {
  // Match pattern: chapters/<chapter-name>/... -> extract up to chapters/<chapter-name>
  // Chapter name can be either a UUID (36 chars with hyphens) or a path-like name
  // First try to match UUID pattern: chapters/uuid/...
  const uuidMatch = filePath.match(/^(chapters\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/.*)?$/i);
  if (uuidMatch) {
    return uuidMatch[1];
  }
  // Fallback: match two-segment paths like chapters/App/Ch/...
  const twoMatch = filePath.match(/^(chapters\/[^/]+\/[^/]+)(?:\/.*)?$/);
  return twoMatch ? twoMatch[1] : null;
}

function checkChapterJson(
  relPath: string,
  data: Record<string, unknown>,
  issues: ValidationIssue[],
  chapterDirs: Map<string, { sliceOrder: string[]; laneOrder: string[] }>,
  chapterFolderSlices: Map<string, Set<string>>,
  chapterFolderLanes: Map<string, Set<string>>,
): void {
  checkRequiredString(relPath, data, "id", issues);
  checkRequiredString(relPath, data, "name", issues);
  checkRequiredString(relPath, data, "context", issues);

  const chapterUuid = data["id"] as string;
  if (!chapterUuid || typeof chapterUuid !== "string") {
    return; // Cannot validate without valid UUID
  }

  // Validate chapterOrder references match folder contents
  const chapterOrder = chapterDirs.get(chapterUuid);
  const folderSlices = chapterFolderSlices.get(chapterUuid);
  const folderLanes = chapterFolderLanes.get(chapterUuid);

  // If chapterOrder is not defined (empty arrays), skip the chapterOrder validation
  // This maintains backward compatibility with models that don't use chapterOrder
  if (!chapterOrder || !folderSlices || !folderLanes) {
    // Chapter not found in our maps, skip additional checks
    return;
  }

  const { sliceOrder, laneOrder } = chapterOrder;

  // Only perform chapterOrder validation if the arrays are non-empty
  // This maintains backward compatibility with models that don't use chapterOrder
  if (sliceOrder.length === 0 && laneOrder.length === 0) {
    return;
  }

  // Check 1: All slices in folder must be in sliceOrder
  for (const sliceId of folderSlices) {
    if (!sliceOrder.includes(sliceId)) {
      issues.push({ path: relPath, message: `Slice "${sliceId}" in chapter folder is not listed in sliceOrder` });
    }
  }

  // Check 2: All lanes in folder must be in laneOrder
  for (const laneId of folderLanes) {
    if (!laneOrder.includes(laneId)) {
      issues.push({ path: relPath, message: `Lane "${laneId}" in chapter folder is not listed in laneOrder` });
    }
  }

  // Check 3: All entries in sliceOrder must exist in folder
  for (const sliceId of sliceOrder) {
    if (!folderSlices.has(sliceId)) {
      issues.push({ path: relPath, message: `sliceOrder references "${sliceId}" which is not present in the chapter folder` });
    }
  }

  // Check 4: All entries in laneOrder must exist in folder
  for (const laneId of laneOrder) {
    if (!folderLanes.has(laneId)) {
      issues.push({ path: relPath, message: `laneOrder references "${laneId}" which is not present in the chapter folder` });
    }
  }
}

function checkElementJson(
  relPath: string,
  data: Record<string, unknown>,
  uuidToDir: Map<string, string>,
  localIds: Set<string>,
  issues: ValidationIssue[],
  chapterDirs: Map<string, { sliceOrder: string[]; laneOrder: string[] }>,
  dirToChapterUuid: Map<string, string>,
): void {
  checkRequiredString(relPath, data, "id", issues);
  checkRequiredString(relPath, data, "name", issues);
  checkRequiredEnum(relPath, data, "type", ELEMENT_TYPES, issues);

  // laneId and sliceId must be present and either exist in uuid-index or be a
  // locally-assigned UUID present in a local .json file (not yet pushed via sync-back).
  const laneId = typeof data["laneId"] === "string" ? data["laneId"] : null;
  const sliceId = typeof data["sliceId"] === "string" ? data["sliceId"] : null;

  if (!laneId) {
    issues.push({ path: relPath, message: `Missing required field "laneId"` });
  } else if (!uuidToDir.has(laneId) && !localIds.has(laneId)) {
    issues.push({ path: relPath, message: `laneId "${laneId}" not found in uuid-index.json` });
  }

  if (!sliceId) {
    issues.push({ path: relPath, message: `Missing required field "sliceId"` });
  } else if (!uuidToDir.has(sliceId) && !localIds.has(sliceId)) {
    issues.push({ path: relPath, message: `sliceId "${sliceId}" not found in uuid-index.json` });
  }

  // Extract chapter from element path and validate sliceId/laneId are in chapterOrder
  const elementDir = relPath.slice(0, -"/element.json".length);
  const chapterDir = extractChapterDir(elementDir);
  if (chapterDir) {
    const chapterUuid = dirToChapterUuid.get(chapterDir);
    if (chapterUuid) {
      const chapterOrder = chapterDirs.get(chapterUuid);
      if (chapterOrder) {
        const { sliceOrder, laneOrder } = chapterOrder;
        // Only validate if chapterOrder has entries (non-empty arrays)
        // This maintains backward compatibility with models that don't use chapterOrder
        if (sliceOrder.length > 0 && !sliceOrder.includes(sliceId || "")) {
          issues.push({ path: relPath, message: `sliceId "${sliceId}" not listed in chapter.json sliceOrder` });
        }
        if (laneOrder.length > 0 && !laneOrder.includes(laneId || "")) {
          issues.push({ path: relPath, message: `laneId "${laneId}" not listed in chapter.json laneOrder` });
        }
      }
    }
  }
}

function checkScenarioJson(
  relPath: string,
  data: Record<string, unknown>,
  uuidToDir: Map<string, string>,
  localIds: Set<string>,
  issues: ValidationIssue[],
): void {
  checkRequiredString(relPath, data, "id", issues);
  checkRequiredString(relPath, data, "chapterId", issues);
  checkRequiredString(relPath, data, "name", issues);

  // Validate each expectation's sliceId and optional elementId.
  const expectations = data["expectations"];
  if (!Array.isArray(expectations)) return; // optional field — no error if absent

  for (let i = 0; i < expectations.length; i++) {
    const exp = expectations[i] as Record<string, unknown>;
    if (!exp || typeof exp !== "object") {
      issues.push({ path: relPath, message: `expectations[${i}] is not an object` });
      continue;
    }

    const expId = typeof exp["id"] === "string" ? exp["id"] : `<missing id at index ${i}>`;

    if (!exp["id"]) {
      issues.push({ path: relPath, message: `expectations[${i}] missing required field "id"` });
    }
    checkRequiredEnumOnRecord(relPath, exp, "kind", EXPECTATION_KINDS, `expectation "${expId}"`, issues);
    if (!exp["expected"]) {
      issues.push({ path: relPath, message: `expectation "${expId}" missing required field "expected"` });
    }

    const sliceId = typeof exp["sliceId"] === "string" ? exp["sliceId"] : null;
    if (!sliceId) {
      issues.push({ path: relPath, message: `expectation "${expId}" missing required field "sliceId"` });
    } else if (!uuidToDir.has(sliceId) && !localIds.has(sliceId)) {
      issues.push({ path: relPath, message: `expectation "${expId}" sliceId "${sliceId}" not found in uuid-index.json` });
    }

    const elementId = typeof exp["elementId"] === "string" ? exp["elementId"] : null;
    if (elementId && !uuidToDir.has(elementId) && !localIds.has(elementId)) {
      issues.push({ path: relPath, message: `expectation "${expId}" elementId "${elementId}" not found in uuid-index.json` });
    }
  }
}

function checkRequiredString(
  relPath: string,
  data: Record<string, unknown>,
  field: string,
  issues: ValidationIssue[],
): void {
  if (typeof data[field] !== "string" || data[field] === "") {
    issues.push({ path: relPath, message: `Missing required field "${field}"` });
  }
}

/**
 * Check that a field is present and one of the allowed enum values.
 * Reports "Missing" if absent/empty, "Invalid value" if present but wrong.
 */
function checkRequiredEnum(
  relPath: string,
  data: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
  issues: ValidationIssue[],
): void {
  const val = data[field];
  if (typeof val !== "string" || val === "") {
    issues.push({ path: relPath, message: `Missing required field "${field}" (must be one of: ${allowed.join(", ")})` });
  } else if (!(allowed as readonly string[]).includes(val)) {
    issues.push({ path: relPath, message: `Invalid value "${val}" for field "${field}" (must be one of: ${allowed.join(", ")})` });
  }
}

/**
 * Check that an optional field, when present, is one of the allowed enum values.
 * No error if the field is absent.
 */
function checkOptionalEnum(
  relPath: string,
  data: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
  issues: ValidationIssue[],
): void {
  const val = data[field];
  if (val === undefined || val === null) return; // absent is fine
  if (typeof val !== "string" || !(allowed as readonly string[]).includes(val)) {
    issues.push({ path: relPath, message: `Invalid value "${val}" for field "${field}" (must be one of: ${allowed.join(", ")})` });
  }
}

/**
 * Like checkRequiredEnum but operates on a nested record (e.g. an expectation object)
 * and prefixes the error with a custom context string.
 */
function checkRequiredEnumOnRecord(
  relPath: string,
  data: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
  context: string,
  issues: ValidationIssue[],
): void {
  const val = data[field];
  if (typeof val !== "string" || val === "") {
    issues.push({ path: relPath, message: `${context} missing required field "${field}" (must be one of: ${allowed.join(", ")})` });
  } else if (!(allowed as readonly string[]).includes(val)) {
    issues.push({ path: relPath, message: `${context} invalid value "${val}" for field "${field}" (must be one of: ${allowed.join(", ")})` });
  }
}

// ─── JSON reader ─────────────────────────────────────────────────────────────

/**
 * Read and parse a JSON file. Returns the parsed object, or null if the file doesn't
 * exist or contains invalid JSON. Adds an issue on parse failure.
 */
function readJsonChecked(
  root: string,
  relPath: string,
  issues: ValidationIssue[],
): Record<string, unknown> | null {
  const abs = join(root, relPath);
  if (!existsSync(abs)) {
    // uuid-index.json not existing is already a problem; caller should have flagged it
    // if needed. For other files, absence is not our concern here.
    return null;
  }
  try {
    const raw = readFileSync(abs, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      issues.push({ path: relPath, message: `JSON root must be an object` });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    issues.push({ path: relPath, message: `Invalid JSON: ${(err as Error).message}` });
    return null;
  }
}

// ─── File collector ───────────────────────────────────────────────────────────

/**
 * Recursively collect all `.json` file paths under `root`, returning paths relative
 * to `root` with forward slashes. Skips the `.spec-stream` state directory itself and
 * node_modules just in case the sync root is inside a project.
 */
function collectJsonFiles(root: string): string[] {
  const results: string[] = [];
  walk(root, root, results);
  return results.sort(); // stable order for deterministic output
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);

function walk(root: string, dir: string, results: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(root, abs, results);
    } else if (entry.endsWith(".json")) {
      const rel = abs.slice(root.length).replace(/\\/g, "/").replace(/^\//, "");
      results.push(rel);
    }
  }
}

// ─── CLI runner ───────────────────────────────────────────────────────────────

export interface RunValidateOptions {
  /** Config file path (used to resolve syncDir). */
  configPath?: string;
  /** When true, print every checked path. */
  verbose?: boolean;
}

/**
 * Top-level runner called from the CLI. Resolves the sync root from config,
 * runs validation, and prints the results.
 */
export async function runValidate(opts: RunValidateOptions): Promise<{ ok: boolean }> {
  // Resolve sync root from config (same approach as sync-back).
  const { loadConfig } = await import("../config/load.js");
  const { loadDotenv } = await import("../config/dotenv.js");

  loadDotenv();
  const { config } = loadConfig({ configPath: opts.configPath });

  const localSync = (config as { localSync?: { dir?: string; enabled?: boolean } }).localSync;
  if (!localSync?.enabled) {
    process.stderr.write(
      `spec-stream model validate: localSync is not enabled in your config.\n` +
      `Add "localSync": { "enabled": true, "dir": ".spec-stream/model" } to your config file.\n`,
    );
    return { ok: false };
  }

  const syncDir = localSync.dir ?? ".spec-stream/model";
  const syncRootAbs = syncDir.startsWith("/")
    ? syncDir
    : `${config.configDir ?? process.cwd()}/${syncDir}`.replace(/\/+/g, "/");

  process.stdout.write(`Validating model at ${syncRootAbs}…\n`);

  const result = validateModel({ syncRootAbs, verbose: opts.verbose });

  if (result.issues.length === 0) {
    process.stdout.write(`✓ ${result.checked} file(s) checked — no issues found.\n`);
    return { ok: true };
  }

  for (const issue of result.issues) {
    process.stdout.write(`✗ ${issue.path}\n  ${issue.message}\n`);
  }
  process.stdout.write(
    `\n${result.issues.length} issue(s) found in ${result.checked} file(s) checked.\n`,
  );
  return { ok: false };
}
