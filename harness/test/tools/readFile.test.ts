import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "../../src/tools/readFile.js";
import { ToolExecutionError } from "../../src/tools/errors.js";
import { PathJailError } from "../../src/tools/pathJail.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "fixtures", "sample-repo");

describe("readFile", () => {
  it("reads an existing text file", async () => {
    const result = await readFile(repoRoot, { path: "src/index.ts" });
    expect(result.content).toContain("GREETING");
    expect(result.truncated).toBe(false);
  });

  it("throws not_found for a missing file", async () => {
    await expect(readFile(repoRoot, { path: "does/not/exist.ts" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("throws is_a_directory when given a directory", async () => {
    await expect(readFile(repoRoot, { path: "src" })).rejects.toMatchObject({ code: "is_a_directory" });
  });

  it("throws PathJailError for a traversal attempt", async () => {
    await expect(readFile(repoRoot, { path: "../../../etc/passwd" })).rejects.toBeInstanceOf(PathJailError);
  });

  it("rejects/is-a-directory errors are ToolExecutionError instances", async () => {
    try {
      await readFile(repoRoot, { path: "src" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError);
    }
  });
});
