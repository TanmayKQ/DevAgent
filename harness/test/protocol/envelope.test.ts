import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initSchemas, validateEnvelope, createEnvelope } from "../../src/protocol/envelope.js";
import { findRepoRoot } from "../../src/config/repoPaths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

beforeAll(() => {
  const repoRoot = findRepoRoot(__dirname);
  initSchemas(join(repoRoot, "schemas"));
});

describe("validateEnvelope", () => {
  it("accepts a valid ping envelope", () => {
    const envelope = createEnvelope("ping", {}, "session-1");
    expect(validateEnvelope(envelope).valid).toBe(true);
  });

  it("accepts a valid pong envelope with in_reply_to", () => {
    const envelope = createEnvelope("pong", { in_reply_to: "some-id" }, "session-1");
    expect(validateEnvelope(envelope).valid).toBe(true);
  });

  it("rejects an error payload missing required fields", () => {
    const envelope = createEnvelope("error", { message: "oops" } as never, "session-1");
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/code/);
  });

  it("rejects an envelope with an unknown top-level field", () => {
    const envelope: Record<string, unknown> = { ...createEnvelope("ping", {}, "session-1") };
    envelope.unexpected = "nope";
    expect(validateEnvelope(envelope).valid).toBe(false);
  });

  it("rejects an unknown message type", () => {
    const envelope: Record<string, unknown> = { ...createEnvelope("ping", {}, "session-1") };
    envelope.type = "not_a_real_type";
    expect(validateEnvelope(envelope).valid).toBe(false);
  });

  // The "falls back to permissive validation for an unmapped type" case now lives in its own
  // isolated test file (envelopeFallback.test.ts) — every real type has a dedicated schema as
  // of M4, so exercising the fallback needs a schemas dir with one deliberately removed, and
  // envelope.ts's registry is process-wide singleton state that can't be re-initialized here
  // once this file's beforeAll has already loaded the real schemas.
});
