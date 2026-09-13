import { describe, it, expect } from "vitest";
import { Readable, Writable } from "node:stream";
import { confirm } from "../../src/cli/confirm.js";

function inputOf(text: string): Readable {
  return Readable.from([text]);
}

function discardOutput(): Writable {
  return new Writable({
    write(_chunk, _enc, callback) {
      callback();
    },
  });
}

describe("confirm", () => {
  it("resolves true for 'y'", async () => {
    expect(await confirm("? ", inputOf("y\n"), discardOutput())).toBe(true);
  });

  it("resolves true for 'yes', case-insensitively", async () => {
    expect(await confirm("? ", inputOf("YES\n"), discardOutput())).toBe(true);
  });

  it("resolves false for 'n'", async () => {
    expect(await confirm("? ", inputOf("n\n"), discardOutput())).toBe(false);
  });

  it("resolves false for empty input (just Enter)", async () => {
    expect(await confirm("? ", inputOf("\n"), discardOutput())).toBe(false);
  });

  it("resolves false for unrecognized input", async () => {
    expect(await confirm("? ", inputOf("sure I guess\n"), discardOutput())).toBe(false);
  });

  it("resolves false when the input stream closes with no answer", async () => {
    expect(await confirm("? ", inputOf(""), discardOutput())).toBe(false);
  });
});
