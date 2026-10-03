import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findRepoRoot } from "../../src/config/repoPaths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = findRepoRoot(__dirname);
const cliPath = join(root, "harness", "dist", "cli.js");
const pythonCmd = process.env.DEVAGENT_PYTHON || "python";

function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const c = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, DEVAGENT_PYTHON: pythonCmd, ...env } });
    let out = "";
    c.stdout.on("data", (d: Buffer) => (out += d));
    c.stderr.on("data", (d: Buffer) => (out += d));
    c.on("exit", (code) => res({ code, out }));
    c.stdin.end();
  });
}

describe("audit log replay (integration)", () => {
  it("records a full session and replays it as a readable transcript", async () => {
    const repo = mkdtempSync(join(tmpdir(), "devagent-replay-"));
    const dir = mkdtempSync(join(tmpdir(), "devagent-replay-llm-"));
    try {
      writeFileSync(join(repo, "a.txt"), "hello\n");
      const script = join(dir, "r.json");
      writeFileSync(
        script,
        JSON.stringify([{ tool_call: { name: "read_file", args: { path: "a.txt" } } }, { text: "It says hello." }]),
      );
      const run = await cli(["run", "what is in a.txt", "--repo", repo], { DEVAGENT_FAKE_LLM_RESPONSES: script });
      expect(run.code).toBe(0);
      const id = run.out.match(/session ([0-9a-f-]{36})/)?.[1];
      expect(id).toBeTruthy();

      const replay = await cli(["replay", id!]);
      expect(replay.code).toBe(0);
      expect(replay.out).toContain("TASK: what is in a.txt");
      expect(replay.out).toContain("-> read_file");
      expect(replay.out).toContain("<- ok");
      expect(replay.out).toContain("FINAL ANSWER: It says hello.");
      expect(replay.out).toContain("(session start)");
      expect(replay.out).toContain("(session end)");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("fails cleanly for an unknown session", async () => {
    const r = await cli(["replay", "00000000-0000-0000-0000-000000000000"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no such session log");
  }, 15000);
});
