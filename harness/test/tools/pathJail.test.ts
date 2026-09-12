import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSafePath, PathJailError } from "../../src/tools/pathJail.js";

let repoRoot: string;
let outsideDir: string;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "devagent-jail-"));
  repoRoot = join(base, "repo");
  outsideDir = join(base, "outside");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(repoRoot, "src", "a.txt"), "inside");
  writeFileSync(join(outsideDir, "secret.txt"), "outside");
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe("resolveSafePath", () => {
  it("resolves a plain relative path inside the repo", () => {
    const resolved = resolveSafePath(repoRoot, "src/a.txt");
    expect(resolved.endsWith(join("src", "a.txt"))).toBe(true);
  });

  it("resolves '.' to the repo root itself", () => {
    const resolved = resolveSafePath(repoRoot, ".");
    expect(resolved).toBe(repoRoot);
  });

  it("rejects a '..' traversal that escapes the repo root", () => {
    expect(() => resolveSafePath(repoRoot, "../outside/secret.txt")).toThrow(PathJailError);
  });

  it("rejects an absolute path", () => {
    expect(() => resolveSafePath(repoRoot, outsideDir)).toThrow(PathJailError);
  });

  it("rejects a Windows drive-letter path even if not flagged absolute", () => {
    expect(() => resolveSafePath(repoRoot, "C:\\Windows\\System32")).toThrow(PathJailError);
  });

  it("rejects a UNC path", () => {
    expect(() => resolveSafePath(repoRoot, "\\\\server\\share")).toThrow(PathJailError);
  });

  it("rejects a path containing a null byte", () => {
    expect(() => resolveSafePath(repoRoot, "src/a.txt\0")).toThrow(PathJailError);
  });

  it("rejects a symlink inside the repo that points outside it", () => {
    const linkPath = join(repoRoot, "escape-link");
    try {
      symlinkSync(outsideDir, linkPath, "junction");
    } catch {
      return; // symlink/junction creation unavailable in this environment — skip rather than fail
    }
    try {
      expect(() => resolveSafePath(repoRoot, "escape-link/secret.txt")).toThrow(PathJailError);
    } finally {
      rmSync(linkPath, { force: true });
    }
  });
});
