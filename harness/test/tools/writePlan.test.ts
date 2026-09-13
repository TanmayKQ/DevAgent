import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planWriteFile, planApplyPatch, commitWrite } from "../../src/tools/writePlan.js";
import { ToolExecutionError } from "../../src/tools/errors.js";
import { PathJailError } from "../../src/tools/pathJail.js";

let repoRoot: string;

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "devagent-write-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.txt"), "line1\nline2\nline3\n");
  return dir;
}

afterEach(() => {
  if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
});

describe("planWriteFile / commitWrite", () => {
  it("plans creation of a brand-new file (oldContent null)", () => {
    repoRoot = freshRepo();
    const plan = planWriteFile(repoRoot, { path: "src/new.txt", content: "hello\n" });
    expect(plan.oldContent).toBeNull();
    expect(plan.newContent).toBe("hello\n");
    expect(existsSync(join(repoRoot, "src", "new.txt"))).toBe(false); // plan doesn't write

    const result = commitWrite(plan);
    expect(result.created).toBe(true);
    expect(readFileSync(join(repoRoot, "src", "new.txt"), "utf8")).toBe("hello\n");
  });

  it("plans overwriting an existing file (oldContent populated)", () => {
    repoRoot = freshRepo();
    const plan = planWriteFile(repoRoot, { path: "src/a.txt", content: "replaced\n" });
    expect(plan.oldContent).toBe("line1\nline2\nline3\n");

    const result = commitWrite(plan);
    expect(result.created).toBe(false);
    expect(readFileSync(join(repoRoot, "src", "a.txt"), "utf8")).toBe("replaced\n");
  });

  it("creates parent directories that don't exist yet", () => {
    repoRoot = freshRepo();
    commitWrite(planWriteFile(repoRoot, { path: "deep/nested/dir/file.txt", content: "x" }));
    expect(readFileSync(join(repoRoot, "deep", "nested", "dir", "file.txt"), "utf8")).toBe("x");
  });

  it("rejects content over the size cap", () => {
    repoRoot = freshRepo();
    const big = "x".repeat(6 * 1024 * 1024);
    expect(() => planWriteFile(repoRoot, { path: "big.txt", content: big })).toThrow(ToolExecutionError);
  });

  it("rejects a path-jail escape", () => {
    repoRoot = freshRepo();
    expect(() => planWriteFile(repoRoot, { path: "../outside.txt", content: "x" })).toThrow(PathJailError);
  });
});

describe("planApplyPatch / commitWrite", () => {
  it("replaces a unique match", () => {
    repoRoot = freshRepo();
    const plan = planApplyPatch(repoRoot, { path: "src/a.txt", old_string: "line2", new_string: "LINE2" });
    expect(plan.newContent).toBe("line1\nLINE2\nline3\n");
    expect(plan.replacements).toBe(1);
    commitWrite(plan);
    expect(readFileSync(join(repoRoot, "src", "a.txt"), "utf8")).toBe("line1\nLINE2\nline3\n");
  });

  it("throws not_found for a file that doesn't exist", () => {
    repoRoot = freshRepo();
    expect.assertions(1);
    try {
      planApplyPatch(repoRoot, { path: "src/missing.txt", old_string: "x", new_string: "y" });
    } catch (err) {
      expect((err as ToolExecutionError).code).toBe("not_found");
    }
  });

  it("throws no_match when old_string isn't present", () => {
    repoRoot = freshRepo();
    expect.assertions(1);
    try {
      planApplyPatch(repoRoot, { path: "src/a.txt", old_string: "nope", new_string: "y" });
    } catch (err) {
      expect((err as ToolExecutionError).code).toBe("no_match");
    }
  });

  it("throws ambiguous_match when old_string appears more than once and replace_all is not set", () => {
    repoRoot = freshRepo();
    writeFileSync(join(repoRoot, "src", "dup.txt"), "foo\nfoo\n");
    expect.assertions(1);
    try {
      planApplyPatch(repoRoot, { path: "src/dup.txt", old_string: "foo", new_string: "bar" });
    } catch (err) {
      expect((err as ToolExecutionError).code).toBe("ambiguous_match");
    }
  });

  it("replaces every occurrence when replace_all is true", () => {
    repoRoot = freshRepo();
    writeFileSync(join(repoRoot, "src", "dup.txt"), "foo\nfoo\n");
    const plan = planApplyPatch(repoRoot, {
      path: "src/dup.txt",
      old_string: "foo",
      new_string: "bar",
      replace_all: true,
    });
    expect(plan.newContent).toBe("bar\nbar\n");
    expect(plan.replacements).toBe(2);
  });

  it("allows deleting text via an empty new_string", () => {
    repoRoot = freshRepo();
    const plan = planApplyPatch(repoRoot, { path: "src/a.txt", old_string: "line2\n", new_string: "" });
    expect(plan.newContent).toBe("line1\nline3\n");
  });
});
