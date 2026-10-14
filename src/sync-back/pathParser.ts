/**
 * Path parser for the sync-back command.
 *
 * Takes a file path relative to the local sync root (e.g. `.spec-stream/model`) and
 * parses it into a structured {@link ParsedPath} descriptor that identifies which entity
 * the file belongs to, what file type it is, and the full directory path.
 *
 * The local model file layout is:
 *
 *   chapters/[chapter-uuid]/
 *     chapter.json, index.md
 *     slices/[slice-uuid]/
 *       slice.json, details.md
 *     lanes/[lane-uuid]/
 *       lane.json
 *     elements/[element-uuid]/
 *       element.json, description.md, details.md, play-function.ts, play-type.ts
 *     scenarios/[scenario-uuid]/
 *       scenario.json
 *   milestones/[milestone-uuid]/
 *     milestone.json, description.md
 *
 * IMPORTANT: All directory names are UUIDs. The parser identifies the entity type
 * and the directory containing the .json.
 */

export type EntityKind = "chapter" | "slice" | "lane" | "element" | "milestone" | "html-snippet" | "scenario";

export type FileRole =
  | "chapter.json"
  | "index.md"           // generated, skip
  | "slice.json"
  | "slice.details"
  | "lane.json"
  | "element.json"
  | "element.description"
  | "element.details"
  | "element.play-function"
  | "element.play-type"
  | "milestone.json"
  | "milestone.description"
  | "html-snippet.html"
  | "html-snippet.json"
  | "scenario.json"
  | "unknown";

export interface ParsedPath {
  kind: EntityKind;
  /** The directory containing the entity's primary .json (relative to sync root). */
  entityDir: string;
  /** What file this path represents. */
  role: FileRole;
  /** True if this file is auto-generated and should never be synced back. */
  generated: boolean;
}

/**
 * Parse a relative file path (forward-slash, relative to the sync root) into a
 * structured descriptor.
 *
 * Returns `null` for paths that are not part of the managed model tree or that
 * are not supported for sync-back.
 */
export function parseSyncPath(relPath: string): ParsedPath | null {
  // Normalize to forward-slash.
  const p = relPath.replace(/\\/g, "/");

  // ─── html-snippets ───────────────────────────────────────────────────────────
  // html-snippets/[slug].html  or  html-snippets/[slug].json
  const snippetMatch = p.match(/^html-snippets\/([^/]+)\.(html|json)$/);
  if (snippetMatch) {
    const [, slugSeg, ext] = snippetMatch;
    const dir = `html-snippets/${slugSeg}`;
    const role: FileRole = ext === "html" ? "html-snippet.html" : "html-snippet.json";
    return { kind: "html-snippet", entityDir: dir, role, generated: false };
  }

  // ─── chapter tree ────────────────────────────────────────────────────────────
  // chapters/[chapter-uuid]/...
  const chapterBase = p.match(/^(chapters\/[^/]+)(?:\/(.*))?$/);
  if (!chapterBase) {
    return parseMilestonePath(p);
  }

  const [, chapterDir, rest] = chapterBase;

  if (!rest) return null; // bare chapter directory

  // chapter.json / index.md
  if (rest === "chapter.json") {
    return { kind: "chapter", entityDir: chapterDir, role: "chapter.json", generated: false };
  }
  if (rest === "index.md") {
    return { kind: "chapter", entityDir: chapterDir, role: "index.md", generated: true };
  }

  // slices/[slice-uuid]/...
  const sliceMatch = rest.match(/^(slices\/[^/]+)(?:\/(.*))?$/);
  if (sliceMatch) {
    const [, sliceSeg, sliceFile] = sliceMatch;
    const sliceDir = `${chapterDir}/${sliceSeg}`;
    if (!sliceFile) return null;
    if (sliceFile === "slice.json")  return { kind: "slice", entityDir: sliceDir, role: "slice.json",   generated: false };
    if (sliceFile === "details.md")  return { kind: "slice", entityDir: sliceDir, role: "slice.details", generated: false };
    if (sliceFile.startsWith("comments/")) return null;
    return null;
  }

  // lanes/[lane-uuid]/lane.json
  const laneMatch = rest.match(/^(lanes\/[^/]+)(?:\/(.*))?$/);
  if (laneMatch) {
    const [, laneSeg, laneFile] = laneMatch;
    const laneDir = `${chapterDir}/${laneSeg}`;
    if (!laneFile) return null;
    if (laneFile === "lane.json") return { kind: "lane", entityDir: laneDir, role: "lane.json", generated: false };
    return null;
  }

  // elements/[element-uuid]/...
  const elemMatch = rest.match(/^(elements\/[^/]+)(?:\/(.*))?$/);
  if (elemMatch) {
    const [, elemSeg, elemFile] = elemMatch;
    const elemDir = `${chapterDir}/${elemSeg}`;
    if (!elemFile) return null;
    switch (elemFile) {
      case "element.json":    return { kind: "element", entityDir: elemDir, role: "element.json",          generated: false };
      case "description.md":  return { kind: "element", entityDir: elemDir, role: "element.description",   generated: false };
      case "details.md":      return { kind: "element", entityDir: elemDir, role: "element.details",       generated: false };
      case "play-function.ts":return { kind: "element", entityDir: elemDir, role: "element.play-function", generated: false };
      case "play-type.ts":    return { kind: "element", entityDir: elemDir, role: "element.play-type",     generated: false };
      default: return null;
    }
  }

  // scenarios/[scenario-uuid]/scenario.json
  const scenarioMatch = rest.match(/^(scenarios\/[^/]+)\/(scenario\.json)$/);
  if (scenarioMatch) {
    const [, scenarioSeg] = scenarioMatch;
    const scenarioDir = `${chapterDir}/${scenarioSeg}`;
    return { kind: "scenario", entityDir: scenarioDir, role: "scenario.json", generated: false };
  }

  return null;
}

function parseMilestonePath(p: string): ParsedPath | null {
  // milestones/[milestone-uuid]/...
  const mMatch = p.match(/^(milestones\/[^/]+)(?:\/(.*))?$/);
  if (!mMatch) return null;

  const [, milestoneDir, rest] = mMatch;
  if (!rest) return null;

  if (rest === "milestone.json") {
    return { kind: "milestone", entityDir: milestoneDir, role: "milestone.json", generated: false };
  }
  if (rest === "description.md") {
    return { kind: "milestone", entityDir: milestoneDir, role: "milestone.description", generated: false };
  }
  return null;
}

/**
 * Given a parsed path's entityDir, return the path to the primary .json file for
 * that entity (e.g. element.json, slice.json, etc.).
 */
export function primaryJsonPath(parsed: ParsedPath): string {
  switch (parsed.kind) {
    case "chapter":       return `${parsed.entityDir}/chapter.json`;
    case "slice":         return `${parsed.entityDir}/slice.json`;
    case "lane":          return `${parsed.entityDir}/lane.json`;
    case "element":       return `${parsed.entityDir}/element.json`;
    case "milestone":     return `${parsed.entityDir}/milestone.json`;
    case "html-snippet":  return `${parsed.entityDir}.json`;
    case "scenario":      return `${parsed.entityDir}/scenario.json`;
  }
}
