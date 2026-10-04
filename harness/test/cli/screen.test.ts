import { describe, it, expect } from "vitest";
import { Screen, CLEAR_SCREEN, type ScreenOutput } from "../../src/cli/screen.js";

function fakeOut(columns: number): ScreenOutput & { written: string[]; columns: number } {
  const written: string[] = [];
  return { written, columns, write: (c: string) => written.push(c) };
}

describe("Screen", () => {
  it("writes and remembers printed text", () => {
    const out = fakeOut(40);
    const s = new Screen(out);
    s.print("hello");
    expect(out.written.join("")).toBe("hello\n");
    expect(s.blockCount).toBe(1);
  });

  it("draws a rule at the current width", () => {
    const out = fakeOut(30);
    new Screen(out).rule();
    expect(out.written.join("")).toBe("─".repeat(30) + "\n");
  });

  it("caps rule width and has a sane minimum", () => {
    const wide = fakeOut(500);
    new Screen(wide).rule();
    expect(wide.written.join("").trim().length).toBe(100);
    const none = { written: [] as string[], write(c: string) { this.written.push(c); } };
    new Screen(none).rule(); // columns undefined -> 80
    expect(none.written.join("").trim().length).toBe(80);
  });

  it("redraw clears the screen and resizes rules to the NEW width, leaving text as-is", () => {
    const out = fakeOut(20);
    const s = new Screen(out);
    s.print("DevAgent");
    s.rule();
    s.print("> hi");
    s.rule();
    out.written.length = 0;

    out.columns = 60; // the window was resized
    s.redraw();

    const drawn = out.written.join("");
    expect(drawn.startsWith(CLEAR_SCREEN)).toBe(true);
    expect(drawn).toBe(`${CLEAR_SCREEN}DevAgent\n${"─".repeat(60)}\n> hi\n${"─".repeat(60)}\n`);
  });

  it("records already-echoed text without writing it again, and includes it on redraw", () => {
    const out = fakeOut(20);
    const s = new Screen(out);
    s.record("> typed by the user");
    expect(out.written).toHaveLength(0);
    s.redraw();
    expect(out.written.join("")).toContain("> typed by the user\n");
  });

  it("bounds memory for very long sessions", () => {
    const s = new Screen(fakeOut(20));
    for (let i = 0; i < 3500; i++) s.record(`line ${i}`);
    expect(s.blockCount).toBe(3000);
  });
});
