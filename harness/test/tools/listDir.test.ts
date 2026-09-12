import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listDir } from "../../src/tools/listDir.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "fixtures", "sample-repo");

describe("listDir", () => {
  it("lists the repo root, dirs before files, alphabetical within each group", async () => {
    const result = await listDir(repoRoot, { path: "." });
    const names = result.entries.map((e) => `${e.type}:${e.name}`);
    expect(names).toEqual(["dir:node_modules", "dir:src", "file:README.md"]);
  });

  it("lists a subdirectory, dirs before files", async () => {
    const result = await listDir(repoRoot, { path: "src" });
    expect(result.entries.map((e) => e.name)).toEqual(["utils", "index.ts"]);
  });

  it("throws not_found for a missing directory", async () => {
    await expect(listDir(repoRoot, { path: "no/such/dir" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("throws not_a_directory when given a file", async () => {
    await expect(listDir(repoRoot, { path: "README.md" })).rejects.toMatchObject({ code: "not_a_directory" });
  });
});
