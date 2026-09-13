import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  initToolRegistry,
  executeToolCall,
  toolRequiresConfirmation,
  validateToolCallArguments,
} from "../../src/tools/registry.js";
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

describe("toolRequiresConfirmation", () => {
  it("is true for write_file and apply_patch", () => {
    expect(toolRequiresConfirmation("write_file")).toBe(true);
    expect(toolRequiresConfirmation("apply_patch")).toBe(true);
  });

  it("is false for the read-only tools and for unknown names", () => {
    expect(toolRequiresConfirmation("read_file")).toBe(false);
    expect(toolRequiresConfirmation("list_dir")).toBe(false);
    expect(toolRequiresConfirmation("search_code")).toBe(false);
    expect(toolRequiresConfirmation("no_such_tool")).toBe(false);
  });
});

describe("validateToolCallArguments", () => {
  it("accepts valid write_file arguments without executing anything", () => {
    const result = validateToolCallArguments({
      call_id: "v1",
      name: "write_file",
      arguments: { path: "a.txt", content: "hi" },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects apply_patch arguments missing new_string", () => {
    const result = validateToolCallArguments({
      call_id: "v2",
      name: "apply_patch",
      arguments: { path: "a.txt", old_string: "x" },
    });
    expect(result.valid).toBe(false);
  });
});

describe("executeToolCall for write-tier tools (mechanical execution, no confirmation)", () => {
  let writableRepo: string;

  afterEach(() => {
    if (writableRepo) rmSync(writableRepo, { recursive: true, force: true });
  });

  it("write_file actually writes through executeToolCall", async () => {
    writableRepo = mkdtempSync(join(tmpdir(), "devagent-registry-write-"));
    const result = await executeToolCall(writableRepo, {
      call_id: "w1",
      name: "write_file",
      arguments: { path: "out.txt", content: "hello" },
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(writableRepo, "out.txt"), "utf8")).toBe("hello");
  });

  it("apply_patch actually edits through executeToolCall", async () => {
    writableRepo = mkdtempSync(join(tmpdir(), "devagent-registry-patch-"));
    mkdirSync(writableRepo, { recursive: true });
    writeFileSync(join(writableRepo, "a.txt"), "foo bar\n");
    const result = await executeToolCall(writableRepo, {
      call_id: "w2",
      name: "apply_patch",
      arguments: { path: "a.txt", old_string: "bar", new_string: "baz" },
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(writableRepo, "a.txt"), "utf8")).toBe("foo baz\n");
  });

  it("apply_patch returns ok:false with no_match instead of throwing", async () => {
    writableRepo = mkdtempSync(join(tmpdir(), "devagent-registry-nomatch-"));
    writeFileSync(join(writableRepo, "a.txt"), "foo\n");
    const result = await executeToolCall(writableRepo, {
      call_id: "w3",
      name: "apply_patch",
      arguments: { path: "a.txt", old_string: "nope", new_string: "x" },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("no_match");
  });
});
