import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initToolRegistry, executeToolCall } from "../../src/tools/registry.js";
import { findRepoRoot } from "../../src/config/repoPaths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "fixtures", "sample-repo");

beforeAll(() => {
  const devAgentRoot = findRepoRoot(__dirname);
  initToolRegistry(join(devAgentRoot, "schemas"));
});

describe("executeToolCall", () => {
  it("dispatches a valid read_file call", async () => {
    const result = await executeToolCall(repoRoot, { call_id: "c1", name: "read_file", arguments: { path: "README.md" } });
    expect(result.ok).toBe(true);
    expect(result.call_id).toBe("c1");
    expect((result.result as { content: string }).content).toContain("Sample Repo");
  });

  it("returns ok:false with unknown_tool for an unregistered tool name", async () => {
    const result = await executeToolCall(repoRoot, { call_id: "c2", name: "delete_everything", arguments: {} });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unknown_tool");
  });

  it("returns ok:false with invalid_arguments when required arguments are missing", async () => {
    const result = await executeToolCall(repoRoot, { call_id: "c3", name: "read_file", arguments: {} });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_arguments");
  });

  it("returns ok:false with invalid_arguments for an unexpected extra argument", async () => {
    const result = await executeToolCall(repoRoot, {
      call_id: "c4",
      name: "list_dir",
      arguments: { path: ".", rm: "-rf /" },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_arguments");
  });

  it("turns a path-jail violation into a well-formed error result instead of throwing", async () => {
    const result = await executeToolCall(repoRoot, {
      call_id: "c5",
      name: "read_file",
      arguments: { path: "../../../etc/passwd" },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("path_jail_violation");
  });

  it("turns a tool execution error (not_found) into a well-formed error result", async () => {
    const result = await executeToolCall(repoRoot, {
      call_id: "c6",
      name: "read_file",
      arguments: { path: "nope.txt" },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("not_found");
  });
});
