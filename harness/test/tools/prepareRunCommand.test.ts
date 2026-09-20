import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRunCommand } from "../../src/tools/prepareRunCommand.js";
import { ToolExecutionError } from "../../src/tools/errors.js";
import { PathJailError } from "../../src/tools/pathJail.js";

let repoRoot: string;

afterEach(() => {
  if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
});

describe("prepareRunCommand", () => {
  it("returns a plan for an allowed command, defaulting cwd to the repo root", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "devagent-prep-"));
    const plan = prepareRunCommand(repoRoot, { command: "node", args: ["-v"] });
    expect(plan.command).toBe("node");
    expect(plan.args).toEqual(["-v"]);
    expect(plan.relCwd).toBe(".");
    expect(plan.safeCwd).toBe(repoRoot);
  });

  it("resolves a cwd subdirectory through the repo-root jail", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "devagent-prep-"));
    mkdirSync(join(repoRoot, "sub"));
    const plan = prepareRunCommand(repoRoot, { command: "node", args: [], cwd: "sub" });
    expect(plan.safeCwd).toBe(join(repoRoot, "sub"));
  });

  it("rejects a command not on the allowlist before touching anything", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "devagent-prep-"));
    expect.assertions(1);
    try {
      prepareRunCommand(repoRoot, { command: "curl", args: ["http://example.com"] });
    } catch (err) {
      expect((err as ToolExecutionError).code).toBe("command_not_allowed");
    }
  });

  it("rejects an allowed command with disallowed args (npm install)", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "devagent-prep-"));
    expect.assertions(1);
    try {
      prepareRunCommand(repoRoot, { command: "npm", args: ["install", "left-pad"] });
    } catch (err) {
      expect((err as ToolExecutionError).code).toBe("command_not_allowed");
    }
  });

  it("rejects a suspicious (path-escaping) argument even for an allowed command", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "devagent-prep-"));
    expect.assertions(1);
    try {
      prepareRunCommand(repoRoot, { command: "node", args: ["../../outside.js"] });
    } catch (err) {
      expect((err as ToolExecutionError).code).toBe("suspicious_argument");
    }
  });

  it("rejects a cwd that escapes the repo root", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "devagent-prep-"));
    expect.assertions(1);
    try {
      prepareRunCommand(repoRoot, { command: "node", args: [], cwd: "../../elsewhere" });
    } catch (err) {
      expect(err).toBeInstanceOf(PathJailError);
    }
  });

  it("rejects a cwd that doesn't exist", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "devagent-prep-"));
    expect.assertions(1);
    try {
      prepareRunCommand(repoRoot, { command: "node", args: [], cwd: "no/such/dir" });
    } catch (err) {
      expect((err as ToolExecutionError).code).toBe("not_found");
    }
  });
});
