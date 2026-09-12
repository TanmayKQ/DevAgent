import { Ajv } from "ajv";
import type { ValidateFunction, ErrorObject } from "ajv";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type MessageType =
  | "task_start"
  | "tool_call"
  | "tool_result"
  | "plan_update"
  | "ask_user"
  | "final_answer"
  | "error"
  | "ping"
  | "pong";

export interface Envelope<P = unknown> {
  v: 1;
  id: string;
  session_id: string;
  ts: string;
  type: MessageType;
  payload: P;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const ajv = new Ajv({ allErrors: true, strict: true });

let envelopeValidator: ValidateFunction | null = null;
const payloadValidators = new Map<string, ValidateFunction>();

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return ["invalid data"];
  return errors.map((e) => `${e.instancePath || "/"} ${e.message}`);
}

/** Loads envelope.schema.json + schemas/messages/*.schema.json from `schemasDir`. Idempotent. */
export function initSchemas(schemasDir: string): void {
  if (envelopeValidator) return;

  const envelopeSchema = JSON.parse(readFileSync(join(schemasDir, "envelope.schema.json"), "utf8"));
  envelopeValidator = ajv.compile(envelopeSchema);

  const messagesDir = join(schemasDir, "messages");
  let files: string[] = [];
  try {
    files = readdirSync(messagesDir).filter((f) => f.endsWith(".schema.json"));
  } catch {
    files = [];
  }
  for (const file of files) {
    const type = file.replace(/\.schema\.json$/, "");
    const schema = JSON.parse(readFileSync(join(messagesDir, file), "utf8"));
    payloadValidators.set(type, ajv.compile(schema));
  }
}

function getPayloadValidator(type: string): ValidateFunction {
  const existing = payloadValidators.get(type);
  if (existing) return existing;
  // Message types without a dedicated payload schema yet (added milestone by milestone)
  // fall back to "any object" so the envelope-level type enum can stay complete from M0.
  const fallback = ajv.compile({ type: "object" });
  payloadValidators.set(type, fallback);
  return fallback;
}

export function validateEnvelope(data: unknown): ValidationResult {
  if (!envelopeValidator) {
    throw new Error("Schemas not initialized — call initSchemas() first");
  }
  if (!envelopeValidator(data)) {
    return { valid: false, errors: formatAjvErrors(envelopeValidator.errors) };
  }
  const envelope = data as Envelope;
  const payloadValidate = getPayloadValidator(envelope.type);
  if (!payloadValidate(envelope.payload)) {
    return { valid: false, errors: formatAjvErrors(payloadValidate.errors) };
  }
  return { valid: true, errors: [] };
}

export function createEnvelope<P>(type: MessageType, payload: P, sessionId: string): Envelope<P> {
  return {
    v: 1,
    id: randomUUID(),
    session_id: sessionId,
    ts: new Date().toISOString(),
    type,
    payload,
  };
}
