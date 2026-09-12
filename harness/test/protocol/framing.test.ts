import { describe, it, expect } from "vitest";
import { LineFramer, FramingError, encodeMessage } from "../../src/protocol/framing.js";

describe("LineFramer", () => {
  it("reassembles messages split at arbitrary byte offsets", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ n: i, note: "x".repeat(i % 5) }));
    const raw = Buffer.concat(messages.map((m) => encodeMessage(m)));

    // Deterministic PRNG so a failure is always reproducible.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };

    const chunks: Buffer[] = [];
    let i = 0;
    while (i < raw.length) {
      const step = 1 + (rand() % 7);
      chunks.push(raw.subarray(i, i + step));
      i += step;
    }

    const framer = new LineFramer();
    const seen: unknown[] = [];
    for (const chunk of chunks) {
      for (const line of framer.push(chunk)) {
        seen.push(JSON.parse(line));
      }
    }

    expect(seen).toEqual(messages);
  });

  it("rejects an oversized line", () => {
    const framer = new LineFramer(10);
    expect(() => framer.push(Buffer.from("x".repeat(20) + "\n"))).toThrow(FramingError);
  });

  it("does not choke on a multi-byte UTF-8 character split across chunks", () => {
    const raw = encodeMessage({ text: "café ✅" }); // é and ✅ are multi-byte in UTF-8
    const framer = new LineFramer();
    const seen: unknown[] = [];
    for (let i = 0; i < raw.length; i++) {
      for (const line of framer.push(raw.subarray(i, i + 1))) {
        seen.push(JSON.parse(line));
      }
    }
    expect(seen).toEqual([{ text: "café ✅" }]);
  });
});
