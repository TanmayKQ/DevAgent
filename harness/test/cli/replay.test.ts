import { describe, it, expect } from "vitest";
import { parseLog, formatReplay, type LogRecord } from "../../src/cli/replay.js";

const rec = (direction: LogRecord["direction"], envelope: LogRecord["envelope"]): LogRecord => ({
  logged_at: "2026-10-03T10:11:12.000Z",
  direction,
  envelope,
});

describe("formatReplay", () => {
  const log = [
    rec("internal", { note: "session start" }),
    rec("to_python", { type: "task_start", payload: { task: "fix it", max_iterations: 5 } }),
    rec("from_python", { type: "plan_update", payload: { step: "planning" } }),
    rec("from_python", { type: "tool_call", payload: { name: "read_file", arguments: { path: "a.js" } } }),
    rec("to_python", { type: "tool_result", payload: { ok: true, result: { content: "x" } } }),
    rec("to_python", { type: "tool_result", payload: { ok: false, error: { code: "not_found", message: "no file" } } }),
    rec("from_python", { type: "ask_user", payload: { question: "which?" } }),
    rec("to_python", { type: "ask_user_response", payload: { answer: "this one" } }),
    rec("from_python", { type: "final_answer", payload: { summary: "done" } }),
  ];

  it("renders each message type readably", () => {
    const out = formatReplay(log);
    expect(out).toContain("TASK: fix it");
    expect(out).toContain("-> read_file");
    expect(out).toContain("<- ok");
    expect(out).toContain("<- ERROR not_found: no file");
    expect(out).toContain("AGENT ASKS: which?");
    expect(out).toContain("USER ANSWERED: this one");
    expect(out).toContain("FINAL ANSWER: done");
    expect(out).toContain("(session start)");
  });

  it("hides noisy per-node status updates", () => {
    expect(formatReplay(log)).not.toContain("planning");
  });

  it("parses JSONL, ignoring blank lines and CRLF", () => {
    const text = JSON.stringify(log[1]) + "\r\n\r\n" + JSON.stringify(log[8]) + "\n";
    expect(parseLog(text)).toHaveLength(2);
  });
});
