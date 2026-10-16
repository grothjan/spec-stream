import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadFromDisk } from "./loader.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("loadFromDisk", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = "/tmp/spec-stream-loader-test";
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    mkdirSync(tmpDir, { recursive: true });
  });

  it("returns undefined if workspace.json is missing", () => {
    expect(loadFromDisk(tmpDir, "ws-1", "Test")).toBeUndefined();
  });

  it("loads a model with a single chapter", () => {
    // Write workspace.json
    writeFileSync(
      join(tmpDir, "workspace.json"),
      JSON.stringify({ id: "ws-1", name: "Test" }),
    );

    // Write a chapter
    mkdirSync(join(tmpDir, "chapters/c1"), { recursive: true });
    writeFileSync(
      join(tmpDir, "chapters/c1/chapter.json"),
      JSON.stringify({
        id: "c1",
        name: "Checkout",
        context: "Ordering",
        index: 0,
        mode: "event-modeling",
        sliceOrder: ["s1"],
        laneOrder: ["l1"],
      }),
    );

    const state = loadFromDisk(tmpDir, "ws-1", "Test");
    expect(state).toBeDefined();
    expect(state?.chapters.size).toBe(1);
    expect(state?.chapters.get("c1")?.name).toBe("Checkout");
  });

  it("loads chapters, slices, lanes, elements", () => {
    // Write workspace.json
    writeFileSync(
      join(tmpDir, "workspace.json"),
      JSON.stringify({ id: "ws-1", name: "Test" }),
    );

    // Write a chapter with lanes, slices, and elements
    mkdirSync(join(tmpDir, "chapters/c1"), { recursive: true });
    writeFileSync(
      join(tmpDir, "chapters/c1/chapter.json"),
      JSON.stringify({
        id: "c1",
        name: "Checkout",
        context: "Ordering",
        index: 0,
        mode: "event-modeling",
        sliceOrder: ["s1"],
        laneOrder: ["l1"],
      }),
    );

    // Write slice
    mkdirSync(join(tmpDir, "chapters/c1/slices/s1"), { recursive: true });
    writeFileSync(
      join(tmpDir, "chapters/c1/slices/s1/slice.json"),
      JSON.stringify({
        id: "s1",
        label: "Place Order",
        chapterId: "c1",
        index: 0,
        status: "planned",
        // details and comments are now in separate files
      }),
    );
    // Write details.md
    writeFileSync(
      join(tmpDir, "chapters/c1/slices/s1/details.md"),
      "",
    );
    // Comments are optional - if no comments folder, treat as empty

    // Write lane
    mkdirSync(join(tmpDir, "chapters/c1/lanes/l1"), { recursive: true });
    writeFileSync(
      join(tmpDir, "chapters/c1/lanes/l1/lane.json"),
      JSON.stringify({
        id: "l1",
        label: "Customer",
        type: "user-lane",
        chapterId: "c1",
        index: 0,
      }),
    );

    // Write element
    mkdirSync(join(tmpDir, "chapters/c1/elements/el1"), { recursive: true });
    writeFileSync(
      join(tmpDir, "chapters/c1/elements/el1/element.json"),
      JSON.stringify({
        id: "el1",
        type: "command",
        name: "Place Order",
        context: "Ordering",
        laneId: "l1",
        sliceId: "s1",
        chapterId: "c1",
        index: 0,
        // description, details, comments are now in separate files
      }),
    );
    // Write description.md
    writeFileSync(
      join(tmpDir, "chapters/c1/elements/el1/description.md"),
      "Buy now",
    );
    // Write details.md
    writeFileSync(
      join(tmpDir, "chapters/c1/elements/el1/details.md"),
      "",
    );

    const state = loadFromDisk(tmpDir, "ws-1", "Test");
    expect(state).toBeDefined();
    expect(state?.chapters.size).toBe(1);
    expect(state?.slices.size).toBe(1);
    expect(state?.lanes.size).toBe(1);
    expect(state?.elements.size).toBe(1);
    expect(state?.chapters.get("c1")?.name).toBe("Checkout");
    expect(state?.slices.get("s1")?.label).toBe("Place Order");
    expect(state?.lanes.get("l1")?.label).toBe("Customer");
    expect(state?.elements.get("el1")?.name).toBe("Place Order");
    
    // Verify the test setup - check that files were written
    expect(existsSync(join(tmpDir, "chapters/c1/chapter.json"))).toBe(true);
    expect(existsSync(join(tmpDir, "chapters/c1/slices/s1/slice.json"))).toBe(true);
    expect(existsSync(join(tmpDir, "chapters/c1/slices/s1/details.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "chapters/c1/lanes/l1/lane.json"))).toBe(true);
    expect(existsSync(join(tmpDir, "chapters/c1/elements/el1/element.json"))).toBe(true);
    expect(existsSync(join(tmpDir, "chapters/c1/elements/el1/description.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "chapters/c1/elements/el1/details.md"))).toBe(true);
  });

  it("loads milestones", () => {
    // Write workspace.json
    writeFileSync(
      join(tmpDir, "workspace.json"),
      JSON.stringify({ id: "ws-1", name: "Test" }),
    );

    // Write milestone
    mkdirSync(join(tmpDir, "milestones/m1"), { recursive: true });
    writeFileSync(
      join(tmpDir, "milestones/m1/milestone.json"),
      JSON.stringify({
        id: "m1",
        name: "MVP",
        description: "First release",
        slices: [],
      }),
    );

    const state = loadFromDisk(tmpDir, "ws-1", "Test");
    expect(state).toBeDefined();
    expect(state?.milestones.size).toBe(1);
    expect(state?.milestones.get("m1")?.name).toBe("MVP");
  });
});
