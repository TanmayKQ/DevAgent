import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { initSchemas, validateEnvelope, createEnvelope } from "../../src/protocol/envelope.js";
import { findRepoRoot } from "../../src/config/repoPaths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Deliberately its own file: Vitest gives each test file a fresh module instance, which this
// needs because envelope.ts's schema registry is process-wide singleton state (initSchemas is
// a no-op after the first call) — envelope.test.ts's beforeAll already initializes it against
// the real schemas, so testing the fallback there would just reuse that, not a schemas dir
// with something missing.
describe("validateEnvelope fallback for a type without a dedicated payload schema", () => {
  let schemasCopy: string;

  beforeAll(() => {
    const repoRoot = findRepoRoot(__dirname);
    schemasCopy = mkdtempSync(join(tmpdir(), "devagent-schemas-fallback-"));
    cpSync(join(repoRoot, "schemas"), schemasCopy, { recursive: true });
    // Every real envelope type has a dedicated payload schema as of M4 — remove one so there's
    // something to actually test the fallback against.
    rmSync(join(schemasCopy, "messages", "pong.schema.json"));
    initSchemas(schemasCopy);
  });

  it("still accepts a valid envelope of that type via the permissive object fallback", () => {
    const envelope = createEnvelope("pong", { anything: "goes" }, "session-1");
    expect(validateEnvelope(envelope).valid).toBe(true);
  });
});
