import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PythonReasoningProcess } from "../../src/process/pythonProcess.js";
import { initSchemas } from "../../src/protocol/envelope.js";
import { findRepoRoot } from "../../src/config/repoPaths.js";
import { AuditLogger } from "../../src/logging/auditLog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(__dirname);
const pythonCmd = process.env.DEVAGENT_PYTHON || "python";

// Requires `pip install -e reasoning[dev]` in the active interpreter so
// `python -m devagent_reasoning` is importable. See README setup steps.
describe("harness <-> reasoning-loop handshake (integration)", () => {
  let logsDir: string | null = null;

  afterEach(() => {
    if (logsDir) {
      rmSync(logsDir, { recursive: true, force: true });
      logsDir = null;
    }
  });

  it(
    "performs a real ping/pong round trip and writes an audit log",
    async () => {
      initSchemas(join(repoRoot, "schemas"));

      const sessionId = randomUUID();
      logsDir = join(repoRoot, ".devagent", "logs", `test-${sessionId}`);
      const logger = new AuditLogger(sessionId, logsDir);

      const proc = new PythonReasoningProcess({
        command: pythonCmd,
        args: ["-m", "devagent_reasoning"],
        cwd: join(repoRoot, "reasoning", "src"),
      });

      proc.on("send", (envelope) => logger.log("to_python", envelope));
      proc.on("message", (envelope) => logger.log("from_python", envelope));

      proc.start();
      try {
        const pong = await proc.ping(sessionId, 5000);
        expect(pong.type).toBe("pong");
      } finally {
        await proc.stop();
        await logger.close();
      }

      const logLines = readFileSync(join(logsDir, `${sessionId}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));

      expect(logLines.some((l) => l.direction === "to_python" && l.envelope.type === "ping")).toBe(true);
      expect(logLines.some((l) => l.direction === "from_python" && l.envelope.type === "pong")).toBe(true);
    },
    15000,
  );
});
