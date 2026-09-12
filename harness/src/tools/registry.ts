import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "./readFile.js";
import { listDir } from "./listDir.js";
import { searchCode } from "./searchCode.js";
import { ToolExecutionError } from "./errors.js";
import { PathJailError } from "./pathJail.js";

export interface ToolCallPayload {
  call_id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResultPayload {
  call_id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (repoRoot: string, args: any) => Promise<unknown>;

interface ToolEntry {
  validate: ValidateFunction;
  handler: ToolHandler;
}

const ajv = new Ajv({ allErrors: true, strict: true });
const registry = new Map<string, ToolEntry>();
let loaded = false;

/** Loads schemas/tools/*.schema.json and wires each to its handler. Idempotent. */
export function initToolRegistry(schemasDir: string): void {
  if (loaded) return;
  register(schemasDir, "read_file", readFile);
  register(schemasDir, "list_dir", listDir);
  register(schemasDir, "search_code", searchCode);
  loaded = true;
}

function register(schemasDir: string, name: string, handler: ToolHandler): void {
  const schema = JSON.parse(readFileSync(join(schemasDir, "tools", `${name}.schema.json`), "utf8"));
  registry.set(name, { validate: ajv.compile(schema), handler });
}

/**
 * Validates arguments against the tool's own schema, then executes it. Never throws —
 * every failure (unknown tool, bad arguments, handler error, jail violation) becomes a
 * well-formed `{ok:false, error}` result so a single tool call can't crash the session (NFR1)
 * and the reasoning loop always gets an actionable observation back (FR4).
 */
export async function executeToolCall(repoRoot: string, call: ToolCallPayload): Promise<ToolResultPayload> {
  const entry = registry.get(call.name);
  if (!entry) {
    return { call_id: call.call_id, ok: false, error: { code: "unknown_tool", message: `no such tool: ${call.name}` } };
  }

  if (!entry.validate(call.arguments)) {
    const message =
      (entry.validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ") ||
      "invalid arguments";
    return { call_id: call.call_id, ok: false, error: { code: "invalid_arguments", message } };
  }

  try {
    const result = await entry.handler(repoRoot, call.arguments);
    return { call_id: call.call_id, ok: true, result: result as object };
  } catch (err) {
    if (err instanceof ToolExecutionError) {
      return { call_id: call.call_id, ok: false, error: { code: err.code, message: err.message } };
    }
    if (err instanceof PathJailError) {
      return { call_id: call.call_id, ok: false, error: { code: "path_jail_violation", message: err.message } };
    }
    return { call_id: call.call_id, ok: false, error: { code: "internal_error", message: (err as Error).message } };
  }
}
