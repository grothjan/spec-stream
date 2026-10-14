import { describe, it, expect } from "vitest";
import { parseSyncPath, primaryJsonPath } from "./pathParser.js";

// UUIDs used in test paths
const CHAPTER_UUID  = "9598a1b8-406c-4366-a907-abc2d33c22be";
const SLICE_UUID    = "e5227bbf-cf01-4c62-85b2-a8ffa48f56a9";
const LANE_UUID     = "40e12bb9-5485-4399-a1d4-bcd50fa334aa";
const ELEMENT_UUID  = "422a7caa-36a2-42bf-a313-3f7b3090d6b8";
const SCENARIO_UUID = "db1b3218-29e9-47cc-bab9-38b2ed6f3c6c";

const CHAPTER_DIR  = `chapters/${CHAPTER_UUID}`;
const SLICE_DIR    = `${CHAPTER_DIR}/slices/${SLICE_UUID}`;
const LANE_DIR     = `${CHAPTER_DIR}/lanes/${LANE_UUID}`;
const ELEMENT_DIR  = `${CHAPTER_DIR}/elements/${ELEMENT_UUID}`;
const SCENARIO_DIR = `${CHAPTER_DIR}/scenarios/${SCENARIO_UUID}`;

describe("parseSyncPath", () => {
  // ─── chapter ────────────────────────────────────────────────────────────────
  describe("chapter files", () => {
    it("parses chapter.json", () => {
      const result = parseSyncPath(`${CHAPTER_DIR}/chapter.json`);
      expect(result).toEqual({
        kind: "chapter",
        entityDir: CHAPTER_DIR,
        role: "chapter.json",
        generated: false,
      });
    });

    it("marks index.md as generated", () => {
      const result = parseSyncPath(`${CHAPTER_DIR}/index.md`);
      expect(result).toEqual({
        kind: "chapter",
        entityDir: CHAPTER_DIR,
        role: "index.md",
        generated: true,
      });
    });

    it("returns null for the chapter directory itself", () => {
      expect(parseSyncPath(CHAPTER_DIR)).toBeNull();
    });
  });

  // ─── slice ──────────────────────────────────────────────────────────────────
  describe("slice files", () => {
    it("parses slice.json", () => {
      const result = parseSyncPath(`${SLICE_DIR}/slice.json`);
      expect(result).toEqual({
        kind: "slice",
        entityDir: SLICE_DIR,
        role: "slice.json",
        generated: false,
      });
    });

    it("parses slice details.md", () => {
      const result = parseSyncPath(`${SLICE_DIR}/details.md`);
      expect(result).toEqual({
        kind: "slice",
        entityDir: SLICE_DIR,
        role: "slice.details",
        generated: false,
      });
    });

    it("returns null for unknown files under slice", () => {
      expect(parseSyncPath(`${SLICE_DIR}/other.txt`)).toBeNull();
    });

    it("returns null for comments under slice", () => {
      expect(parseSyncPath(`${SLICE_DIR}/comments/2026-01-01_abc/comment.json`)).toBeNull();
    });
  });

  // ─── lane ───────────────────────────────────────────────────────────────────
  describe("lane files", () => {
    it("parses lane.json", () => {
      const result = parseSyncPath(`${LANE_DIR}/lane.json`);
      expect(result).toEqual({
        kind: "lane",
        entityDir: LANE_DIR,
        role: "lane.json",
        generated: false,
      });
    });

    it("returns null for unknown files under lane", () => {
      expect(parseSyncPath(`${LANE_DIR}/other.txt`)).toBeNull();
    });
  });

  // ─── element ─────────────────────────────────────────────────────────────────
  describe("element files", () => {
    it("parses element.json", () => {
      const result = parseSyncPath(`${ELEMENT_DIR}/element.json`);
      expect(result).toEqual({
        kind: "element",
        entityDir: ELEMENT_DIR,
        role: "element.json",
        generated: false,
      });
    });

    it("parses description.md", () => {
      expect(parseSyncPath(`${ELEMENT_DIR}/description.md`))
        .toMatchObject({ kind: "element", role: "element.description" });
    });

    it("parses details.md", () => {
      expect(parseSyncPath(`${ELEMENT_DIR}/details.md`))
        .toMatchObject({ kind: "element", role: "element.details" });
    });

    it("parses play-function.ts", () => {
      expect(parseSyncPath(`${ELEMENT_DIR}/play-function.ts`))
        .toMatchObject({ kind: "element", role: "element.play-function" });
    });

    it("parses play-type.ts", () => {
      expect(parseSyncPath(`${ELEMENT_DIR}/play-type.ts`))
        .toMatchObject({ kind: "element", role: "element.play-type" });
    });

    it("returns null for unknown files under element", () => {
      expect(parseSyncPath(`${ELEMENT_DIR}/other.txt`)).toBeNull();
    });

    it("returns null for comments under element", () => {
      expect(parseSyncPath(`${ELEMENT_DIR}/comments/2026-01-01_abc/comment.md`)).toBeNull();
    });
  });

  // ─── scenario ────────────────────────────────────────────────────────────────
  describe("scenario files", () => {
    it("parses scenario.json", () => {
      const result = parseSyncPath(`${SCENARIO_DIR}/scenario.json`);
      expect(result).toEqual({
        kind: "scenario",
        entityDir: SCENARIO_DIR,
        role: "scenario.json",
        generated: false,
      });
    });

    it("returns null for non-scenario.json files under scenarios", () => {
      expect(parseSyncPath(`${SCENARIO_DIR}/other.md`)).toBeNull();
    });
  });

  // ─── milestone ───────────────────────────────────────────────────────────────
  describe("milestone files", () => {
    it("parses milestone.json", () => {
      const result = parseSyncPath("milestones/My-Milestone/milestone.json");
      expect(result).toEqual({
        kind: "milestone",
        entityDir: "milestones/My-Milestone",
        role: "milestone.json",
        generated: false,
      });
    });

    it("parses milestone description.md", () => {
      expect(parseSyncPath("milestones/My-Milestone/description.md"))
        .toMatchObject({ kind: "milestone", role: "milestone.description" });
    });
  });

  // ─── html-snippets ────────────────────────────────────────────────────────────
  describe("html-snippet files", () => {
    it("parses html snippet .html", () => {
      const result = parseSyncPath("html-snippets/my-snippet.html");
      expect(result).toEqual({
        kind: "html-snippet",
        entityDir: "html-snippets/my-snippet",
        role: "html-snippet.html",
        generated: false,
      });
    });

    it("parses html snippet .json", () => {
      const result = parseSyncPath("html-snippets/my-snippet.json");
      expect(result).toEqual({
        kind: "html-snippet",
        entityDir: "html-snippets/my-snippet",
        role: "html-snippet.json",
        generated: false,
      });
    });
  });

  // ─── ignored paths ────────────────────────────────────────────────────────────
  describe("ignored paths", () => {
    it("returns null for workspace.json", () => {
      expect(parseSyncPath("workspace.json")).toBeNull();
    });

    it("returns null for uuid-index.json", () => {
      expect(parseSyncPath("uuid-index.json")).toBeNull();
    });

    it("returns null for sync-state.json", () => {
      expect(parseSyncPath("sync-state.json")).toBeNull();
    });

    it("handles backslash paths (Windows)", () => {
      const result = parseSyncPath(
        `chapters\\${CHAPTER_UUID}\\slices\\${SLICE_UUID}\\slice.json`,
      );
      expect(result).toMatchObject({ kind: "slice", role: "slice.json" });
    });
  });
});

describe("primaryJsonPath", () => {
  it("returns chapter.json for chapter", () => {
    const parsed = parseSyncPath(`${CHAPTER_DIR}/chapter.json`)!;
    expect(primaryJsonPath(parsed)).toBe(`${CHAPTER_DIR}/chapter.json`);
  });

  it("returns slice.json for slice", () => {
    const parsed = parseSyncPath(`${SLICE_DIR}/slice.json`)!;
    expect(primaryJsonPath(parsed)).toBe(`${SLICE_DIR}/slice.json`);
  });

  it("returns lane.json for lane", () => {
    const parsed = parseSyncPath(`${LANE_DIR}/lane.json`)!;
    expect(primaryJsonPath(parsed)).toBe(`${LANE_DIR}/lane.json`);
  });

  it("returns element.json for element description", () => {
    const parsed = parseSyncPath(`${ELEMENT_DIR}/description.md`)!;
    expect(primaryJsonPath(parsed)).toBe(`${ELEMENT_DIR}/element.json`);
  });

  it("returns scenario.json for scenario", () => {
    const parsed = parseSyncPath(`${SCENARIO_DIR}/scenario.json`)!;
    expect(primaryJsonPath(parsed)).toBe(`${SCENARIO_DIR}/scenario.json`);
  });
});
