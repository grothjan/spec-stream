import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateModel } from "./validate.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  const dir = join(tmpdir(), `spec-stream-validate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(root: string, relPath: string, data: unknown): void {
  const abs = join(root, relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, JSON.stringify(data, null, 2), "utf8");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("validateModel", () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("reports no issues for a valid model with uuid-index", () => {
    const laneId   = "lane-uuid-1";
    const sliceId  = "slice-uuid-1";
    const elemId   = "elem-uuid-1";
    const chapterId = "chapter-uuid-1";

    writeJson(root, "uuid-index.json", {
      [laneId]:    "chapters/App/Ch/slices/0001_S/lanes/system/MyLane",
      [sliceId]:   "chapters/App/Ch/slices/0001_S",
      [elemId]:    "chapters/App/Ch/slices/0001_S/lanes/system/MyLane/elements/0001_E",
      [chapterId]: "chapters/App/Ch",
    });
    writeJson(root, "chapters/App/Ch/chapter.json", { id: chapterId, name: "My Chapter", context: "App" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: sliceId, label: "My Slice" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/MyLane/lane.json", { id: laneId, label: "My Lane", type: "system" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/MyLane/elements/0001_E/element.json", {
      id: elemId, name: "My Element", type: "command", laneId, sliceId,
    });

    const result = validateModel({ syncRootAbs: root });
    expect(result.issues).toHaveLength(0);
  });

  it("flags element.json laneId that is not in uuid-index and not in any local json", () => {
    const sliceId = "slice-uuid-1";
    writeJson(root, "uuid-index.json", { [sliceId]: "chapters/App/Ch/slices/0001_S" });
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "chap-1", name: "Ch", context: "App" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: sliceId, label: "S" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L/lane.json", { id: "lane-not-in-index", label: "L", type: "system" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E/element.json", {
      id: "elem-1", name: "E", type: "command",
      laneId: "completely-unknown-lane-id",  // not in index, not in any local json
      sliceId,
    });

    const result = validateModel({ syncRootAbs: root });
    const laneIssue = result.issues.find((i) => i.message.includes("laneId") && i.message.includes("completely-unknown-lane-id"));
    expect(laneIssue).toBeDefined();
  });

  it("does NOT flag element.json laneId that is locally present in a lane.json even if not in uuid-index", () => {
    // Agent-authored model: lane has an id, element references it, but uuid-index
    // doesn't have it yet because sync-back hasn't run.
    const localLaneId  = "local-lane-uuid";
    const localSliceId = "local-slice-uuid";

    writeJson(root, "uuid-index.json", {}); // empty — nothing synced yet
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "local-chapter-uuid", name: "Ch", context: "App" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: localSliceId, label: "S" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L/lane.json", { id: localLaneId, label: "L", type: "system" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E/element.json", {
      id: "local-elem-uuid", name: "E", type: "command", laneId: localLaneId, sliceId: localSliceId,
    });

    const result = validateModel({ syncRootAbs: root });
    const refIssues = result.issues.filter((i) => i.message.includes("not found in uuid-index"));
    expect(refIssues).toHaveLength(0);
  });

  it("does NOT flag scenario expectation sliceId/elementId that are locally present", () => {
    const localSliceId = "local-slice-uuid";
    const localElemId  = "local-elem-uuid";

    writeJson(root, "uuid-index.json", {});
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "local-chap-uuid", name: "Ch", context: "App" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: localSliceId, label: "S" });
    writeJson(root, "chapters/App/Ch/scenarios/My-Scenario/scenario.json", {
      id: "local-scenario-uuid",
      chapterId: "local-chap-uuid",
      name: "My Scenario",
      expectations: [
        {
          id: "exp-1",
          kind: "information",
          sliceId: localSliceId,
          elementId: localElemId,
          expected: {},
        },
      ],
    });
    // Write element.json so localElemId is a known local id
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L/lane.json", { id: "local-lane-uuid", label: "L", type: "system" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E/element.json", {
      id: localElemId, name: "E", type: "event",
      laneId: "local-lane-uuid", sliceId: localSliceId,
    });

    const result = validateModel({ syncRootAbs: root });
    const refIssues = result.issues.filter((i) => i.message.includes("not found in uuid-index"));
    expect(refIssues).toHaveLength(0);
  });

  it("still flags scenario expectation sliceId that is truly unknown (not local either)", () => {
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "chap-1", name: "Ch", context: "App" });
    writeJson(root, "chapters/App/Ch/scenarios/S/scenario.json", {
      id: "scenario-1",
      chapterId: "chap-1",
      name: "S",
      expectations: [
        { id: "exp-1", kind: "events", sliceId: "totally-unknown-slice-uuid", expected: {} },
      ],
    });

    const result = validateModel({ syncRootAbs: root });
    const issue = result.issues.find((i) => i.message.includes("totally-unknown-slice-uuid"));
    expect(issue).toBeDefined();
  });

  it("flags missing required fields in chapter.json", () => {
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "chapters/App/Ch/chapter.json", { name: "Ch" }); // missing id and context

    const result = validateModel({ syncRootAbs: root });
    const chapterIssues = result.issues.filter((i) => i.path.includes("chapter.json"));
    expect(chapterIssues.some((i) => i.message.includes('"id"'))).toBe(true);
    expect(chapterIssues.some((i) => i.message.includes('"context"'))).toBe(true);
  });

  it("flags missing context in chapter.json", () => {
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "chap-1", name: "Ch" }); // missing context

    const result = validateModel({ syncRootAbs: root });
    const contextIssue = result.issues.find(
      (i) => i.path.includes("chapter.json") && i.message.includes('"context"'),
    );
    expect(contextIssue).toBeDefined();
  });

  it("does not flag chapter.json when context is present", () => {
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "chap-1", name: "Ch", context: "App" });

    const result = validateModel({ syncRootAbs: root });
    const chapterIssues = result.issues.filter((i) => i.path.includes("chapter.json"));
    expect(chapterIssues).toHaveLength(0);
  });

  it("flags missing required fields in element.json", () => {
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "c1", name: "Ch", context: "App" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E/element.json", {
      id: "e1",
      // missing name, type, laneId, sliceId
    });

    const result = validateModel({ syncRootAbs: root });
    const messages = result.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes('"name"'))).toBe(true);
    expect(messages.some((m) => m.includes('"type"'))).toBe(true);
    expect(messages.some((m) => m.includes('"laneId"'))).toBe(true);
    expect(messages.some((m) => m.includes('"sliceId"'))).toBe(true);
  });

  // ─── lane.json ───────────────────────────────────────────────────────────────

  it("flags missing type in lane.json", () => {
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "c1", name: "Ch", context: "App" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L/lane.json", { id: "l1", label: "L" }); // missing type

    const result = validateModel({ syncRootAbs: root });
    const issue = result.issues.find((i) => i.path.includes("lane.json") && i.message.includes('"type"'));
    expect(issue).toBeDefined();
  });

  it("flags invalid lane.json type value", () => {
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "c1", name: "Ch", context: "App" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L/lane.json", { id: "l1", label: "L", type: "robot" });

    const result = validateModel({ syncRootAbs: root });
    const issue = result.issues.find((i) => i.path.includes("lane.json") && i.message.includes('"robot"'));
    expect(issue).toBeDefined();
  });

  it("accepts all valid lane.json type values", () => {
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "c1", name: "Ch", context: "App" });
    for (const [i, type] of (["user-lane", "information-flow", "system"] as const).entries()) {
      writeJson(root, `chapters/App/Ch/slices/0001_S/lanes/${type}/L${i}/lane.json`, { id: `l${i}`, label: `L${i}`, type });
    }

    const result = validateModel({ syncRootAbs: root });
    const laneIssues = result.issues.filter((i) => i.path.includes("lane.json"));
    expect(laneIssues).toHaveLength(0);
  });

  // ─── element.json type enum ──────────────────────────────────────────────────

  it("flags invalid element.json type value", () => {
    const laneId = "l1";
    const sliceId = "s1";
    writeJson(root, "uuid-index.json", { [laneId]: "chapters/App/Ch/slices/0001_S/lanes/system/L", [sliceId]: "chapters/App/Ch/slices/0001_S" });
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "c1", name: "Ch", context: "App" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E/element.json", {
      id: "e1", name: "E", type: "widget", laneId, sliceId,
    });

    const result = validateModel({ syncRootAbs: root });
    const issue = result.issues.find((i) => i.path.includes("element.json") && i.message.includes('"widget"'));
    expect(issue).toBeDefined();
  });

  it("accepts all valid element.json type values", () => {
    const laneId = "l1";
    const sliceId = "s1";
    writeJson(root, "uuid-index.json", {
      [laneId]: "chapters/App/Ch/slices/0001_S/lanes/system/L",
      [sliceId]: "chapters/App/Ch/slices/0001_S",
    });
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "c1", name: "Ch", context: "App" });
    for (const [i, type] of (["command", "event", "information", "ui", "automation", "hotspot"] as const).entries()) {
      writeJson(root, `chapters/App/Ch/slices/0001_S/lanes/system/L/elements/${String(i).padStart(4, "0")}_E/element.json`, {
        id: `e${i}`, name: `E${i}`, type, laneId, sliceId,
      });
    }

    const result = validateModel({ syncRootAbs: root });
    const elemIssues = result.issues.filter((i) => i.path.includes("element.json"));
    expect(elemIssues).toHaveLength(0);
  });

  // ─── slice.json status enum ──────────────────────────────────────────────────

  it("flags invalid slice.json status value", () => {
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "c1", name: "Ch", context: "App" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: "s1", label: "S", status: "finished" });

    const result = validateModel({ syncRootAbs: root });
    const issue = result.issues.find((i) => i.path.includes("slice.json") && i.message.includes('"finished"'));
    expect(issue).toBeDefined();
  });

  it("does not flag slice.json when status is absent", () => {
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "c1", name: "Ch", context: "App" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: "s1", label: "S" }); // no status

    const result = validateModel({ syncRootAbs: root });
    const sliceIssues = result.issues.filter((i) => i.path.includes("slice.json"));
    expect(sliceIssues).toHaveLength(0);
  });

  it("accepts all valid slice.json status values", () => {
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "c1", name: "Ch", context: "App" });
    for (const [i, status] of (["draft", "planned", "in-progress", "blocked", "ready", "reviewed", "deployed"] as const).entries()) {
      writeJson(root, `chapters/App/Ch/slices/${String(i).padStart(4, "0")}_S${i}/slice.json`, { id: `s${i}`, label: `S${i}`, status });
    }

    const result = validateModel({ syncRootAbs: root });
    const sliceIssues = result.issues.filter((i) => i.path.includes("slice.json"));
    expect(sliceIssues).toHaveLength(0);
  });

  // ─── scenario expectation kind enum ─────────────────────────────────────────

  it("flags invalid expectation kind in scenario.json", () => {
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "c1", name: "Ch", context: "App" });
    writeJson(root, "chapters/App/Ch/scenarios/S/scenario.json", {
      id: "sc1", chapterId: "c1", name: "S",
      expectations: [
        { id: "e1", kind: "state", sliceId: "local-slice", expected: {} },
      ],
    });
    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: "local-slice", label: "S" });

    const result = validateModel({ syncRootAbs: root });
    const issue = result.issues.find((i) => i.path.includes("scenario.json") && i.message.includes('"state"'));
    expect(issue).toBeDefined();
  });

  it("accepts all valid expectation kind values in scenario.json", () => {
    const sliceId = "local-slice";
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "chapters/App/Ch/chapter.json", { id: "c1", name: "Ch", context: "App" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: sliceId, label: "S" });
    writeJson(root, "chapters/App/Ch/scenarios/S/scenario.json", {
      id: "sc1", chapterId: "c1", name: "S",
      expectations: [
        { id: "e1", kind: "events",      sliceId, expected: {} },
        { id: "e2", kind: "information", sliceId, expected: {} },
        { id: "e3", kind: "rejection",   sliceId, expected: {} },
      ],
    });

    const result = validateModel({ syncRootAbs: root });
    const kindIssues = result.issues.filter((i) => i.path.includes("scenario.json") && i.message.includes('"kind"'));
    expect(kindIssues).toHaveLength(0);
  });

  // ─── html-snippet .json ──────────────────────────────────────────────────────

  it("flags missing name in html-snippet json", () => {
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "html-snippets/my-snippet.json", { slug: "my-snippet" }); // missing name

    const result = validateModel({ syncRootAbs: root });
    const issue = result.issues.find((i) => i.path.includes("html-snippets") && i.message.includes('"name"'));
    expect(issue).toBeDefined();
  });

  it("does not flag html-snippet json when name is present", () => {
    writeJson(root, "uuid-index.json", {});
    writeJson(root, "html-snippets/my-snippet.json", { slug: "my-snippet", name: "My Snippet" });

    const result = validateModel({ syncRootAbs: root });
    const snippetIssues = result.issues.filter((i) => i.path.includes("html-snippets"));
    expect(snippetIssues).toHaveLength(0);
  });
});
