import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LogRecord {
  logged_at: string;
  direction: "to_python" | "from_python" | "internal";
  envelope: { type?: string; payload?: Record<string, unknown>; [k: string]: unknown };
}

export function parseLog(text: string): LogRecord[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LogRecord);
}

/** Resolves a session id, a path to a .jsonl file, or "latest" to a log file path. */
export function resolveLogPath(logsDir: string, ref: string): string {
  if (existsSync(ref) && statSync(ref).isFile()) return ref;
  if (ref === "latest") {
    const files = existsSync(logsDir) ? readdirSync(logsDir).filter((f) => f.endsWith(".jsonl")) : [];
    if (files.length === 0) throw new Error(`no session logs found in ${logsDir}`);
    files.sort((a, b) => statSync(join(logsDir, b)).mtimeMs - statSync(join(logsDir, a)).mtimeMs);
    return join(logsDir, files[0]);
  }
  const candidate = join(logsDir, ref.endsWith(".jsonl") ? ref : `${ref}.jsonl`);
  if (!existsSync(candidate)) throw new Error(`no such session log: ${candidate}`);
  return candidate;
}

const clip = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Renders a session's audit log as a readable transcript. Read-only inspection — no side effects. */
export function formatReplay(records: LogRecord[]): string {
  const out: string[] = [];
  for (const r of records) {
    const e = r.envelope;
    const p = (e.payload ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const t = r.logged_at.slice(11, 19);
    switch (e.type) {
      case "task_start":
        out.push(`[${t}] TASK: ${p.task}  (max ${p.max_iterations} iterations${p.model ? `, model ${p.model}` : ""})`);
        break;
      case "plan_update":
        if (p.step !== "planning" && p.step !== "observed" && p.step !== "reflecting") out.push(`[${t}]   · ${p.step}`);
        break;
      case "tool_call":
        out.push(`[${t}] -> ${p.name}(${clip(JSON.stringify(p.arguments), 160)})`);
        break;
      case "tool_result":
        out.push(
          p.ok
            ? `[${t}] <- ok ${clip(JSON.stringify(p.result), 160)}`
            : `[${t}] <- ERROR ${(p.error as { code: string; message: string }).code}: ${clip(String((p.error as { message: string }).message), 200)}`,
        );
        break;
      case "ask_user":
        out.push(`[${t}] AGENT ASKS: ${p.question}`);
        break;
      case "ask_user_response":
        out.push(`[${t}] USER ANSWERED: ${p.answer}`);
        break;
      case "final_answer":
        out.push(`[${t}] FINAL ANSWER: ${p.summary}`);
        break;
      case "error":
        out.push(`[${t}] ERROR [${p.code}]: ${p.message}`);
        break;
      default:
        if (r.direction === "internal" && (e as Record<string, unknown>).note) {
          out.push(`[${t}] (${(e as Record<string, unknown>).note})`);
        }
    }
  }
  return out.join("\n");
}
