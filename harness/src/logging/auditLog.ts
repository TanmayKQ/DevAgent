import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "../protocol/envelope.js";

export type LogDirection = "to_python" | "from_python" | "internal";

/** Appends every protocol message (both directions) as structured JSON to .devagent/logs/<session-id>.jsonl. */
export class AuditLogger {
  private readonly stream: WriteStream;

  constructor(sessionId: string, logsDir = ".devagent/logs") {
    mkdirSync(logsDir, { recursive: true });
    this.stream = createWriteStream(join(logsDir, `${sessionId}.jsonl`), { flags: "a" });
  }

  log(direction: LogDirection, envelope: Envelope | Record<string, unknown>): void {
    const record = {
      logged_at: new Date().toISOString(),
      direction,
      envelope,
    };
    this.stream.write(JSON.stringify(record) + "\n");
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}
