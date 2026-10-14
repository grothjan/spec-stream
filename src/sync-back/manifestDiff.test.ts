import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeManifestDiff, computeDiskHash } from "./manifestDiff.js";
import { saveManifest, syncManifestPath, syncBackIdsPath, type SyncManifest } from "./manifest.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  const dir = join(tmpdir(), `spec-stream-manifestdiff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  // model dir is one level below the .spec-stream dir
  mkdirSync(join(dir, "model"), { recursive: true });
  return join(dir, "model");
}

function writeJson(root: string, relPath: string, data: unknown): void {
  const abs = join(root, relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, JSON.stringify(data, null, 2), "utf8");
}

function writeManifest(root: string, entities: Record<string, { id: string; hash?: string }>): void {
  const manifest: SyncManifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entities,
  };
  saveManifest(syncManifestPath(root), manifest);
}

const CHAPTER_ID  = "chapter-uuid-1";
const SLICE_ID    = "slice-uuid-1";
const LANE_ID     = "lane-uuid-1";
const ELEMENT_ID  = "element-uuid-1";
const MILESTONE_ID = "milestone-uuid-1";

const CHAPTER_DIR  = `chapters/${CHAPTER_ID}`;
const SLICE_DIR    = `${CHAPTER_DIR}/slices/${SLICE_ID}`;
const LANE_DIR     = `${CHAPTER_DIR}/lanes/${LANE_ID}`;
const ELEMENT_DIR  = `${CHAPTER_DIR}/elements/${ELEMENT_ID}`;
const MILESTONE_DIR = "milestones/My-Milestone";

function writeFullModel(root: string): void {
  writeJson(root, `${CHAPTER_DIR}/chapter.json`,   { id: CHAPTER_ID,  name: "My Chapter",  context: "App" });
  writeJson(root, `${SLICE_DIR}/slice.json`,        { id: SLICE_ID,    label: "My Slice" });
  writeJson(root, `${LANE_DIR}/lane.json`,          { id: LANE_ID,     label: "My Lane", type: "information-flow" });
  writeJson(root, `${ELEMENT_DIR}/element.json`,    { id: ELEMENT_ID,  name: "My Element", type: "command", laneId: LANE_ID, sliceId: SLICE_ID });
  writeJson(root, `${MILESTONE_DIR}/milestone.json`,{ id: MILESTONE_ID, name: "My Milestone" });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("computeManifestDiff", () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(join(root, ".."), { recursive: true, force: true }); });

  it("returns creates for all entities when no manifest exists", () => {
    writeFullModel(root);
    const diffs = computeManifestDiff({ syncRootAbs: root });
    expect(diffs.length).toBeGreaterThanOrEqual(5);
    expect(diffs.every((d) => d.status === "create")).toBe(true);
  });

  it("returns updates for entities present in manifest and on disk", () => {
    writeFullModel(root);
    writeManifest(root, {
      [CHAPTER_DIR]:   { id: CHAPTER_ID },
      [SLICE_DIR]:     { id: SLICE_ID },
      [LANE_DIR]:      { id: LANE_ID },
      [ELEMENT_DIR]:   { id: ELEMENT_ID },
      [MILESTONE_DIR]: { id: MILESTONE_ID },
    });
    const diffs = computeManifestDiff({ syncRootAbs: root });
    expect(diffs.every((d) => d.status === "update")).toBe(true);
    expect(diffs.find((d) => d.entityDir === ELEMENT_DIR)).toMatchObject({
      status: "update", entityDir: ELEMENT_DIR, kind: "element", id: ELEMENT_ID,
    });
  });

  it("returns delete for entities in manifest but missing from disk", () => {
    writeFullModel(root);
    writeManifest(root, {
      [CHAPTER_DIR]:   { id: CHAPTER_ID },
      [SLICE_DIR]:     { id: SLICE_ID },
      [LANE_DIR]:      { id: LANE_ID },
      [ELEMENT_DIR]:   { id: ELEMENT_ID },
      [MILESTONE_DIR]: { id: MILESTONE_ID },
      // Extra entry in manifest that has no corresponding dir on disk:
      [`${CHAPTER_DIR}/elements/old-element-uuid`]: { id: "old-element-uuid" },
    });
    const diffs = computeManifestDiff({ syncRootAbs: root });
    const deletes = diffs.filter((d) => d.status === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({
      status: "delete",
      kind: "element",
      id: "old-element-uuid",
    });
  });

  it("detects rename when same id appears under a different dir", () => {
    // On disk: element exists under NEW_DIR (id = ELEMENT_ID)
    // Manifest: element was under OLD_DIR (same id)
    const OLD_DIR = `${CHAPTER_DIR}/elements/old-element-uuid`;
    const NEW_DIR = `${CHAPTER_DIR}/elements/new-element-uuid`;

    writeJson(root, `${CHAPTER_DIR}/chapter.json`,   { id: CHAPTER_ID,  name: "My Chapter", context: "App" });
    writeJson(root, `${SLICE_DIR}/slice.json`,        { id: SLICE_ID,    label: "My Slice" });
    writeJson(root, `${LANE_DIR}/lane.json`,          { id: LANE_ID,     label: "My Lane", type: "information-flow" });
    writeJson(root, `${NEW_DIR}/element.json`,        { id: ELEMENT_ID,  name: "New Name", type: "command", laneId: LANE_ID, sliceId: SLICE_ID });

    writeManifest(root, {
      [CHAPTER_DIR]: { id: CHAPTER_ID },
      [SLICE_DIR]:   { id: SLICE_ID },
      [LANE_DIR]:    { id: LANE_ID },
      [OLD_DIR]:     { id: ELEMENT_ID },   // old location in manifest
    });

    const diffs = computeManifestDiff({ syncRootAbs: root });
    const renames = diffs.filter((d) => d.status === "rename");
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({
      status: "rename",
      entityDir: NEW_DIR,
      kind: "element",
      id: ELEMENT_ID,
      oldEntityDir: OLD_DIR,
    });
    // OLD_DIR should not also appear as a delete
    const deletes = diffs.filter((d) => d.status === "delete");
    expect(deletes.some((d) => d.entityDir === OLD_DIR)).toBe(false);
  });

  it("treats entity with id already in sync-back-ids as update not create", () => {
    // Simulates: sync-back created an entity, wrote its id to sync-back-ids.json,
    // but sync has not yet processed the board event. Without sync-back-ids, the
    // next run would see the dir not in sync-manifest and emit a spurious create.
    writeFullModel(root);

    // sync-manifest is empty (sync hasn't run yet)
    writeManifest(root, {});

    // sync-back-ids has the ids from the last run
    const backIds: SyncManifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        [ELEMENT_DIR]: { id: ELEMENT_ID },
      },
    };
    saveManifest(syncBackIdsPath(root), backIds);

    const diffs = computeManifestDiff({ syncRootAbs: root });
    const elementDiff = diffs.find((d) => d.entityDir === ELEMENT_DIR);
    // With id in sync-back-ids the dir is "known" → update, not create
    expect(elementDiff?.status).toBe("update");
    expect(diffs.filter((d) => d.status === "create" && d.entityDir === ELEMENT_DIR)).toHaveLength(0);
  });

  it("returns empty array when model dir is empty and manifest is empty", () => {
    const diffs = computeManifestDiff({ syncRootAbs: root });
    expect(diffs).toHaveLength(0);
  });

  it("skips entities whose disk hash matches the manifest hash (unchanged content)", () => {
    writeFullModel(root);
    // Compute the hash the same way manifestDiff does — then store it in the manifest.
    const elemHash = computeDiskHash(root, ELEMENT_DIR, "element");
    writeManifest(root, {
      [CHAPTER_DIR]:   { id: CHAPTER_ID },
      [SLICE_DIR]:     { id: SLICE_ID },
      [LANE_DIR]:      { id: LANE_ID },
      [ELEMENT_DIR]:   { id: ELEMENT_ID, hash: elemHash },
      [MILESTONE_DIR]: { id: MILESTONE_ID },
    });
    const diffs = computeManifestDiff({ syncRootAbs: root });
    // The element with a matching hash should be skipped.
    expect(diffs.find((d) => d.entityDir === ELEMENT_DIR)).toBeUndefined();
    // Entities with no hash in the manifest should still appear as updates.
    expect(diffs.find((d) => d.entityDir === CHAPTER_DIR)).toMatchObject({ status: "update" });
  });

  it("returns update for entities whose disk hash differs from the manifest hash", () => {
    writeFullModel(root);
    // Write a stale hash that won't match the current disk content.
    writeManifest(root, {
      [ELEMENT_DIR]: { id: ELEMENT_ID, hash: "00000000" }, // wrong hash
    });
    const diffs = computeManifestDiff({ syncRootAbs: root });
    const elementDiff = diffs.find((d) => d.entityDir === ELEMENT_DIR);
    expect(elementDiff?.status).toBe("update");
  });

  it("does NOT emit a spurious delete when sync renames a directory that sync-back had recorded under the old name", () => {
    // Reproduces the bug described in the issue:
    //
    // 1. Agent edits element.json: changes `name` field (directory is still OLD_DIR).
    // 2. sync-back run #1: detects UPDATE, calls element.rename API, writes to
    //    sync-back-ids.json under OLD_DIR.
    // 3. Local sync processes the element-renamed event from the board, renames the
    //    directory to NEW_DIR, and updates sync-manifest.json to use NEW_DIR as key.
    // 4. sync-back run #2 should NOT emit a delete for OLD_DIR.

    const OLD_ELEMENT_DIR = `${CHAPTER_DIR}/elements/old-lead-created-uuid`;
    const NEW_ELEMENT_DIR = `${CHAPTER_DIR}/elements/new-lead-registered-uuid`;

    // State after step 3: disk has NEW_DIR, sync-manifest has NEW_DIR.
    writeJson(root, `${CHAPTER_DIR}/chapter.json`,     { id: CHAPTER_ID, name: "My Chapter", context: "App" });
    writeJson(root, `${SLICE_DIR}/slice.json`,          { id: SLICE_ID,   label: "My Slice" });
    writeJson(root, `${LANE_DIR}/lane.json`,            { id: LANE_ID,    label: "My Lane", type: "information-flow" });
    writeJson(root, `${NEW_ELEMENT_DIR}/element.json`,  { id: ELEMENT_ID, name: "Lead Registered", type: "event", laneId: LANE_ID, sliceId: SLICE_ID });

    // sync-manifest.json (written by sync): tracks the NEW directory.
    writeManifest(root, {
      [CHAPTER_DIR]:     { id: CHAPTER_ID },
      [SLICE_DIR]:       { id: SLICE_ID },
      [LANE_DIR]:        { id: LANE_ID },
      [NEW_ELEMENT_DIR]: { id: ELEMENT_ID },
    });

    // sync-back-ids.json (written by sync-back run #1): still has the OLD directory.
    const backIds: SyncManifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        [OLD_ELEMENT_DIR]: { id: ELEMENT_ID, hash: "oldhash" },
      },
    };
    saveManifest(syncBackIdsPath(root), backIds);

    const diffs = computeManifestDiff({ syncRootAbs: root });

    // The OLD_DIR must NOT appear as a delete.
    const deletes = diffs.filter((d) => d.status === "delete");
    expect(deletes.some((d) => d.entityDir === OLD_ELEMENT_DIR)).toBe(false);

    // The element should appear as an update (or be skipped if hash matches) under NEW_DIR.
    const elementDiff = diffs.find((d) => d.entityDir === NEW_ELEMENT_DIR);
    expect(elementDiff).toBeDefined();
    expect(elementDiff?.status).not.toBe("delete");
    expect(elementDiff?.id).toBe(ELEMENT_ID);
  });

  it("does NOT emit a delete for an entity that was deleted externally (sync removed it from sync-manifest and disk)", async () => {
    // Scenario: an entity (e.g. scenario, element) was deleted on the board.
    // sync processed the deletion event → removed the local file AND removed the
    // entry from sync-manifest.json. But sync-back-ids.json still holds the old
    // entry (written by a previous sync-back create). On the next sync-back run
    // the entry appears in the merged manifest but not on disk and not in
    // sync-manifest — this must NOT produce a delete operation.

    const SCENARIO_ID  = "scenario-uuid-deleted";
    const SCENARIO_DIR = `${CHAPTER_DIR}/scenarios/Deleted-Scenario`;

    writeJson(root, `${CHAPTER_DIR}/chapter.json`, { id: CHAPTER_ID, name: "My Chapter", context: "App" });

    // sync-manifest.json: the scenario is GONE (sync already processed the deletion).
    writeManifest(root, {
      [CHAPTER_DIR]: { id: CHAPTER_ID },
    });

    // sync-back-ids.json: still has the scenario from a previous create run.
    const backIds: SyncManifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        [SCENARIO_DIR]: { id: SCENARIO_ID, hash: "oldhash" },
      },
    };
    saveManifest(syncBackIdsPath(root), backIds);

    // Disk: no scenario.json — sync already deleted it.

    const diffs = computeManifestDiff({ syncRootAbs: root });

    const deletes = diffs.filter((d) => d.status === "delete");
    expect(deletes.some((d) => d.entityDir === SCENARIO_DIR)).toBe(false);
    expect(deletes.some((d) => d.id === SCENARIO_ID)).toBe(false);
  });
});
