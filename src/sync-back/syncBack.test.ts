import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSyncBack } from "./syncBack.js";
import { loadManifest, syncBackIdsPath } from "./manifest.js";
import { API_KEY_ENV } from "../config/load.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a minimal project dir:
 *   <tmp>/proophboard.spec-stream.json
 *   <tmp>/.spec-stream/model/…  (the localSync dir)
 */
function makeProject(): string {
  const dir = join(
    tmpdir(),
    `spec-stream-syncback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, ".spec-stream/model"), { recursive: true });
  writeFileSync(
    join(dir, "proophboard.spec-stream.json"),
    JSON.stringify(
      {
        endpoint: "https://board.example.test/api",
        localSync: { enabled: true, dir: ".spec-stream/model" },
        rules: [],
      },
      null,
      2,
    ),
    "utf8",
  );
  return dir;
}

function writeHtmlSnippet(projectDir: string, slug: string): void {
  const snippetsDir = join(projectDir, ".spec-stream/model/html-snippets");
  mkdirSync(snippetsDir, { recursive: true });
  writeFileSync(
    join(snippetsDir, `${slug}.json`),
    JSON.stringify({ slug, name: "My Snippet" }, null, 2),
    "utf8",
  );
  writeFileSync(join(snippetsDir, `${slug}.html`), "<div>Hello</div>", "utf8");
}

const modelDir = (projectDir: string) => join(projectDir, ".spec-stream/model");
const configPath = (projectDir: string) => join(projectDir, "proophboard.spec-stream.json");

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runSyncBack — html-snippet GC regression", () => {
  let projectDir: string;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    projectDir = makeProject();
    savedApiKey = process.env[API_KEY_ENV];
    process.env[API_KEY_ENV] = "pb_test-key";
  });

  afterEach(() => {
    if (savedApiKey === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = savedApiKey;
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("records a created html-snippet in sync-back-ids and skips it on the next run", async () => {
    writeHtmlSnippet(projectDir, "my-snippet");

    // Mock the API: the first POST /snippets succeeds (returns the slug),
    // any later create for the same slug fails with 400 "already exists" —
    // the real-world symptom of the bug.
    const posts: string[] = [];
    const fetchImpl: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/snippets")) {
        posts.push(url);
        if (posts.length === 1) {
          return new Response(JSON.stringify({ slug: "my-snippet" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ error: 'A snippet with slug "my-snippet" already exists' }),
          { status: 400, headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    // ── Run 1: creates the snippet on the board ──
    const first = await runSyncBack({
      cwd: projectDir,
      configPath: configPath(projectDir),
      fetchImpl,
      omitChecks: true,
    });
    expect(first.failed).toBe(0);
    expect(first.executed).toBe(1);
    expect(posts).toHaveLength(1);

    // The freshly created snippet must stay in sync-back-ids.json so the next
    // run knows it already exists on the board. Bug: the GC removes the entry
    // in the same run because it checks for an entity *directory* that never
    // exists for html-snippets (flat files: html-snippets/<slug>.json/.html).
    const ids = loadManifest(syncBackIdsPath(modelDir(projectDir)));
    expect(ids.entities["html-snippets/my-snippet"]).toBeDefined();
    expect(ids.entities["html-snippets/my-snippet"]?.id).toBe("my-snippet");

    // ── Run 2: nothing changed → no operations at all ──
    const second = await runSyncBack({
      cwd: projectDir,
      configPath: configPath(projectDir),
      fetchImpl,
      omitChecks: true,
    });
    // Bug: the snippet is diffed as "create" again → POST /snippets → 400.
    expect(second.operationCount).toBe(0);
    expect(second.failed).toBe(0);
    expect(posts).toHaveLength(1); // no second create call
  });
});
