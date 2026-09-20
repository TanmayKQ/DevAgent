import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/tools/runCommand.js";

let repoRoot: string;

afterEach(() => {
  if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
});

describe("runCommand", () => {
  it("captures stdout and a zero exit code on success", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "devagent-run-"));
    const result = await runCommand(repoRoot, { command: "node", args: ["-e", "console.log('hello')"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  it("captures a non-zero exit code and stderr without treating it as a tool failure", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "devagent-run-"));
    const result = await runCommand(repoRoot, {
      command: "node",
      args: ["-e", "console.error('boom'); process.exit(3)"],
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr.trim()).toBe("boom");
  });

  it("does not leak the harness's own environment variables to the child", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "devagent-run-"));
    process.env.DEVAGENT_TEST_CANARY = "should-not-leak";
    try {
      const result = await runCommand(repoRoot, {
        command: "node",
        args: ["-e", "console.log(process.env.DEVAGENT_TEST_CANARY || 'MISSING')"],
      });
      expect(result.stdout.trim()).toBe("MISSING");
    } finally {
      delete process.env.DEVAGENT_TEST_CANARY;
    }
  });

  it("truncates output past the cap instead of buffering it unbounded", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "devagent-run-"));
    const result = await runCommand(repoRoot, {
      command: "node",
      args: ["-e", "process.stdout.write('x'.repeat(300000))"],
    });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(256 * 1024);
  });

  it("kills a hanging command once the timeout elapses", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "devagent-run-"));
    const start = Date.now();
    const result = await runCommand(repoRoot, { command: "node", args: ["-e", "setTimeout(() => {}, 30000)"] }, 1500);
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(10000); // proves it was actually killed, not left to run the full 30s
  }, 15000);

  it("rejects a disallowed command before ever spawning anything", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "devagent-run-"));
    await expect(runCommand(repoRoot, { command: "curl", args: ["http://example.com"] })).rejects.toMatchObject({
      code: "command_not_allowed",
    });
  });
});
