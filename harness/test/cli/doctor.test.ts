import { describe, it, expect } from "vitest";
import { checkNodeVersion, checkApiKey, checkPythonVersion, formatChecks } from "../../src/cli/doctor.js";

describe("doctor checks", () => {
  it("accepts Node 18+ and rejects older", () => {
    expect(checkNodeVersion("v22.1.0").ok).toBe(true);
    expect(checkNodeVersion("v16.20.0").ok).toBe(false);
  });

  it("finds an API key in the environment", () => {
    expect(checkApiKey({ GOOGLE_API_KEY: "abc" }, null).ok).toBe(true);
    expect(checkApiKey({ GEMINI_API_KEY: "abc" }, null).ok).toBe(true);
  });

  it("finds an API key in .env text, including quoted values", () => {
    expect(checkApiKey({}, "GOOGLE_API_KEY=abc123\n").ok).toBe(true);
    expect(checkApiKey({}, 'GOOGLE_API_KEY="abc123"\r\n').ok).toBe(true);
  });

  it("treats an empty or missing key as not set, and never echoes a key", () => {
    expect(checkApiKey({}, "GOOGLE_API_KEY=\n").ok).toBe(false);
    expect(checkApiKey({}, "# GOOGLE_API_KEY=abc\n").ok).toBe(false);
    expect(checkApiKey({}, null).ok).toBe(false);
    expect(JSON.stringify(checkApiKey({ GOOGLE_API_KEY: "SECRET123" }, null))).not.toContain("SECRET123");
  });

  it("checks the Python version", () => {
    expect(checkPythonVersion("3 13\n").ok).toBe(true);
    expect(checkPythonVersion("3 9\n").ok).toBe(false);
    expect(checkPythonVersion(null).ok).toBe(false);
  });

  it("formats failures with a fix hint and a summary line", () => {
    const out = formatChecks([checkApiKey({}, null)]);
    expect(out).toContain("FAIL");
    expect(out).toContain("->");
    expect(out).toContain("1 problem(s) found");
  });
});
