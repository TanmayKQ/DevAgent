import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findRepoRoot } from "../../src/config/repoPaths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(findRepoRoot(__dirname), "harness", "dist", "cli.js");

function runCli(args: string[]): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: process.env });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (out += c));
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ code: null, out, timedOut: true });
    }, 15000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out, timedOut: false });
    });
    child.stdin.end();
  });
}

// Before this was handled, a reasoning loop that died mid-task left the CLI hanging forever.
describe("reasoning-loop crash recovery (integration)", () => {
  it("exits non-zero with a clear message instead of hanging when the Python process dies", async () => {
    const repo = mkdtempSync(join(tmpdir(), "devagent-crash-"));
    try {
      // `node -m ...` is an immediate usage error, i.e. a reasoning loop that dies at startup.
      const r = await runCli(["run", "anything", "--repo", repo, "--python", process.execPath]);
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(1);
      expect(r.out).toContain("exited unexpectedly");
      expect(r.out).toContain("devagent doctor");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20000);

  it("exits non-zero with a clear message when the python command doesn't exist", async () => {
    const repo = mkdtempSync(join(tmpdir(), "devagent-nopy-"));
    try {
      const r = await runCli(["run", "anything", "--repo", repo, "--python", "definitely-not-a-python-binary"]);
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20000);
});
