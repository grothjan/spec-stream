/**
 * Entry point for `spec-stream scenario {typecheck,run,test}`.
 *
 * Loads the chapter (and scenario(s)) from the local-sync file tree, runs the
 * requested operation, prints results, and sets the process exit code.
 */

import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import type { CliOptions } from "../cli/args.js";
import type { SpecStreamConfig } from "../config/schema.js";
import type { Chapter } from "@proophboard/exploration-runtime";
import {
  loadChapterFromDisk,
  resolveChapterDir,
} from "./loadChapter.js";
import {
  loadScenarioFromDisk,
  listScenarioDirs,
  resolveScenarioDir,
} from "./loadScenario.js";
import { runScenarioFromDisk } from "./run.js";
import { testScenariosFromDisk } from "./test.js";
import { typecheckChapter } from "./typecheck.js";
import type { PlayFunctionDiagnostic } from "./typecheck.js";
import type { ScenarioRunResult } from "@proophboard/exploration-runtime";
import type { ScenarioRunOutput } from "./run.js";
import type { ScenarioTestOutput } from "./test.js";

// ─────────────────────────────────────────────────────────────────────────────
// ANSI color codes for colorful output
// ─────────────────────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";
const BOLD = "\x1b[1m";

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function runScenarioCommand(
  opts: CliOptions,
  config: SpecStreamConfig,
): Promise<void> {
  // ── Guard: localSync must be enabled ────────────────────────────────────
  if (!config.localSync.enabled) {
    process.stderr.write(
      `spec-stream: 'scenario' commands require localSync to be enabled.\n` +
      `Add to proophboard.spec-stream.json:\n` +
      `  { "localSync": { "enabled": true, "dir": ".spec-stream/model" } }\n` +
      `Then run: spec-stream run   (to populate the model)\n`,
    );
    process.exit(1);
  }

  const modelRoot = resolve(config.configDir, config.localSync.dir);

  if (!existsSync(modelRoot)) {
    process.stderr.write(
      `spec-stream: model directory not found: ${modelRoot}\n` +
      `Run 'spec-stream run' first to populate the local model.\n`,
    );
    process.exit(1);
  }

  // Suppress the fold's [PlayWorker] console.log output unless --verbose.
  // The runtime logs are intentionally permanent in the browser; in the CLI they
  // are noise unless the user explicitly wants to see them.
  if (!opts.verbose) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    console.log = () => {};
  }

  switch (opts.scenarioSubcommand) {
    case "typecheck":
      return cmdTypecheck(opts, modelRoot);
    case "run":
      return cmdRun(opts, modelRoot);
    case "test":
      return cmdTest(opts, modelRoot);
    default:
      process.stderr.write(
        `spec-stream: unknown scenario subcommand. Use: typecheck, run, test\n`,
      );
      process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// typecheck
// ─────────────────────────────────────────────────────────────────────────────

async function cmdTypecheck(opts: CliOptions, modelRoot: string): Promise<void> {
  const chapters = await resolveChapters(opts, modelRoot);

  let totalDiags: PlayFunctionDiagnostic[] = [];
  for (const chapter of chapters) {
    const diags = await typecheckChapter(chapter);
    totalDiags = totalDiags.concat(diags);
  }

  if (totalDiags.length === 0) {
    process.stdout.write(`${GREEN}✓${RESET} No type errors found.\n`);
    return;
  }

  // Group by element
  const byElement = new Map<string, PlayFunctionDiagnostic[]>();
  for (const d of totalDiags) {
    const key = `${d.elementName} (${d.elementId})`;
    if (!byElement.has(key)) byElement.set(key, []);
    byElement.get(key)!.push(d);
  }

  for (const [label, diags] of byElement) {
    process.stdout.write(`\n${BOLD}${label}:${RESET}\n`);
    for (const d of diags) {
      process.stdout.write(
        `  ${RED}[${d.kind}]${RESET} ${d.line}:${d.col}  TS${d.code}: ${d.message}\n`,
      );
    }
  }
  process.stdout.write(`\n${totalDiags.length} error(s) found.\n`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// run
// ─────────────────────────────────────────────────────────────────────────────

async function cmdRun(opts: CliOptions, modelRoot: string): Promise<void> {
  if (!opts.chapterRef) {
    process.stderr.write(`spec-stream scenario run: --chapter is required\n`);
    process.exit(1);
  }
  if (!opts.scenarioRef) {
    process.stderr.write(`spec-stream scenario run: --scenario is required\n`);
    process.exit(1);
  }

  const chapterDir = await resolveChapterDir(modelRoot, opts.chapterRef);
  const chapter = await loadChapterFromDisk(chapterDir);
  const scenarioDir = await resolveScenarioDir(chapterDir, opts.scenarioRef);
  const scenario = await loadScenarioFromDisk(scenarioDir);

  const output = await runScenarioFromDisk(chapter, scenario, opts.playhead);
  printRunOutput(output);
}

function printRunOutput(output: ScenarioRunOutput): void {
  process.stdout.write(`\n── ${BOLD}Scenario: ${output.scenarioName}${RESET} ──\n`);
  process.stdout.write(`Clock: ${output.clockISO ?? "(wall clock)"}\n\n`);

  process.stdout.write(`Events (${output.events.length}):\n`);
  if (output.events.length === 0) {
    process.stdout.write(`  (none)\n`);
  } else {
    for (const ev of output.events) {
      process.stdout.write(`  [${BLUE}${ev.context}${RESET}] ${ev.name}\n`);
      if (Object.keys(ev.payload ?? {}).length > 0) {
        process.stdout.write(`    ${JSON.stringify(ev.payload)}\n`);
      }
    }
  }

  if (output.readViews.length > 0) {
    // Deduplicate by key: keep the last occurrence, which corresponds to the
    // latest slice on the timeline (elements are sorted by slice index in the loader).
    // This means "fold to step 2" shows Todo.status=open; "fold to end" shows Todo.status=done.
    const dedupedViews = new Map<string, (typeof output.readViews)[0]>();
    for (const rv of output.readViews) {
      dedupedViews.set(rv.key, rv);
    }
    process.stdout.write(`\nRead views (${dedupedViews.size}):\n`);
    for (const rv of dedupedViews.values()) {
      process.stdout.write(`  ${rv.key}: ${JSON.stringify(rv.view)}\n`);
    }
  }

  if (output.errors.length > 0) {
    process.stdout.write(`\nErrors (${output.errors.length}):\n`);
    for (const err of output.errors) {
      process.stdout.write(`  ${RED}[${err.kind}]${RESET} ${err.message}\n`);
    }
  }
  process.stdout.write(`\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// test
// ─────────────────────────────────────────────────────────────────────────────

async function cmdTest(opts: CliOptions, modelRoot: string): Promise<void> {
  if (!opts.scenarioRef && !opts.all) {
    process.stderr.write(
      `spec-stream scenario test: provide --scenario <id|name> or --all\n`,
    );
    process.exit(1);
  }

  const chapters = await resolveChapters(opts, modelRoot);
  let totalResults: ScenarioRunResult[] = [];
  let totalHasBroken = false;
  let totalNeutralCount = 0;
  let chapterNames: string[] = [];

  if (opts.all) {
    // When --all, test all scenarios from the chapter(s)
    for (const chapter of chapters) {
      const chapterDir = await resolveChapterDir(modelRoot, chapter.id);
      const dirs = await listScenarioDirs(chapterDir);
      const scenarios = await Promise.all(dirs.map(loadScenarioFromDisk));

      const output = await testScenariosFromDisk(chapter, scenarios);
      totalResults = totalResults.concat(output.results);
      totalHasBroken = totalHasBroken || output.hasBroken;
      totalNeutralCount += output.neutralCount;
      chapterNames.push(chapter.name);
    }
  } else {
    // When targeting specific scenario (without --all), chapter is required
    if (!opts.chapterRef) {
      process.stderr.write(`spec-stream scenario test: --chapter is required when not using --all\n`);
      process.exit(1);
    }

    const chapterDir = await resolveChapterDir(modelRoot, opts.chapterRef);
    const chapter = await loadChapterFromDisk(chapterDir);
    chapterNames = [chapter.name];

    const scenarioDir = await resolveScenarioDir(chapterDir, opts.scenarioRef!);
    const scenarios = [await loadScenarioFromDisk(scenarioDir)];

    const output = await testScenariosFromDisk(chapter, scenarios);
    totalResults = totalResults.concat(output.results);
    totalHasBroken = output.hasBroken;
    totalNeutralCount = output.neutralCount;
  }

  printTestOutput({ results: totalResults, hasBroken: totalHasBroken, neutralCount: totalNeutralCount }, chapterNames);

  if (totalHasBroken) process.exit(1);
}

function printTestOutput(output: ScenarioTestOutput, chapterNames: string[]): void {
  let passed = 0;
  let broken = 0;
  let neutral = 0;

  for (const result of output.results) {
    let statusColor: string;
    let statusIcon: string;
    
    if (result.status === "pass") {
      statusColor = GREEN;
      statusIcon = "✓";
      passed++;
    } else if (result.status === "broken") {
      statusColor = RED;
      statusIcon = "✗";
      broken++;
    } else {
      statusColor = YELLOW;
      statusIcon = "○";
      neutral++;
    }

    process.stdout.write(`  ${statusColor}${statusIcon}${RESET} ${result.scenarioName}  [${statusColor}${result.status}${RESET}]\n`);

    if (result.status === "broken") {
      for (const er of result.expectationResults) {
        if (!er.matched) {
          process.stdout.write(
            `      ${RED}${er.kind}${RESET} on slice ${er.sliceId}: ${er.failureKind ?? "mismatch"}` +
            (er.message ? ` — ${er.message}` : "") + "\n",
          );
        }
      }
      for (const se of result.structuralErrors) {
        process.stdout.write(`      ${RED}[${se.kind}]${RESET} ${se.message}\n`);
      }
    }
  }

  // Summary line with colored counts
  let summaryParts: string[] = [];
  if (passed > 0) summaryParts.push(`${GREEN}${passed} passed${RESET}`);
  if (broken > 0) summaryParts.push(`${RED}${broken} broken${RESET}`);
  if (neutral > 0) summaryParts.push(`${YELLOW}${neutral} neutral${RESET}`);

  const chapterSummary = chapterNames.length > 0 ? ` ${BLUE}in ${chapterNames.join(", ")}${RESET}` : "";
  process.stdout.write(`\n${summaryParts.join(", ")}${chapterSummary}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

async function resolveChapters(
  opts: CliOptions,
  modelRoot: string,
): Promise<Chapter[]> {
  if (!opts.chapterRef) {
    // No --chapter: typecheck all chapters in the model root
    const { readdir } = await import("node:fs/promises");
    const chaptersRoot = join(modelRoot, "chapters");
    const chapters: Chapter[] = [];
    try {
      const entries = await readdir(chaptersRoot);
      for (const entry of entries) {
        const dir = join(chaptersRoot, entry);
        // Skip non-directories or entries without chapter.json
        try {
          const chapterJsonPath = join(dir, "chapter.json");
          // Check if chapter.json exists (direct check without trying to load)
          if (existsSync(chapterJsonPath)) {
            chapters.push(await loadChapterFromDisk(dir));
          }
        } catch {
          // skip non-chapter dirs
        }
      }
    } catch {
      process.stderr.write(
        `spec-stream: no chapters found in ${chaptersRoot}\n`,
      );
      process.exit(1);
    }
    return chapters;
  }

  const chapterDir = await resolveChapterDir(modelRoot, opts.chapterRef);
  return [await loadChapterFromDisk(chapterDir)];
}
