import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { searchCode } from "../../src/tools/searchCode.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "fixtures", "sample-repo");

describe("searchCode", () => {
  it("finds a case-insensitive match and skips node_modules", async () => {
    const result = await searchCode(repoRoot, { query: "greeting" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ file: "src/index.ts", line: 1 });
  });

  it("scopes the search to a given subdirectory", async () => {
    const result = await searchCode(repoRoot, { query: "function", path: "src/utils" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].file).toBe("src/utils/math.ts");
  });

  it("returns no matches (not an error) for a query that hits nothing", async () => {
    const result = await searchCode(repoRoot, { query: "nonexistent_token_xyz" });
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("truncates at maxResults", async () => {
    const result = await searchCode(repoRoot, { query: "e", maxResults: 1 });
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});
