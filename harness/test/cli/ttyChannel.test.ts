import { describe, it, expect } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { createTtyChannel } from "../../src/cli/ttyChannel.js";

function setup() {
  const input = new PassThrough();
  const chunks: string[] = [];
  const output = new Writable({
    write(c, _e, cb) {
      chunks.push(c.toString());
      cb();
    },
  });
  const recorded: string[] = [];
  const channel = createTtyChannel(input, output, (t) => recorded.push(t));
  return { input, chunks, recorded, channel };
}

describe("createTtyChannel (terminal-mode readline)", () => {
  it("returns the typed line and records prompt+answer for later redraws", async () => {
    const { input, recorded, channel } = setup();
    const p = channel.askLine("> ");
    input.write("hello world\r");
    expect(await p).toBe("hello world");
    expect(recorded).toEqual(["> hello world"]);
    channel.dispose();
  });

  it("answers y/N confirmations", async () => {
    const { input, channel } = setup();
    const a = channel.ask("ok? ");
    input.write("y\r");
    expect(await a).toBe(true);
    const b = channel.ask("ok? ");
    input.write("n\r");
    expect(await b).toBe(false);
    channel.dispose();
  });

  it("returns null at Ctrl+D so a chat loop can stop", async () => {
    const { input, channel } = setup();
    const p = channel.askLine("> ");
    input.write("\x04");
    expect(await p).toBeNull();
  });

  it("returns null for any prompt after it has been closed", async () => {
    const { channel } = setup();
    channel.dispose();
    expect(await channel.askLine("> ")).toBeNull();
  });

  it("repaints the prompt AND the half-typed line on redraw — the text isn't lost", async () => {
    const { input, chunks, channel } = setup();
    const p = channel.askLine("> ");
    input.write("half typ"); // no Enter yet
    await new Promise((r) => setTimeout(r, 20));
    chunks.length = 0;

    channel.redrawPrompt();

    const out = chunks.join("");
    expect(out).toContain("> ");
    expect(out).toContain("half typ");
    input.write("ed\r");
    expect(await p).toBe("half typed");
    channel.dispose();
  });

  it("invokes the interrupt handler on Ctrl+C", async () => {
    const { input, channel } = setup();
    let hit = false;
    channel.onInterrupt(() => {
      hit = true;
    });
    void channel.askLine("> ");
    input.write("\x03");
    await new Promise((r) => setTimeout(r, 20));
    expect(hit).toBe(true);
    channel.dispose();
  });
});
