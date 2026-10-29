/**
 * Filesystem writer for the local model projection.
 *
 * Takes a {@link DesiredTree} (relative POSIX path -> content, from the renderer) and
 * makes the target directory match it exactly. The directory is treated as
 * **exclusively owned** by spec-stream: any file under it that is not in the desired tree
 * is deleted, and empty directories are pruned. This makes the tree a faithful mirror —
 * renames and removals clean up after themselves.
 *
 * One exception to exclusive ownership: {@link PROTECTED_DIRS} (`.git`) are never
 * enumerated, deleted, or pruned. Users commonly keep the mirror under version control,
 * and `localSync.git` itself creates a history repo at the mirror root — deleting it
 * would silently destroy repositories (see proophboard/spec-stream#6).
 *
 * Writes are diff-based: a file is only rewritten when its content actually changed, so an
 * unchanged projection touches nothing on disk (clean git history, no needless churn).
 *
 * All paths in the desired tree are relative POSIX paths; they are resolved under `rootDir`
 * using the host path separator. The writer never writes outside `rootDir` (the renderer
 * already sanitizes segments; the writer additionally rejects any path that escapes root).
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";
import type { DesiredTree } from "./render.js";

/**
 * Directory names that are never touched by the writer — not listed, not deleted,
 * not pruned — even though they are not part of the desired tree. `.git` protects
 * both a user's own repo at the mirror root and the history repo that
 * `localSync.git` creates there (projection's `defaultCommit` runs `git init` in
 * the dir; without this guard the next sweep would delete it again).
 */
const PROTECTED_DIRS = new Set([".git"]);

const isProtectedDir = (name: string): boolean => PROTECTED_DIRS.has(name);

/** Breakdown of what files were changed by type */
export interface ChangeBreakdown {
  chapters: number;
  slices: number;
  lanes: number;
  elements: number;
  milestones: number;
  scenarios: number;
  htmlSnippets: number;
  contentFiles: number; // description.md, details.md, play-function.ts, play-type.ts
  manifests: number;    // sync-manifest.json, sync-back-ids.json
  stateFiles: number;   // sync-state.json
  other: number;
}

export interface WriteResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  /** Detailed breakdown of what was created/updated/deleted */
  byType: ChangeBreakdown;
  /**
   * Files that were actually changed (created or updated). 
   * Used to determine if a write pass had meaningful changes.
   */
  changedFiles: string[];
  /**
   * Git-style file list for verbose output.
   */
  filesAdded: string[];
  filesModified: string[];
  filesDeleted: string[];
}

/**
 * Make `rootDir` match `tree`. In full mode (default), the directory is treated as
 * exclusively owned: any file not in the desired tree is deleted and empty directories
 * are pruned. In partial mode (`partial: true`), only creates/updates files — no
 * deletions are performed, EXCEPT for paths explicitly listed in `dirsToDelete` (used
 * for entities that were deleted on the board). This allows the projection to write only
 * dirty entities without clobbering locally-added files (e.g. a play-function.ts added
 * by an agent that hasn't been sync-backed yet).
 */
export function writeTree(
  rootDir: string,
  tree: DesiredTree,
  opts: { partial?: boolean; dirsToDelete?: Set<string> } = {},
): WriteResult {
  const root = resolve(rootDir);
  mkdirSync(root, { recursive: true });

  const result: WriteResult = { 
    created: 0, 
    updated: 0, 
    deleted: 0, 
    unchanged: 0,
    byType: {
      chapters: 0, slices: 0, lanes: 0, elements: 0,
      milestones: 0, scenarios: 0, htmlSnippets: 0,
      contentFiles: 0, manifests: 0, stateFiles: 0, other: 0,
    },
    changedFiles: [],
    filesAdded: [],
    filesModified: [],
    filesDeleted: [],
  };

  // Track files to delete (we'll do this after processing desired files to catch renames)
  const existingFiles = new Set(listFiles(root));
  const desiredPaths = new Set<string>();

  // Desired absolute paths, validated to stay within root.
  // sync-state.json is managed separately by the projection (not by the renderer),
  // so we must preserve it rather than let writeTree delete it as an "unknown" file.
  const PRESERVED_FILES = new Set(["sync-state.json"]);

  const desired = new Map<string, string>();
  for (const [rel, content] of tree) {
    const abs = resolve(root, rel);
    if (!isInside(root, abs)) {
      // Defensive: skip anything that would escape the owned directory.
      continue;
    }
    desired.set(abs, content);
    desiredPaths.add(abs);
    existingFiles.delete(abs); // This file is in the tree, don't delete it
  }

  // Also preserve special meta-files that are not in the rendered tree.
  for (const name of PRESERVED_FILES) {
    const abs = resolve(root, name);
    existingFiles.delete(abs);
  }

  // In partial mode, skip the bulk deletion pass. We only write/update the specific
  // entity files that changed — we never want to delete files that weren't included in
  // the partial tree, because those may be locally-added files (e.g. a play-function.ts
  // added by an agent that hasn't been sync-backed yet).
  const deletionCandidates: Set<string> = opts.partial ? new Set() : existingFiles;

  // 1a. Delete files on disk that are not desired (full mode only).
  for (const abs of deletionCandidates) {
    rmSync(abs, { force: true });
    result.deleted++;
    result.byType.other++;
    result.filesDeleted.push(relative(root, abs));
  }

  // 1b. Explicit deletes for entities removed on the board (used in partial mode).
  // dirsToDelete contains relative paths — either a directory (uuid-keyed entities like
  // chapters, milestones) or individual files (flat entities like html-snippets).
  if (opts.dirsToDelete) {
    for (const rel of opts.dirsToDelete) {
      const abs = resolve(root, rel);
      if (!isInside(root, abs)) continue;
      try {
        removePreservingProtectedDirs(abs);
        result.deleted++;
        result.byType.other++;
        result.filesDeleted.push(rel);
      } catch { /* already gone — ignore */ }
    }
  }

  // 2. Create/update desired files (diff-based).
  for (const [abs, content] of desired) {
    const rel = relative(root, abs);

    const existing = readIfExists(abs);
    if (existing === content) {
      result.unchanged++;
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    
    if (existing === undefined) {
      result.created++;
      result.changedFiles.push(rel);
      result.filesAdded.push(rel);
      trackChangeByType(result.byType, rel);
    } else {
      result.updated++;
      result.changedFiles.push(rel);
      result.filesModified.push(rel);
      trackChangeByType(result.byType, rel);
    }
  }

  // 3. Prune empty directories (bottom-up), but keep root itself.
  pruneEmptyDirs(root, root);

  return result;
}

/** Categorize a file path into its type for the breakdown. */
function trackChangeByType(byType: ChangeBreakdown, relPath: string): void {
  // Sync files (special case - these are meta-files, not model files)
  if (relPath === "sync-state.json" || relPath === "sync-manifest.json" || relPath === "sync-back-ids.json") {
    byType.manifests++;
    return;
  }
  if (relPath.startsWith("sync-state.json") || relPath.includes("/sync-state.json")) {
    byType.stateFiles++;
    return;
  }

  // Check for content files
  const contentFilePatterns = [
    /description\.md$/,
    /details\.md$/,
    /play-function\.ts$/,
    /play-type\.ts$/,
  ];
  if (contentFilePatterns.some(p => p.test(relPath))) {
    byType.contentFiles++;
    return;
  }

  // Check for entity JSON files
  if (relPath.includes("/chapter.json")) {
    byType.chapters++;
  } else if (relPath.includes("/slice.json")) {
    byType.slices++;
  } else if (relPath.includes("/lane.json")) {
    byType.lanes++;
  } else if (relPath.includes("/element.json")) {
    byType.elements++;
  } else if (relPath.includes("/milestone.json")) {
    byType.milestones++;
  } else if (relPath.includes("/scenario.json")) {
    byType.scenarios++;
  } else if (relPath.startsWith("html-snippets/") && relPath.endsWith(".json")) {
    byType.htmlSnippets++;
  } else {
    byType.other++;
  }
}

/** Recursively collect all file paths under `dir` (absolute), skipping protected dirs. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isProtectedDir(entry.name)) continue;
      out.push(...listFiles(abs));
    } else if (entry.isFile()) {
      out.push(abs);
    }
    // symlinks and other special files are ignored (owned dir should contain none)
  }
  return out;
}

/** Remove empty directories under `dir`, bottom-up. Never removes `keep` (the root)
 *  or any protected directory (a `.git` also keeps its parents from looking empty). */
function pruneEmptyDirs(dir: string, keep: string): boolean {
  let empty = true;
  if (!existsSync(dir)) return true;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isProtectedDir(entry.name)) {
        empty = false;
        continue;
      }
      const childEmpty = pruneEmptyDirs(abs, keep);
      if (childEmpty) {
        rmSync(abs, { recursive: true, force: true });
      } else {
        empty = false;
      }
    } else {
      empty = false;
    }
  }
  return empty && dir !== keep;
}

/**
 * Remove `abs` (a file or directory), never touching protected directories inside
 * it. Returns `true` when nothing of `abs` remains; when a `.git` survives, the
 * directory chain leading to it is kept so the repo is left intact.
 */
function removePreservingProtectedDirs(abs: string): boolean {
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    return true; // already gone
  }
  if (!isDir) {
    rmSync(abs, { force: true });
    return true;
  }
  let empty = true;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = join(abs, entry.name);
    if (entry.isDirectory() && isProtectedDir(entry.name)) {
      empty = false;
      continue;
    }
    if (!removePreservingProtectedDirs(child)) empty = false;
  }
  if (empty) rmSync(abs, { recursive: true, force: true });
  return empty;
}

export function readIfExists(abs: string): string | undefined {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

/** True if `abs` is `root` or inside it (no escape via `..`). */
function isInside(root: string, abs: string): boolean {
  if (abs === root) return true;
  const rel = relative(root, abs);
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
}
