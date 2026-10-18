import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolvePaths, isSyncBackLocked, createSyncBackLock, removeSyncBackLock } from "./paths.js";
import { existsSync, unlinkSync, mkdirSync, rmdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("resolvePaths — project mode (default)", () => {
  it("places state under <configDir>/.spec-stream", () => {
    const p = resolvePaths({ configDir: "/proj" });
    expect(p.baseDir).toBe("/proj/.spec-stream");
    expect(p.logDir).toBe("/proj/.spec-stream/logs");
    expect(p.logFile).toBe("/proj/.spec-stream/logs/spec-stream.jsonl");
    expect(p.pidFile).toBe("/proj/.spec-stream/spec-stream.pid");
    expect(p.commandsDir).toBe("/proj/.spec-stream/logs/commands");
  });

  it("honors a relative logDir override against configDir", () => {
    const p = resolvePaths({ configDir: "/proj", logDirOverride: "mylogs" });
    expect(p.logDir).toBe("/proj/mylogs");
    expect(p.logFile).toBe("/proj/mylogs/spec-stream.jsonl");
  });

  it("honors an absolute logDir override", () => {
    const p = resolvePaths({ configDir: "/proj", logDirOverride: "/var/log/ss" });
    expect(p.logDir).toBe("/var/log/ss");
  });

  it("honors a stateDir override for the pid file", () => {
    const p = resolvePaths({ configDir: "/proj", stateDirOverride: "/run/ss" });
    expect(p.pidFile).toBe("/run/ss/spec-stream.pid");
  });
});

describe("resolvePaths — user/daemon mode", () => {
  it("uses XDG_STATE_HOME when set (linux)", () => {
    const p = resolvePaths({
      configDir: "/proj",
      userMode: true,
      platform: "linux",
      env: { XDG_STATE_HOME: "/home/u/.local/state" },
      home: "/home/u",
    });
    expect(p.baseDir).toBe("/home/u/.local/state/spec-stream");
    expect(p.logDir).toBe("/home/u/.local/state/spec-stream/logs");
    expect(p.pidFile).toBe("/home/u/.local/state/spec-stream/spec-stream.pid");
  });

  it("falls back to ~/.local/state when XDG unset", () => {
    const p = resolvePaths({
      configDir: "/proj",
      userMode: true,
      platform: "linux",
      env: {},
      home: "/home/u",
    });
    expect(p.baseDir).toBe("/home/u/.local/state/spec-stream");
  });

  it("uses LOCALAPPDATA on win32", () => {
    const p = resolvePaths({
      configDir: "C:/proj",
      userMode: true,
      platform: "win32",
      env: { LOCALAPPDATA: "C:/Users/u/AppData/Local" },
      home: "C:/Users/u",
    });
    expect(p.baseDir.replace(/\\/g, "/")).toBe("C:/Users/u/AppData/Local/spec-stream");
  });
});

describe("sync-back lock file", () => {
  const testDir = "/tmp/spec-stream-test-lock";
  const testStateDir = join(testDir, ".spec-stream", "state");

  beforeEach(() => {
    // Clean up before each test
    if (existsSync(testDir)) {
      rmdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up after each test
    if (existsSync(testDir)) {
      rmdirSync(testDir, { recursive: true });
    }
  });

  it("isLocked returns false when lock file does not exist", () => {
    const paths = resolvePaths({ configDir: testDir, stateDirOverride: testStateDir });
    expect(isSyncBackLocked(paths)).toBe(false);
  });

  it("isLocked returns true when lock file exists", () => {
    const paths = resolvePaths({ configDir: testDir, stateDirOverride: testStateDir });
    createSyncBackLock(paths);
    expect(isSyncBackLocked(paths)).toBe(true);
  });

  it("createSyncBackLock creates the lock file with PID and timestamp", () => {
    const paths = resolvePaths({ configDir: testDir, stateDirOverride: testStateDir });
    const lockFile = createSyncBackLock(paths);

    expect(lockFile).toBe(paths.syncBackLockFile);
    expect(existsSync(lockFile)).toBe(true);

    const content = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(content).toHaveProperty("pid");
    expect(content.pid).toBe(process.pid);
    expect(content).toHaveProperty("createdAt");
    expect(new Date(content.createdAt).toISOString()).toBeDefined();
  });

  it("removeSyncBackLock deletes the lock file", () => {
    const paths = resolvePaths({ configDir: testDir, stateDirOverride: testStateDir });
    createSyncBackLock(paths);
    expect(existsSync(paths.syncBackLockFile)).toBe(true);

    removeSyncBackLock(paths);
    expect(existsSync(paths.syncBackLockFile)).toBe(false);
  });

  it("removeSyncBackLock handles missing file gracefully", () => {
    const paths = resolvePaths({ configDir: testDir, stateDirOverride: testStateDir });
    // File doesn't exist - should not throw
    expect(() => removeSyncBackLock(paths)).not.toThrow();
    expect(existsSync(paths.syncBackLockFile)).toBe(false);
  });

  it("lock file path is correct", () => {
    const paths = resolvePaths({ configDir: testDir, stateDirOverride: testStateDir });
    expect(paths.syncBackLockFile).toBe(join(testStateDir, "sync-back-lock"));
  });
});