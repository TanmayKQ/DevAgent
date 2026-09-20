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
    // Written all at once, immediately followed by end() — this is what reproduces both
    // answers arriving in a single stdin chunk, which is exactly what broke confirm() before.
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

// Regression coverage for the bug found running a real two-step task by hand: write a file,
// then run it. Each step needs its own confirmation, and the second one was silently getting
// auto-declined because the confirmation prompt's implementation couldn't correctly read a
// second answer once the first had already been consumed from the same piped input. See
// confirm.ts and confirm.test.ts for the root cause and the unit-level regression test; this
// proves the fix holds through the real CLI, the real graph loop, and two distinct tool types.
describe("multiple confirmable tool calls in one task run (integration, real CLI subprocess)", () => {
  let tempRepo: string | null = null;
  let scriptDir: string | null = null;

  afterEach(() => {
    if (tempRepo) rmSync(tempRepo, { recursive: true, force: true });
    if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
    tempRepo = null;
    scriptDir = null;
  });

  it("answers a write_file confirmation and a later run_command confirmation independently, both approved", async () => {
    tempRepo = mkdtempSync(join(tmpdir(), "devagent-multi-yy-"));
    scriptDir = mkdtempSync(join(tmpdir(), "devagent-fake-llm-"));
    const scriptPath = join(scriptDir, "responses.json");
    writeFileSync(
      scriptPath,
      JSON.stringify([
        { tool_call: { name: "write_file", args: { path: "check.js", content: "console.log('ok')" } } },
        { tool_call: { name: "run_command", args: { command: "node", args: ["check.js"] } } },
        { text: "Wrote and ran check.js." },
      ]),
    );

    const { code, stdout } = await runCli(
      ["run", "write a script and run it", "--repo", tempRepo],
      { DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
      "y\ny\n",
    );

    expect(code).toBe(0);
    expect(existsSync(join(tempRepo, "check.js"))).toBe(true);
    expect(stdout).toContain("Apply this write_file to check.js?");
    expect(stdout).toContain("DevAgent wants to run: node check.js");
    expect(stdout).toContain("exit code: 0"); // proves run_command actually executed, not declined
    expect(stdout).toContain("DevAgent: Wrote and ran check.js.");
  }, 20000);

  it("approves the first confirmation and declines the second, independently", async () => {
    tempRepo = mkdtempSync(join(tmpdir(), "devagent-multi-yn-"));
    scriptDir = mkdtempSync(join(tmpdir(), "devagent-fake-llm-"));
    const scriptPath = join(scriptDir, "responses.json");
    const markerFile = join(tempRepo, "marker.txt");
    writeFileSync(
      scriptPath,
      JSON.stringify([
        { tool_call: { name: "write_file", args: { path: "check.js", content: "console.log('ok')" } } },
        {
          tool_call: {
            name: "run_command",
            args: { command: "node", args: ["-e", `require('fs').writeFileSync(${JSON.stringify(markerFile)}, 'x')`] },
          },
        },
        { text: "Wrote check.js but did not run the second command." },
      ]),
    );

    const { code, stdout } = await runCli(
      ["run", "write a script and run it", "--repo", tempRepo],
      { DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
      "y\nn\n",
    );

    expect(code).toBe(0);
    expect(existsSync(join(tempRepo, "check.js"))).toBe(true); // first approval took effect
    expect(existsSync(markerFile)).toBe(false); // second decline took effect — command never ran
    expect(stdout).toContain("DevAgent: Wrote check.js but did not run the second command.");
  }, 20000);
});
