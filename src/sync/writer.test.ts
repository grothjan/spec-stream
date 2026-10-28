import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTree } from "./writer.js";
import type { DesiredTree } from "./render.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spec-stream-writer-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function tree(entries: Record<string, string>): DesiredTree {
  return new Map(Object.entries(entries));
}

describe("writeTree", () => {
  it("creates files and nested directories", () => {
    const r = writeTree(root, tree({ "a/b/c.json": "{}\n", "a/d.md": "hi\n" }));
    expect(r.created).toBe(2);
    expect(existsSync(join(root, "a/b/c.json"))).toBe(true);
    expect(readFileSync(join(root, "a/d.md"), "utf8")).toBe("hi\n");
  });

  it("is diff-based: unchanged files are not counted as updates", () => {
    writeTree(root, tree({ "x.json": "1\n" }));
    const r = writeTree(root, tree({ "x.json": "1\n" }));
    expect(r.unchanged).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.created).toBe(0);
  });

  it("updates changed content", () => {
    writeTree(root, tree({ "x.json": "1\n" }));
    const r = writeTree(root, tree({ "x.json": "2\n" }));
    expect(r.updated).toBe(1);
    expect(readFileSync(join(root, "x.json"), "utf8")).toBe("2\n");
  });

  it("deletes files not in the desired tree (exclusive ownership)", () => {
    writeTree(root, tree({ "keep.md": "k\n", "drop.md": "d\n" }));
    const r = writeTree(root, tree({ "keep.md": "k\n" }));
    expect(r.deleted).toBe(1);
    expect(existsSync(join(root, "drop.md"))).toBe(false);
    expect(existsSync(join(root, "keep.md"))).toBe(true);
  });

  it("deletes stray files placed by someone else", () => {
    writeTree(root, tree({ "model/a.json": "{}\n" }));
    writeFileSync(join(root, "model", "stray.txt"), "nope");
    const r = writeTree(root, tree({ "model/a.json": "{}\n" }));
    expect(existsSync(join(root, "model", "stray.txt"))).toBe(false);
    expect(r.deleted).toBe(1);
  });

  it("prunes directories left empty after deletion", () => {
    writeTree(root, tree({ "deep/nested/file.md": "x\n" }));
    expect(existsSync(join(root, "deep/nested"))).toBe(true);
    writeTree(root, tree({ "other.md": "y\n" }));
    expect(existsSync(join(root, "deep"))).toBe(false);
    expect(existsSync(join(root, "deep/nested"))).toBe(false);
  });

  it("keeps the root directory even when the tree is empty", () => {
    writeTree(root, tree({ "a.md": "x\n" }));
    writeTree(root, tree({}));
    expect(existsSync(root)).toBe(true);
  });

  it("models a rename as delete-old + create-new", () => {
    writeTree(root, tree({ "slices/0000_s1_Old/slice.json": "{}\n" }));
    const r = writeTree(root, tree({ "slices/0000_s1_New/slice.json": "{}\n" }));
    expect(existsSync(join(root, "slices/0000_s1_Old"))).toBe(false);
    expect(existsSync(join(root, "slices/0000_s1_New/slice.json"))).toBe(true);
    expect(r.deleted).toBe(1);
    expect(r.created).toBe(1);
  });

  it("refuses to write outside the root via path traversal", () => {
    writeTree(root, tree({ "../escape.md": "nope\n", "safe.md": "ok\n" }));
    expect(existsSync(join(root, "safe.md"))).toBe(true);
    expect(existsSync(join(root, "..", "escape.md"))).toBe(false);
  });

  it("creates the root dir if it does not exist", () => {
    const nested = join(root, "does", "not", "exist");
    writeTree(nested, tree({ "a.md": "x\n" }));
    expect(existsSync(join(nested, "a.md"))).toBe(true);
  });

  it("full mirror: converges to exactly the desired set", () => {
    writeTree(root, tree({ "a.md": "1\n", "b/c.md": "2\n", "b/d.md": "3\n" }));
    writeTree(root, tree({ "a.md": "1\n", "b/c.md": "9\n", "e.md": "5\n" }));
    // b/d.md gone, b/c.md updated, e.md created, a.md unchanged
    expect(existsSync(join(root, "b/d.md"))).toBe(false);
    expect(readFileSync(join(root, "b/c.md"), "utf8")).toBe("9\n");
    expect(existsSync(join(root, "e.md"))).toBe(true);
  });

  // ── Regression tests for proophboard/spec-stream#6 ──────────────────────────
  // The exclusive-ownership sweep used to delete *everything* under rootDir —
  // including `.git` directories (user repos at the mirror root, and the history
  // repo `localSync.git` creates for itself) — and reported them only as a bare
  // `deleted` count with no file names.

  it("never touches .git directories anywhere under the root", () => {
    writeTree(root, tree({ "model/a.json": "{}\n" }));
    // A repo at the mirror root (user's own repo, or the localSync.git history repo).
    mkdirSync(join(root, ".git", "objects", "ab"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".git", "objects", "ab", "cd"), "blob");
    // A nested repo inside a model-managed directory.
    mkdirSync(join(root, "model", ".git"), { recursive: true });
    writeFileSync(join(root, "model", ".git", "HEAD"), "x");

    const r = writeTree(root, tree({ "model/a.json": "{}\n" }));

    expect(existsSync(join(root, ".git", "HEAD"))).toBe(true);
    expect(existsSync(join(root, ".git", "objects", "ab", "cd"))).toBe(true);
    expect(existsSync(join(root, "model", ".git", "HEAD"))).toBe(true);
    expect(r.deleted).toBe(0);
  });

  it("preserves .git inside an explicitly deleted directory (partial mode)", () => {
    writeTree(root, tree({ "chapters/c1/chapter.json": "{}\n" }));
    mkdirSync(join(root, "chapters", "c1", ".git"), { recursive: true });
    writeFileSync(join(root, "chapters", "c1", ".git", "HEAD"), "x");

    writeTree(root, tree({}), { partial: true, dirsToDelete: new Set(["chapters/c1"]) });

    // The entity's files are gone, but the repo inside must survive.
    expect(existsSync(join(root, "chapters", "c1", "chapter.json"))).toBe(false);
    expect(existsSync(join(root, "chapters", "c1", ".git", "HEAD"))).toBe(true);
  });

  it("names every swept file in filesDeleted so deletions are not silent", () => {
    writeTree(root, tree({ "keep.md": "k\n" }));
    writeFileSync(join(root, "stray.txt"), "nope");
    writeFileSync(join(root, ".env"), "SECRET=1");
    mkdirSync(join(root, "scratch"), { recursive: true });
    writeFileSync(join(root, "scratch", "a.txt"), "x");

    const r = writeTree(root, tree({ "keep.md": "k\n" }));

    expect(r.deleted).toBe(3);
    expect(r.filesDeleted).toEqual(
      expect.arrayContaining(["stray.txt", ".env", join("scratch", "a.txt")]),
    );
  });

  it("names explicitly deleted paths in filesDeleted (partial mode)", () => {
    writeTree(root, tree({ "chapters/c1/chapter.json": "{}\n", "chapters/c1/index.md": "i\n" }));
    const r = writeTree(root, tree({}), { partial: true, dirsToDelete: new Set(["chapters/c1"]) });
    expect(r.filesDeleted).toContain("chapters/c1");
  });
});
