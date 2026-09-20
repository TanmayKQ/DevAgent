import { describe, it, expect } from "vitest";
import { Readable, Writable } from "node:stream";
import { createConfirmChannel } from "../../src/cli/confirm.js";

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

describe("createConfirmChannel", () => {
  it("resolves true for 'y'", async () => {
    const channel = createConfirmChannel(inputOf("y\n"), discardOutput());
    expect(await channel.ask("? ")).toBe(true);
    channel.dispose();
  });

  it("resolves true for 'yes', case-insensitively", async () => {
    const channel = createConfirmChannel(inputOf("YES\n"), discardOutput());
    expect(await channel.ask("? ")).toBe(true);
    channel.dispose();
  });

  it("resolves false for 'n'", async () => {
    const channel = createConfirmChannel(inputOf("n\n"), discardOutput());
    expect(await channel.ask("? ")).toBe(false);
    channel.dispose();
  });

  it("resolves false for empty input (just Enter)", async () => {
    const channel = createConfirmChannel(inputOf("\n"), discardOutput());
    expect(await channel.ask("? ")).toBe(false);
    channel.dispose();
  });

  it("resolves false for unrecognized input", async () => {
    const channel = createConfirmChannel(inputOf("sure I guess\n"), discardOutput());
    expect(await channel.ask("? ")).toBe(false);
    channel.dispose();
  });

  it("resolves false when the input stream closes with no answer", async () => {
    const channel = createConfirmChannel(inputOf(""), discardOutput());
    expect(await channel.ask("? ")).toBe(false);
    channel.dispose();
  });

  it("resolves false for a second question when the stream had only one answer", async () => {
    const channel = createConfirmChannel(inputOf("y\n"), discardOutput());
    expect(await channel.ask("first? ")).toBe(true);
    expect(await channel.ask("second? ")).toBe(false);
    channel.dispose();
  });

  it("regression: answers two sequential questions correctly when both arrive in one chunk", async () => {
    // This is exactly what piped/scripted input looks like (e.g. `printf "y\ny\n" | devagent ...`
    // for a task with two confirmable tool calls) — both lines land in a single stream chunk
    // before either question has been asked. node:readline's Interface handled this incorrectly
    // (see confirm.ts's doc comment) — this is the reproduction that proved it and now guards
    // against a regression.
    const channel = createConfirmChannel(inputOf("y\nn\n"), discardOutput());
    expect(await channel.ask("first? ")).toBe(true);
    expect(await channel.ask("second? ")).toBe(false);
    channel.dispose();
  });

  it("writes the question text to the output stream", async () => {
    const written: string[] = [];
    const output = new Writable({
      write(chunk, _enc, callback) {
        written.push(chunk.toString());
        callback();
      },
    });
    const channel = createConfirmChannel(inputOf("y\n"), output);
    await channel.ask("Proceed? [y/N] ");
    expect(written.join("")).toContain("Proceed? [y/N] ");
    channel.dispose();
  });

  describe("askText", () => {
    it("resolves with the raw line typed back, not just true/false", async () => {
      const channel = createConfirmChannel(inputOf("use spaces please\n"), discardOutput());
      expect(await channel.askText("> ")).toBe("use spaces please");
      channel.dispose();
    });

    it("resolves with an empty string when the stream closes with no answer", async () => {
      const channel = createConfirmChannel(inputOf(""), discardOutput());
      expect(await channel.askText("> ")).toBe("");
      channel.dispose();
    });

    it("shares the reader with ask() — a mix of ask/askText calls still consume lines in order", async () => {
      const channel = createConfirmChannel(inputOf("y\nsome answer\nn\n"), discardOutput());
      expect(await channel.ask("confirm1? ")).toBe(true);
      expect(await channel.askText("what? ")).toBe("some answer");
      expect(await channel.ask("confirm2? ")).toBe(false);
      channel.dispose();
    });
  });
});
