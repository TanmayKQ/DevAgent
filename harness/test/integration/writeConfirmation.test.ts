import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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

// Drives the actual built `devagent` binary as a real subprocess (not internal modules), so
// this exercises the exact interactive experience a user gets: the diff preview printed to
// stdout and the y/N prompt read from stdin. DEVAGENT_FAKE_LLM_RESPONSES keeps it key-free.
describe("write confirmation gate (integration, real CLI subprocess)", () => {
  let tempRepo: string | null = null;
  let scriptDir: string | null = null;

  afterEach(() => {
    if (tempRepo) rmSync(tempRepo, { recursive: true, force: true });
    if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
    tempRepo = null;
    scriptDir = null;
  });

  it("applies the patch when the user approves", async () => {
    tempRepo = mkdtempSync(join(tmpdir(), "devagent-confirm-yes-"));
    writeFileSync(join(tempRepo, "a.txt"), "foo bar\n");

    scriptDir = mkdtempSync(join(tmpdir(), "devagent-fake-llm-"));
    const scriptPath = join(scriptDir, "responses.json");
    writeFileSync(
      scriptPath,
      JSON.stringify([
        { tool_call: { name: "apply_patch", args: { path: "a.txt", old_string: "bar", new_string: "baz" } } },
        { text: "Updated a.txt." },
      ]),
    );

    const { code, stdout } = await runCli(
      ["run", "change bar to baz", "--repo", tempRepo],
      { DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
      "y\n",
    );

    expect(code).toBe(0);
    expect(stdout).toContain("-foo bar");
    expect(stdout).toContain("+foo baz");
    expect(stdout).toContain("Apply this apply_patch to a.txt?");
    expect(stdout).toContain("DevAgent: Updated a.txt.");
    expect(readFileSync(join(tempRepo, "a.txt"), "utf8")).toBe("foo baz\n");
  }, 20000);

  it("leaves the file untouched and reports rejection when the user declines", async () => {
    tempRepo = mkdtempSync(join(tmpdir(), "devagent-confirm-no-"));
    writeFileSync(join(tempRepo, "a.txt"), "foo bar\n");

    scriptDir = mkdtempSync(join(tmpdir(), "devagent-fake-llm-"));
    const scriptPath = join(scriptDir, "responses.json");
    writeFileSync(
      scriptPath,
      JSON.stringify([
        { tool_call: { name: "apply_patch", args: { path: "a.txt", old_string: "bar", new_string: "baz" } } },
        { text: "OK, I left the file as-is." },
      ]),
    );

    const { code, stdout } = await runCli(
      ["run", "change bar to baz", "--repo", tempRepo],
      { DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
      "n\n",
    );

    expect(code).toBe(0);
    expect(stdout).toContain("declined");
    expect(stdout).toContain("DevAgent: OK, I left the file as-is.");
    expect(readFileSync(join(tempRepo, "a.txt"), "utf8")).toBe("foo bar\n");
  }, 20000);

  it("skips the prompt but still writes and still shows the diff under --yolo", async () => {
    tempRepo = mkdtempSync(join(tmpdir(), "devagent-confirm-yolo-"));
    writeFileSync(join(tempRepo, "a.txt"), "foo bar\n");

    scriptDir = mkdtempSync(join(tmpdir(), "devagent-fake-llm-"));
    const scriptPath = join(scriptDir, "responses.json");
    writeFileSync(
      scriptPath,
      JSON.stringify([
        { tool_call: { name: "apply_patch", args: { path: "a.txt", old_string: "bar", new_string: "baz" } } },
        { text: "Updated a.txt." },
      ]),
    );

    // No stdin answer at all — --yolo must not depend on it.
    const { code, stdout } = await runCli(
      ["run", "change bar to baz", "--repo", tempRepo, "--yolo"],
      { DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
      "",
    );

    expect(code).toBe(0);
    expect(stdout).toContain("+foo baz");
    expect(readFileSync(join(tempRepo, "a.txt"), "utf8")).toBe("foo baz\n");
  }, 20000);
});
