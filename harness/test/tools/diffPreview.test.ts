import { describe, it, expect } from "vitest";
import { buildDiffPreview } from "../../src/tools/diffPreview.js";
import type { WritePlan } from "../../src/tools/writePlan.js";

describe("buildDiffPreview", () => {
  it("renders a unified diff for an edit to an existing file", () => {
    const plan: WritePlan = {
      toolName: "apply_patch",
      relPath: "src/a.txt",
      safePath: "/fake/src/a.txt",
      oldContent: "line1\nline2\nline3\n",
      newContent: "line1\nLINE2\nline3\n",
      replacements: 1,
    };
    const diff = buildDiffPreview(plan);
    expect(diff).toContain("a/src/a.txt");
    expect(diff).toContain("b/src/a.txt");
    expect(diff).toContain("-line2");
    expect(diff).toContain("+LINE2");
  });

  it("renders a new-file diff (against /dev/null) when oldContent is null", () => {
    const plan: WritePlan = {
      toolName: "write_file",
      relPath: "src/new.txt",
      safePath: "/fake/src/new.txt",
      oldContent: null,
      newContent: "hello\n",
    };
    const diff = buildDiffPreview(plan);
    expect(diff).toContain("/dev/null");
    expect(diff).toContain("+hello");
  });
});
