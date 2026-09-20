import { describe, it, expect } from "vitest";
import { isCommandAllowed, findSuspiciousArg } from "../../src/tools/commandAllowlist.js";

describe("isCommandAllowed", () => {
  it("allows npm test and npm run <anything>", () => {
    expect(isCommandAllowed("npm", ["test"])).toBe(true);
    expect(isCommandAllowed("npm", ["run", "build"])).toBe(true);
    expect(isCommandAllowed("npm", ["run", "some-custom-script"])).toBe(true);
  });

  it("rejects npm install and other npm subcommands", () => {
    expect(isCommandAllowed("npm", ["install"])).toBe(false);
    expect(isCommandAllowed("npm", ["publish"])).toBe(false);
    expect(isCommandAllowed("npm", [])).toBe(false);
  });

  it("allows pytest and node with any arguments", () => {
    expect(isCommandAllowed("pytest", ["-k", "test_foo", "-x"])).toBe(true);
    expect(isCommandAllowed("node", ["script.js", "--flag"])).toBe(true);
  });

  it("only allows python -m pytest, not arbitrary python invocations", () => {
    expect(isCommandAllowed("python", ["-m", "pytest"])).toBe(true);
    expect(isCommandAllowed("python", ["-m", "pytest", "tests/"])).toBe(true);
    expect(isCommandAllowed("python", ["-c", "import os; os.system('rm -rf /')"])).toBe(false);
    expect(isCommandAllowed("python", ["-m", "http.server"])).toBe(false);
  });

  it("only allows read-only git subcommands", () => {
    expect(isCommandAllowed("git", ["status"])).toBe(true);
    expect(isCommandAllowed("git", ["diff"])).toBe(true);
    expect(isCommandAllowed("git", ["log", "-n", "5"])).toBe(true);
    expect(isCommandAllowed("git", ["push"])).toBe(false);
    expect(isCommandAllowed("git", ["reset", "--hard"])).toBe(false);
    expect(isCommandAllowed("git", ["commit", "-m", "x"])).toBe(false);
  });

  it("rejects any command not on the list at all", () => {
    expect(isCommandAllowed("curl", ["http://example.com"])).toBe(false);
    expect(isCommandAllowed("rm", ["-rf", "/"])).toBe(false);
    expect(isCommandAllowed("bash", ["-c", "echo hi"])).toBe(false);
  });
});

describe("findSuspiciousArg", () => {
  it("flags a '..' path segment", () => {
    expect(findSuspiciousArg(["--config", "../../secrets.json"])).toBe("../../secrets.json");
  });

  it("flags an absolute POSIX-looking path", () => {
    expect(findSuspiciousArg(["/etc/passwd"])).toBe("/etc/passwd");
  });

  it("flags a Windows drive-letter path", () => {
    expect(findSuspiciousArg(["C:\\Windows\\System32"])).toBe("C:\\Windows\\System32");
  });

  it("flags a UNC path", () => {
    expect(findSuspiciousArg(["\\\\server\\share"])).toBe("\\\\server\\share");
  });

  it("returns null for ordinary flags and relative paths", () => {
    expect(findSuspiciousArg(["run", "build", "--watch=false", "src/index.ts"])).toBeNull();
  });
});
