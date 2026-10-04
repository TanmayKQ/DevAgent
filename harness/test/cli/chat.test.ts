import { describe, it, expect } from "vitest";
import { trimHistory } from "../../src/cli/chat.js";

describe("trimHistory", () => {
  it("keeps only the most recent turns", () => {
    const h = Array.from({ length: 12 }, (_, i) => ({ user: `u${i}`, assistant: `a${i}` }));
    const out = trimHistory(h);
    expect(out).toHaveLength(8);
    expect(out[0].user).toBe("u4");
    expect(out[7].user).toBe("u11");
  });

  it("clips very long assistant answers", () => {
    const out = trimHistory([{ user: "q", assistant: "x".repeat(5000) }]);
    expect(out[0].assistant.length).toBeLessThan(1600);
    expect(out[0].assistant.endsWith("…")).toBe(true);
  });

  it("leaves short history untouched", () => {
    expect(trimHistory([{ user: "q", assistant: "a" }])).toEqual([{ user: "q", assistant: "a" }]);
  });
});
