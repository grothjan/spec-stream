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

  // ─── chapterOrder validation ─────────────────────────────────────────────────

  it("flags slice in chapter folder that is not listed in chapter.json sliceOrder", () => {
    const sliceId1 = "slice-1";
    const sliceId2 = "slice-2";
    const laneId   = "lane-1";
    const elemId   = "elem-1";
    const chapterId = "chapter-1";

    // Create uuid-index with chapter
    writeJson(root, "uuid-index.json", {
      [chapterId]: "chapters/App/Ch",
      [sliceId1]:  "chapters/App/Ch/slices/0001_S",
      [sliceId2]:  "chapters/App/Ch/slices/0002_S",
      [laneId]:    "chapters/App/Ch/slices/0001_S/lanes/system/L1",
      [elemId]:    "chapters/App/Ch/slices/0001_S/lanes/system/L1/elements/0001_E",
    });

    // chapter.json only references slice-1 in sliceOrder
    writeJson(root, "chapters/App/Ch/chapter.json", {
      id: chapterId, name: "Ch", context: "App",
      sliceOrder: [sliceId1],  // missing slice-2
      laneOrder: [laneId],
    });

    // But folder has both slices
    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: sliceId1, label: "S1" });
    writeJson(root, "chapters/App/Ch/slices/0002_S/slice.json", { id: sliceId2, label: "S2" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L1/lane.json", { id: laneId, label: "L1", type: "system" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L1/elements/0001_E/element.json", {
      id: elemId, name: "E1", type: "command", laneId, sliceId: sliceId1,
    });

    const result = validateModel({ syncRootAbs: root });
    const issue = result.issues.find((i) => i.path.includes("chapter.json") && i.message.includes("slice-2"));
    expect(issue).toBeDefined();
    expect(issue?.message).toBe("Slice \"slice-2\" in chapter folder is not listed in sliceOrder");
  });

  it("flags lane in chapter folder that is not listed in chapter.json laneOrder", () => {
    const sliceId = "slice-1";
    const laneId1 = "lane-1";
    const laneId2 = "lane-2";
    const elemId  = "elem-1";
    const chapterId = "chapter-1";

    writeJson(root, "uuid-index.json", {
      [chapterId]: "chapters/App/Ch",
      [sliceId]:   "chapters/App/Ch/slices/0001_S",
      [laneId1]:   "chapters/App/Ch/slices/0001_S/lanes/system/L1",
      [laneId2]:   "chapters/App/Ch/slices/0001_S/lanes/system/L2",
      [elemId]:    "chapters/App/Ch/slices/0001_S/lanes/system/L1/elements/0001_E",
    });

    writeJson(root, "chapters/App/Ch/chapter.json", {
      id: chapterId, name: "Ch", context: "App",
      sliceOrder: [sliceId],
      laneOrder: [laneId1],  // missing lane-2
    });

    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: sliceId, label: "S" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L1/lane.json", { id: laneId1, label: "L1", type: "system" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L2/lane.json", { id: laneId2, label: "L2", type: "system" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L1/elements/0001_E/element.json", {
      id: elemId, name: "E1", type: "command", laneId: laneId1, sliceId,
    });

    const result = validateModel({ syncRootAbs: root });
    const issue = result.issues.find((i) => i.path.includes("chapter.json") && i.message.includes("lane-2"));
    expect(issue).toBeDefined();
    expect(issue?.message).toBe("Lane \"lane-2\" in chapter folder is not listed in laneOrder");
  });

  it("flags sliceOrder entry that is not present in chapter folder", () => {
    const sliceId = "slice-1";
    const laneId  = "lane-1";
    const elemId  = "elem-1";
    const chapterId = "chapter-1";
    const missingSlice = "missing-slice";

    writeJson(root, "uuid-index.json", {
      [chapterId]:    "chapters/App/Ch",
      [sliceId]:      "chapters/App/Ch/slices/0001_S",
      [laneId]:       "chapters/App/Ch/slices/0001_S/lanes/system/L1",
      [elemId]:       "chapters/App/Ch/slices/0001_S/lanes/system/L1/elements/0001_E",
      [missingSlice]: "chapters/App/Ch/slices/0002_S",  // directory doesn't exist
    });

    writeJson(root, "chapters/App/Ch/chapter.json", {
      id: chapterId, name: "Ch", context: "App",
      sliceOrder: [sliceId, missingSlice],  // references non-existent slice
      laneOrder: [laneId],
    });

    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: sliceId, label: "S" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L1/lane.json", { id: laneId, label: "L1", type: "system" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L1/elements/0001_E/element.json", {
      id: elemId, name: "E1", type: "command", laneId, sliceId,
    });

    const result = validateModel({ syncRootAbs: root });
    const issue = result.issues.find((i) => i.path.includes("chapter.json") && i.message.includes("missing-slice"));
    expect(issue).toBeDefined();
    expect(issue?.message).toBe("sliceOrder references \"missing-slice\" which is not present in the chapter folder");
  });

  it("flags laneOrder entry that is not present in chapter folder", () => {
    const sliceId = "slice-1";
    const laneId  = "lane-1";
    const elemId  = "elem-1";
    const chapterId = "chapter-1";
    const missingLane = "missing-lane";

    writeJson(root, "uuid-index.json", {
      [chapterId]: "chapters/App/Ch",
      [sliceId]:   "chapters/App/Ch/slices/0001_S",
      [laneId]:    "chapters/App/Ch/slices/0001_S/lanes/system/L1",
      [elemId]:    "chapters/App/Ch/slices/0001_S/lanes/system/L1/elements/0001_E",
      [missingLane]: "chapters/App/Ch/slices/0001_S/lanes/system/L2",  // directory doesn't exist
    });

    writeJson(root, "chapters/App/Ch/chapter.json", {
      id: chapterId, name: "Ch", context: "App",
      sliceOrder: [sliceId],
      laneOrder: [laneId, missingLane],  // references non-existent lane
    });

    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: sliceId, label: "S" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L1/lane.json", { id: laneId, label: "L1", type: "system" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L1/elements/0001_E/element.json", {
      id: elemId, name: "E1", type: "command", laneId, sliceId,
    });

    const result = validateModel({ syncRootAbs: root });
    const issue = result.issues.find((i) => i.path.includes("chapter.json") && i.message.includes("missing-lane"));
    expect(issue).toBeDefined();
    expect(issue?.message).toBe("laneOrder references \"missing-lane\" which is not present in the chapter folder");
  });

  it("flags element with sliceId not listed in chapter.json sliceOrder", () => {
    const sliceId1 = "slice-1";
    const sliceId2 = "slice-2";  // not in sliceOrder
    const laneId   = "lane-1";
    const elemId   = "elem-1";
    const chapterId = "chapter-1";

    writeJson(root, "uuid-index.json", {
      [chapterId]: "chapters/App/Ch",
      [sliceId1]:  "chapters/App/Ch/slices/0001_S",
      [sliceId2]:  "chapters/App/Ch/slices/0002_S",
      [laneId]:    "chapters/App/Ch/slices/0001_S/lanes/system/L1",
      [elemId]:    "chapters/App/Ch/slices/0001_S/lanes/system/L1/elements/0001_E",
    });

    writeJson(root, "chapters/App/Ch/chapter.json", {
      id: chapterId, name: "Ch", context: "App",
      sliceOrder: [sliceId1],  // only slice-1, not slice-2
      laneOrder: [laneId],
    });

    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: sliceId1, label: "S1" });
    writeJson(root, "chapters/App/Ch/slices/0002_S/slice.json", { id: sliceId2, label: "S2" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L1/lane.json", { id: laneId, label: "L1", type: "system" });
    writeJson(root, "chapters/App/Ch/slices/0002_S/lanes/system/L1/elements/0001_E/element.json", {
      id: elemId, name: "E1", type: "command", laneId, sliceId: sliceId2,  // sliceId2 not in sliceOrder
    });

    const result = validateModel({ syncRootAbs: root });
    const issue = result.issues.find((i) => i.path.includes("element.json") && i.message.includes("slice-2"));
    expect(issue).toBeDefined();
    expect(issue?.message).toBe("sliceId \"slice-2\" not listed in chapter.json sliceOrder");
  });

  it("flags element with laneId not listed in chapter.json laneOrder", () => {
    const sliceId = "slice-1";
    const laneId1 = "lane-1";
    const laneId2 = "lane-2";  // not in laneOrder
    const elemId  = "elem-1";
    const chapterId = "chapter-1";

    writeJson(root, "uuid-index.json", {
      [chapterId]: "chapters/App/Ch",
      [sliceId]:   "chapters/App/Ch/slices/0001_S",
      [laneId1]:   "chapters/App/Ch/slices/0001_S/lanes/system/L1",
      [laneId2]:   "chapters/App/Ch/slices/0001_S/lanes/system/L2",
      [elemId]:    "chapters/App/Ch/slices/0001_S/lanes/system/L2/elements/0001_E",
    });

    writeJson(root, "chapters/App/Ch/chapter.json", {
      id: chapterId, name: "Ch", context: "App",
      sliceOrder: [sliceId],
      laneOrder: [laneId1],  // only lane-1, not lane-2
    });

    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: sliceId, label: "S" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L1/lane.json", { id: laneId1, label: "L1", type: "system" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L2/lane.json", { id: laneId2, label: "L2", type: "system" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L2/elements/0001_E/element.json", {
      id: elemId, name: "E1", type: "command", laneId: laneId2, sliceId,  // laneId2 not in laneOrder
    });

    const result = validateModel({ syncRootAbs: root });
    const issue = result.issues.find((i) => i.path.includes("element.json") && i.message.includes("lane-2"));
    expect(issue).toBeDefined();
    expect(issue?.message).toBe("laneId \"lane-2\" not listed in chapter.json laneOrder");
  });

  it("passes validation for a complete model with proper chapterOrder", () => {
    const sliceId1 = "slice-1";
    const sliceId2 = "slice-2";
    const laneId1  = "lane-1";
    const laneId2  = "lane-2";
    const elemId1  = "elem-1";
    const elemId2  = "elem-2";
    const chapterId = "chapter-1";

    writeJson(root, "uuid-index.json", {
      [chapterId]: "chapters/App/Ch",
      [sliceId1]:  "chapters/App/Ch/slices/0001_S",
      [sliceId2]:  "chapters/App/Ch/slices/0002_S",
      [laneId1]:   "chapters/App/Ch/slices/0001_S/lanes/system/L1",
      [laneId2]:   "chapters/App/Ch/slices/0002_S/lanes/system/L2",
      [elemId1]:   "chapters/App/Ch/slices/0001_S/lanes/system/L1/elements/0001_E",
      [elemId2]:   "chapters/App/Ch/slices/0002_S/lanes/system/L2/elements/0002_E",
    });

    writeJson(root, "chapters/App/Ch/chapter.json", {
      id: chapterId, name: "Ch", context: "App",
      sliceOrder: [sliceId1, sliceId2],
      laneOrder: [laneId1, laneId2],
    });

    writeJson(root, "chapters/App/Ch/slices/0001_S/slice.json", { id: sliceId1, label: "S1" });
    writeJson(root, "chapters/App/Ch/slices/0002_S/slice.json", { id: sliceId2, label: "S2" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L1/lane.json", { id: laneId1, label: "L1", type: "system" });
    writeJson(root, "chapters/App/Ch/slices/0002_S/lanes/system/L2/lane.json", { id: laneId2, label: "L2", type: "system" });
    writeJson(root, "chapters/App/Ch/slices/0001_S/lanes/system/L1/elements/0001_E/element.json", {
      id: elemId1, name: "E1", type: "command", laneId: laneId1, sliceId: sliceId1,
    });
    writeJson(root, "chapters/App/Ch/slices/0002_S/lanes/system/L2/elements/0002_E/element.json", {
      id: elemId2, name: "E2", type: "command", laneId: laneId2, sliceId: sliceId2,
    });

    const result = validateModel({ syncRootAbs: root });
    expect(result.issues).toHaveLength(0);
  });
});
