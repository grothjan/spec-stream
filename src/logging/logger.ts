/**
 * Dual-sink logger: human-readable to the terminal (colorized on a TTY) and structured
 * JSON Lines to a rotating log file. All output is redacted (see redact.ts).
 *
 * The sinks are injectable so the logger is fully unit-testable without touching a TTY
 * or the filesystem.
 */

import type { LogLevel } from "../config/schema.js";
import { redactString, redactValue } from "./redact.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export interface LogRecord {
  ts: string;
  level: LogLevel;
  /** Machine-readable event kind, e.g. "command.done", "conn.state". */
  kind: string;
  msg?: string;
  [field: string]: unknown;
}

/** A sink receives an already-redacted record. */
export interface Sink {
  write(record: LogRecord): void;
}

export interface LoggerOptions {
  level: LogLevel;
  sinks: Sink[];
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Show verbose output (git-style file list). */
  verbose?: boolean;
}

export class Logger {
  private level: number;
  private sinks: Sink[];
  private now: () => Date;
  private readonly verbose: boolean;

  constructor(opts: LoggerOptions) {
    this.level = LEVEL_ORDER[opts.level];
    this.sinks = opts.sinks;
    this.now = opts.now ?? (() => new Date());
    this.verbose = opts.verbose ?? false;
  }

  isVerbose(): boolean {
    return this.verbose;
  }

  setLevel(level: LogLevel): void {
    this.level = LEVEL_ORDER[level];
  }

  isEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= this.level;
  }

  log(level: LogLevel, kind: string, fields: Record<string, unknown> = {}): void {
    if (!this.isEnabled(level)) return;
    const base: LogRecord = {
      ts: this.now().toISOString(),
      level,
      kind,
      ...fields,
    };
    const redacted = redactValue(base);
    for (const sink of this.sinks) {
      try {
        sink.write(redacted);
      } catch {
        // A failing sink must never break the app.
      }
    }
  }

  trace(kind: string, fields?: Record<string, unknown>): void {
    this.log("trace", kind, fields);
  }
  debug(kind: string, fields?: Record<string, unknown>): void {
    this.log("debug", kind, fields);
  }
  info(kind: string, fields?: Record<string, unknown>): void {
    this.log("info", kind, fields);
  }
  warn(kind: string, fields?: Record<string, unknown>): void {
    this.log("warn", kind, fields);
  }
  error(kind: string, fields?: Record<string, unknown>): void {
    this.log("error", kind, fields);
  }
}

/** JSONL sink: one redacted JSON object per line, via an injected line-writer. */
export class JsonlSink implements Sink {
  constructor(private readonly writeLine: (line: string) => void) {}
  write(record: LogRecord): void {
    this.writeLine(JSON.stringify(record));
  }
}

const LEVEL_LABEL: Record<LogLevel, string> = {
  trace: "trace",
  debug: "debug",
  info: "info ",
  warn: "warn ",
  error: "error",
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  trace: "\x1b[90m", // gray
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

/**
 * Pretty terminal sink. Colorizes when `color` is true. Formats a compact one-line
 * summary: `HH:MM:SS  level  kind  key=value …`.
 */
export class PrettySink implements Sink {
  constructor(
    private readonly writeLine: (line: string) => void,
    private readonly color: boolean,
    private readonly verbose: boolean = false,
  ) {}

  write(record: LogRecord): void {
    const lines = formatLogRecord(record, this.color, this.verbose);
    for (const line of lines) {
      this.writeLine(line);
    }
  }
}

function formatTime(iso: string): string {
  // HH:MM:SS from an ISO timestamp; fall back to the raw string.
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

function formatVal(v: unknown): string {
  if (typeof v === "string") {
    const s = redactString(v);
    return /\s/.test(s) ? JSON.stringify(s) : s;
  }
  if (typeof v === "object") return JSON.stringify(redactValue(v));
  return String(v);
}

/**
 * Format a log record for pretty terminal output.
 * Supports multi-line output for complex structured data (like sync logs).
 * Returns an array of lines for split writes.
 */
export function formatLogRecord(record: LogRecord, color: boolean): string[] {
  const { ts, level, kind, msg, ...rest } = record;
  const time = formatTime(ts);
  const label = LEVEL_LABEL[level];
  const levelStr = color ? `${LEVEL_COLOR[level]}${label}${RESET}` : label;

  const output: string[] = [];

  // First line: timestamp + level + kind + optional msg
  const parts: string[] = [];
  if (msg) parts.push(String(msg));
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined || v === null) continue;
    // Special handling for structured fields like byType and changedFiles
    if (k === "byType" && typeof v === "object") {
      const byType = v as Record<string, number>;
      const changedTypes = Object.entries(byType).filter(([_, count]) => count > 0);
      if (changedTypes.length > 0) {
        parts.push(`changed=${changedTypes.map(([t, c]) => `${t}=${c}`).join(" ")}`);
      } else {
        parts.push(`changed=none`);
      }
    } else if (k === "changedFiles" && Array.isArray(v)) {
      const files = v as string[];
      if (files.length > 0) {
        parts.push(`files=${files.length}`);
      }
    } else {
      parts.push(`${k}=${formatVal(v)}`);
    }
  }

  // First line format: timestamp  level  kind  field=value ...
  // Original: kind followed by "  " then parts joined with "  "
  const firstLine = `${time}  ${levelStr}  ${kind}${parts.length > 0 ? "  " + parts.join("  ") : ""}`.trimEnd();
  output.push(firstLine);

  // If there are specific detailed fields, add them on separate lines
  if (rest.note) {
    const noteColor = color ? DIM : "";
    output.push(`${noteColor}    note: ${rest.note}${RESET}`);
  }

  if (rest.appliedEvents !== undefined && Number(rest.appliedEvents) > 0) {
    output.push(`    applied events: ${rest.appliedEvents}`);
  }

  if (rest.chapters !== undefined || rest.slices !== undefined || rest.elements !== undefined) {
    const counts: string[] = [];
    if (rest.chapters !== undefined) counts.push(`chapters=${rest.chapters}`);
    if (rest.slices !== undefined) counts.push(`slices=${rest.slices}`);
    if (rest.elements !== undefined) counts.push(`elements=${rest.elements}`);
    if (rest.milestones !== undefined) counts.push(`milestones=${rest.milestones}`);
    if (counts.length > 0) {
      output.push(`    model: ${counts.join(", ")}`);
    }
  }

  if (rest.created !== undefined || rest.updated !== undefined || rest.deleted !== undefined) {
    const counts: string[] = [];
    if (Number(rest.created) > 0) counts.push(`+${rest.created}`);
    if (Number(rest.updated) > 0) counts.push(`~${rest.updated}`);
    if (Number(rest.deleted) > 0) counts.push(`-${rest.deleted}`);
    if (Number(rest.unchanged) > 0) counts.push(`.${rest.unchanged}`);
    if (counts.length > 0) {
      output.push(`    files: ${counts.join(" ")}`);
    }
  }

  if (typeof rest.note === "string" && !rest.note.startsWith("Rebuilding") && !rest.note.startsWith("First run")) {
    // For seed_done, add detailed file breakdown on separate lines
    if (rest.byType && typeof rest.byType === "object") {
      const byType = rest.byType as Record<string, number>;
      const fileChanges: string[] = [];
      for (const [type, count] of Object.entries(byType)) {
        if (count > 0 && type !== "manifests" && type !== "stateFiles") {
          fileChanges.push(`${type}=${count}`);
        }
      }
      if (fileChanges.length > 0) {
        output.push(`    file types: ${fileChanges.join(" ")}`);
      }
    }
  }

  return output;
}
