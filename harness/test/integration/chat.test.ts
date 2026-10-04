import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findRepoRoot } from "../../src/config/repoPaths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(findRepoRoot(__dirname), "harness", "dist", "cli.js");
const pythonCmd = process.env.DEVAGENT_PYTHON || "python";

/** Runs bare `devagent` (the chat REPL) in `cwd`, feeding `input` on stdin. */
function chat(
  cwd: string,
  input: string,
  script: unknown[],
): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "devagent-chat-llm-"));
  const scriptPath = join(dir, "r.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  return new Promise((res) => {
    const c = spawn(process.execPath, [cliPath], {
      cwd,
      env: { ...process.env, DEVAGENT_PYTHON: pythonCmd, DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
    });
    let out = "";
    c.stdout.on("data", (d: Buffer) => (out += d));
    c.stderr.on("data", (d: Buffer) => (out += d));
    const timer = setTimeout(() => {
      c.kill();
      rmSync(dir, { recursive: true, force: true });
      res({ code: null, out, timedOut: true });
    }, 25000);
    c.on("exit", (code) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      res({ code, out, timedOut: false });
    });
    c.stdin.write(input);
    c.stdin.end();
  });
}

describe("interactive chat (integration, real CLI subprocess)", () => {
  it("answers several messages in one session, working in the current directory", async () => {
    const repo = mkdtempSync(join(tmpdir(), "devagent-chat-repo-"));
    try {
      writeFileSync(join(repo, "a.txt"), "hello file\n");
      const r = await chat(repo, "hi\nwhat is in a.txt?\n/exit\n", [
        { text: "Hello there." },
        { tool_call: { name: "read_file", args: { path: "a.txt" } } },
        { text: "It says hello file." },
      ]);
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Hello there.");
      expect(r.out).toContain("It says hello file.");
      expect(r.out).toContain("read_file");
      expect(r.out).toContain(repo); // banner shows the working directory
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 40000);

  it("exits cleanly when stdin closes, with no /exit", async () => {
    const repo = mkdtempSync(join(tmpdir(), "devagent-chat-eof-"));
    try {
      const r = await chat(repo, "hi\n", [{ text: "Hi." }]);
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
      expect(r.out).toContain("bye");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 40000);

  it("confirms a write mid-chat and applies it when approved, on the same stdin as the prompt", async () => {
    const repo = mkdtempSync(join(tmpdir(), "devagent-chat-write-"));
    try {
      writeFileSync(join(repo, "a.txt"), "foo bar\n");
      const r = await chat(repo, "change bar to baz\ny\n/exit\n", [
        { tool_call: { name: "apply_patch", args: { path: "a.txt", old_string: "bar", new_string: "baz" } } },
        { text: "Done." },
      ]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Apply this apply_patch to a.txt?");
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("foo baz\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 40000);

  it("/yolo turns confirmations off for later messages", async () => {
    const repo = mkdtempSync(join(tmpdir(), "devagent-chat-yolo-"));
    try {
      writeFileSync(join(repo, "a.txt"), "foo bar\n");
      const r = await chat(repo, "/yolo\nchange bar to baz\n/exit\n", [
        { tool_call: { name: "apply_patch", args: { path: "a.txt", old_string: "bar", new_string: "baz" } } },
        { text: "Done." },
      ]);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("[y/N]");
      expect(r.out).toContain("auto-approve");
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("foo baz\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 40000);

  it("handles slash commands without sending them to the agent", async () => {
    const repo = mkdtempSync(join(tmpdir(), "devagent-chat-slash-"));
    try {
      const r = await chat(repo, "/help\n/bogus\n/status\n/exit\n", []);
      expect(r.code).toBe(0);
      expect(r.out).toContain("/yolo");
      expect(r.out).toContain("Unknown command /bogus");
      expect(r.out).toContain("history: 0 message(s)");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 40000);
});
