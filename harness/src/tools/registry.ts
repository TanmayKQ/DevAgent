import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "./readFile.js";
import { listDir } from "./listDir.js";
import { searchCode } from "./searchCode.js";
import { writeFile } from "./writeFile.js";
import { applyPatch } from "./applyPatch.js";
import { runCommand } from "./runCommand.js";
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
  requiresConfirmation: boolean;
}

const ajv = new Ajv({ allErrors: true, strict: true });
const registry = new Map<string, ToolEntry>();
let loaded = false;

/** Loads schemas/tools/*.schema.json and wires each to its handler. Idempotent. */
export function initToolRegistry(schemasDir: string): void {
  if (loaded) return;
  register(schemasDir, "read_file", readFile, false);
  register(schemasDir, "list_dir", listDir, false);
  register(schemasDir, "search_code", searchCode, false);
  register(schemasDir, "write_file", writeFile, true);
  register(schemasDir, "apply_patch", applyPatch, true);
  register(schemasDir, "run_command", runCommand, true);
  loaded = true;
}

function register(schemasDir: string, name: string, handler: ToolHandler, requiresConfirmation: boolean): void {
  const schema = JSON.parse(readFileSync(join(schemasDir, "tools", `${name}.schema.json`), "utf8"));
  registry.set(name, { validate: ajv.compile(schema), handler, requiresConfirmation });
}

/** Whether this tool is medium/high risk and should be previewed + confirmed before running (PRD 6.3). */
export function toolRequiresConfirmation(name: string): boolean {
  return registry.get(name)?.requiresConfirmation ?? false;
}

export interface ArgumentValidationResult {
  valid: boolean;
  errors: string[];
}

/** Schema-validates `call.arguments` against the tool's own schema, without executing it. */
export function validateToolCallArguments(call: ToolCallPayload): ArgumentValidationResult {
  const entry = registry.get(call.name);
  if (!entry) {
    return { valid: false, errors: [`no such tool: ${call.name}`] };
  }
  if (!entry.validate(call.arguments)) {
    const errors = (entry.validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
    return { valid: false, errors: errors.length ? errors : ["invalid arguments"] };
  }
  return { valid: true, errors: [] };
}

/** Maps a thrown error (from a plan/handler step) to a well-formed tool_result, never throwing itself. */
export function toToolResultError(callId: string, err: unknown): ToolResultPayload {
  if (err instanceof ToolExecutionError) {
    return { call_id: callId, ok: false, error: { code: err.code, message: err.message } };
  }
  if (err instanceof PathJailError) {
    return { call_id: callId, ok: false, error: { code: "path_jail_violation", message: err.message } };
  }
  return { call_id: callId, ok: false, error: { code: "internal_error", message: (err as Error).message } };
}

/**
 * Validates arguments against the tool's own schema, then executes it immediately (no
 * confirmation gate — that's a CLI-layer concern for write-tier tools, see cli.ts). Never
 * throws: every failure (unknown tool, bad arguments, handler error, jail violation) becomes a
 * well-formed `{ok:false, error}` result so a single tool call can't crash the session (NFR1)
 * and the reasoning loop always gets an actionable observation back (FR4).
 */
export async function executeToolCall(repoRoot: string, call: ToolCallPayload): Promise<ToolResultPayload> {
  const validation = validateToolCallArguments(call);
  if (!validation.valid) {
    const code = registry.has(call.name) ? "invalid_arguments" : "unknown_tool";
    return { call_id: call.call_id, ok: false, error: { code, message: validation.errors.join("; ") } };
  }

  const entry = registry.get(call.name)!;
  try {
    const result = await entry.handler(repoRoot, call.arguments);
    return { call_id: call.call_id, ok: true, result: result as object };
  } catch (err) {
    return toToolResultError(call.call_id, err);
  }
}
