import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findRepoRoot } from "../../src/config/repoPaths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const devAgentRoot = findRepoRoot(__dirname);
const cliPath = join(devAgentRoot, "harness", "dist", "cli.js");
const pythonCmd = process.env.DEVAGENT_PYTHON || "python";

interface CliRunResult {
  code: number | null;
  stdout: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv, stdinText: string): Promise<CliRunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, DEVAGENT_PYTHON: pythonCmd, ...env },
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("exit", (code) => resolvePromise({ code, stdout }));
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function fakeLlmScript(dir: string, steps: unknown[]): string {
  const scriptPath = join(dir, "responses.json");
  writeFileSync(scriptPath, JSON.stringify(steps));
  return scriptPath;
}

// Real CLI subprocess, real cross-process ask_user/ask_user_response envelope exchange, real
// free-text stdin — same approach as the write/run_command confirmation integration tests.
describe("ask_user (integration, real CLI subprocess)", () => {
  let tempRepo: string | null = null;
  let scriptDir: string | null = null;

  afterEach(() => {
    if (tempRepo) rmSync(tempRepo, { recursive: true, force: true });
    if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
    tempRepo = null;
    scriptDir = null;
  });

  it("prints the question, sends back the typed free-text answer, and continues to a final answer", async () => {
    tempRepo = mkdtempSync(join(tmpdir(), "devagent-ask-"));
    scriptDir = mkdtempSync(join(tmpdir(), "devagent-fake-llm-"));
    const scriptPath = fakeLlmScript(scriptDir, [
      { tool_call: { name: "ask_user", args: { question: "Tabs or spaces?" } } },
      { text: "Using spaces, as you said." },
    ]);

    const { code, stdout } = await runCli(
      ["run", "set up formatting", "--repo", tempRepo],
      { DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
      "spaces please\n",
    );

    expect(code).toBe(0);
    expect(stdout).toContain("DevAgent asks: Tabs or spaces?");
    expect(stdout).toContain("DevAgent: Using spaces, as you said.");
  }, 20000);

  it("sends back an empty answer, not a hang, when nothing is typed", async () => {
    tempRepo = mkdtempSync(join(tmpdir(), "devagent-ask-empty-"));
    scriptDir = mkdtempSync(join(tmpdir(), "devagent-fake-llm-"));
    const scriptPath = fakeLlmScript(scriptDir, [
      { tool_call: { name: "ask_user", args: { question: "Anything to add?" } } },
      { text: "OK, proceeding with defaults." },
    ]);

    const { code, stdout } = await runCli(
      ["run", "do the thing", "--repo", tempRepo],
      { DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
      "", // stdin closes immediately with no answer
    );

    expect(code).toBe(0);
    expect(stdout).toContain("DevAgent: OK, proceeding with defaults.");
  }, 20000);

  it("never asks for confirmation for ask_user itself, even without --yolo", async () => {
    // ask_user is not a write/run_command-style risky action — it should never go through the
    // y/N confirmation gate, only its own free-text prompt.
    tempRepo = mkdtempSync(join(tmpdir(), "devagent-ask-noconfirm-"));
    scriptDir = mkdtempSync(join(tmpdir(), "devagent-fake-llm-"));
    const scriptPath = fakeLlmScript(scriptDir, [
      { tool_call: { name: "ask_user", args: { question: "Which file?" } } },
      { text: "Got it." },
    ]);

    const { code, stdout } = await runCli(
      ["run", "pick a file", "--repo", tempRepo],
      { DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
      "main.js\n",
    );

    expect(code).toBe(0);
    expect(stdout).not.toContain("[y/N]");
    expect(stdout).toContain("DevAgent: Got it.");
  }, 20000);
});
