import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

// Same real-CLI-subprocess approach as writeConfirmation.test.ts, for run_command instead of
// the file-mutation tools. Uses `node -e ...` as the test command — it's on the real allowlist
// (no test-only backdoor) and needs nothing beyond Node itself, unlike real npm/pytest.
describe("run_command confirmation gate (integration, real CLI subprocess)", () => {
  let tempRepo: string | null = null;
  let scriptDir: string | null = null;

  afterEach(() => {
    if (tempRepo) rmSync(tempRepo, { recursive: true, force: true });
    if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
    tempRepo = null;
    scriptDir = null;
  });

  it("runs the command and reports its output when the user approves", async () => {
    tempRepo = mkdtempSync(join(tmpdir(), "devagent-cmd-yes-"));
    scriptDir = mkdtempSync(join(tmpdir(), "devagent-fake-llm-"));
    const scriptPath = fakeLlmScript(scriptDir, [
      { tool_call: { name: "run_command", args: { command: "node", args: ["-e", "console.log('marker-12345')"] } } },
      { text: "Ran the command." },
    ]);

    const { code, stdout } = await runCli(
      ["run", "run a node script", "--repo", tempRepo],
      { DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
      "y\n",
    );

    expect(code).toBe(0);
    expect(stdout).toContain("DevAgent wants to run: node -e console.log('marker-12345')");
    expect(stdout).toContain("exit code: 0");
    expect(stdout).toContain("DevAgent: Ran the command.");
  }, 20000);

  it("does not run the command and reports rejection when the user declines", async () => {
    tempRepo = mkdtempSync(join(tmpdir(), "devagent-cmd-no-"));
    scriptDir = mkdtempSync(join(tmpdir(), "devagent-fake-llm-"));
    const markerFile = join(tempRepo, "marker.txt");
    const scriptPath = fakeLlmScript(scriptDir, [
      {
        tool_call: {
          name: "run_command",
          args: { command: "node", args: ["-e", `require('fs').writeFileSync(${JSON.stringify(markerFile)}, 'x')`] },
        },
      },
      { text: "OK, I did not run it." },
    ]);

    const { code, stdout } = await runCli(
      ["run", "run a node script", "--repo", tempRepo],
      { DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
      "n\n",
    );

    expect(code).toBe(0);
    expect(stdout).toContain("declined");
    expect(stdout).toContain("DevAgent: OK, I did not run it.");
    expect(existsSync(markerFile)).toBe(false); // the command genuinely never ran
  }, 20000);

  it("skips the prompt but still runs and still previews under --yolo", async () => {
    tempRepo = mkdtempSync(join(tmpdir(), "devagent-cmd-yolo-"));
    scriptDir = mkdtempSync(join(tmpdir(), "devagent-fake-llm-"));
    const scriptPath = fakeLlmScript(scriptDir, [
      { tool_call: { name: "run_command", args: { command: "node", args: ["-e", "console.log('ran')"] } } },
      { text: "Ran it." },
    ]);

    const { code, stdout } = await runCli(
      ["run", "run a node script", "--repo", tempRepo, "--yolo"],
      { DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
      "",
    );

    expect(code).toBe(0);
    expect(stdout).toContain("DevAgent wants to run: node -e console.log('ran')");
    expect(stdout).toContain("exit code: 0");
  }, 20000);

  it("rejects a disallowed command before ever prompting, even without --yolo", async () => {
    tempRepo = mkdtempSync(join(tmpdir(), "devagent-cmd-disallowed-"));
    scriptDir = mkdtempSync(join(tmpdir(), "devagent-fake-llm-"));
    const scriptPath = fakeLlmScript(scriptDir, [
      { tool_call: { name: "run_command", args: { command: "curl", args: ["http://example.com"] } } },
      { text: "That command isn't available, so I stopped." },
    ]);

    // No stdin answer — if this were waiting on a prompt, it would hang and the test would
    // time out instead of completing normally.
    const { code, stdout } = await runCli(
      ["run", "fetch something", "--repo", tempRepo],
      { DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
      "",
    );

    expect(code).toBe(0);
    expect(stdout).not.toContain("Proceed?");
    expect(stdout).toContain("is not on the allowed command list");
    expect(stdout).toContain("DevAgent: That command isn't available, so I stopped.");
  }, 20000);
});
