/**
 * Line-buffered NDJSON framing shared conceptually with reasoning/src/devagent_reasoning/protocol.py.
 * Accumulates raw bytes and only decodes complete lines, so a chunk boundary that lands
 * mid multi-byte UTF-8 character never corrupts a message.
 */
export class FramingError extends Error {}

export class LineFramer {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxLineBytes: number;

  constructor(maxLineBytes = 10 * 1024 * 1024) {
    this.maxLineBytes = maxLineBytes;
  }

  push(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const lines: string[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf(0x0a)) !== -1) {
      if (newlineIndex > this.maxLineBytes) {
        throw new FramingError(`line exceeds max size of ${this.maxLineBytes} bytes`);
      }
      const lineBuf = this.buffer.subarray(0, newlineIndex);
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      lines.push(lineBuf.toString("utf8"));
    }
    if (this.buffer.length > this.maxLineBytes) {
      throw new FramingError(`unterminated line exceeds max size of ${this.maxLineBytes} bytes`);
    }
    return lines;
  }
}

export function encodeMessage(envelope: unknown): Buffer {
  return Buffer.from(JSON.stringify(envelope) + "\n", "utf8");
}
