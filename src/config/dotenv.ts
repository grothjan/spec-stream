/**
 * Optional `.env` loading, dependency-free.
 *
 * Loads `.env.local` and `.env` from a directory (the Next.js / Vite / CRA
 * convention). Files never override variables already present in `process.env`,
 * so they are applied highest-precedence-first and the effective precedence is:
 * real environment (incl. `--env-file`) > `.env.local` > `.env`.
 *
 * Uses Node's built-in `process.loadEnvFile()` (Node ≥ 20.6) when available. If a
 * file doesn't exist it is skipped; missing files are a no-op.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Files loaded, highest precedence first (first writer wins). */
const DOTENV_FILES = [".env.local", ".env"] as const;

/**
 * Load `.env.local` and `.env` from `dir` into `process.env` if present.
 * Returns the path of the highest-precedence file loaded, or null if none.
 */
export function loadDotenv(dir: string = process.cwd()): string | null {
  let loaded: string | null = null;
  for (const name of DOTENV_FILES) {
    const path = resolve(dir, name);
    if (existsSync(path) && loadEnvFile(path)) {
      loaded ??= path;
    }
  }
  return loaded;
}

/** Load a single env file; returns true on success. */
function loadEnvFile(path: string): boolean {
  // Prefer Node's built-in parser (Node ≥ 20.6). It sets vars into process.env.
  const nodeLoad = (process as NodeJS.Process & {
    loadEnvFile?: (p: string) => void;
  }).loadEnvFile;

  if (typeof nodeLoad === "function") {
    try {
      // Built-in overrides existing keys; we snapshot + restore pre-existing ones so that
      // real env vars keep precedence over the file.
      const before = { ...process.env };
      nodeLoad.call(process, path);
      for (const key of Object.keys(before)) {
        if (before[key] !== undefined) process.env[key] = before[key];
      }
      return true;
    } catch {
      // fall through to the minimal parser
    }
  }

  // Minimal fallback parser for older Node: KEY=VALUE lines, no interpolation.
  try {
    const text = readFileSync(path, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (!key || key in process.env) continue; // don't override existing
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
    return true;
  } catch {
    return false;
  }
}
