import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PythonReasoningProcess } from "../../src/process/pythonProcess.js";
import { initSchemas, createEnvelope, type Envelope } from "../../src/protocol/envelope.js";
import { initToolRegistry, executeToolCall, type ToolCallPayload } from "../../src/tools/registry.js";
import { findRepoRoot } from "../../src/config/repoPaths.js";
import { AuditLogger } from "../../src/logging/auditLog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(__dirname);
const sampleRepo = join(__dirname, "..", "fixtures", "sample-repo");
const pythonCmd = process.env.DEVAGENT_PYTHON || "python";

// Full plan -> act -> observe -> reflect -> finish loop, driven by a real spawned Python
// process and real tool execution against the sample-repo fixture. Uses a scripted fake
// LLM (DEVAGENT_FAKE_LLM_RESPONSES) instead of a live Gemini call, per NFR5 — this proves
// the entire cross-process wire protocol and tool pipeline work without needing an API key.
describe("end-to-end task run (integration, fake LLM)", () => {
  let logsDir: string | null = null;
  let scriptPath: string | null = null;

  afterEach(() => {
    if (logsDir) rmSync(logsDir, { recursive: true, force: true });
    if (scriptPath) rmSync(scriptPath, { force: true });
    logsDir = null;
    scriptPath = null;
  });

  it("reads a file via a real tool call and produces a final answer", async () => {
    const devAgentRoot = findRepoRoot(__dirname);
    initSchemas(join(devAgentRoot, "schemas"));
    initToolRegistry(join(devAgentRoot, "schemas"));

    const scriptDir = mkdtempSync(join(tmpdir(), "devagent-fake-llm-"));
    scriptPath = join(scriptDir, "responses.json");
    writeFileSync(
      scriptPath,
      JSON.stringify([
        { tool_call: { name: "read_file", args: { path: "README.md" } } },
        { text: "This repo's README describes a sample fixture." },
      ]),
    );

    const sessionId = randomUUID();
    logsDir = join(devAgentRoot, ".devagent", "logs", `test-${sessionId}`);
    const logger = new AuditLogger(sessionId, logsDir);

    const proc = new PythonReasoningProcess({
      command: pythonCmd,
      args: ["-m", "devagent_reasoning"],
      cwd: join(devAgentRoot, "reasoning", "src"),
      env: { DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
    });

    const toolCalls: ToolCallPayload[] = [];
    let finalAnswer: string | null = null;
    let sawError: unknown = null;

    const done = new Promise<void>((resolveDone) => {
      proc.on("send", (envelope: Envelope) => logger.log("to_python", envelope));
      proc.on("message", async (envelope: Envelope) => {
        logger.log("from_python", envelope);
        if (envelope.type === "tool_call") {
          const call = envelope.payload as ToolCallPayload;
          toolCalls.push(call);
          const result = await executeToolCall(sampleRepo, call);
          proc.send(createEnvelope("tool_result", result, sessionId));
        } else if (envelope.type === "final_answer") {
          finalAnswer = (envelope.payload as { summary: string }).summary;
          resolveDone();
        } else if (envelope.type === "error") {
          sawError = envelope.payload;
          resolveDone();
        }
      });
    });

    proc.start();
    proc.send(
      createEnvelope(
        "task_start",
        { task: "what does the README say?", repo_root: sampleRepo, max_iterations: 5 },
        sessionId,
      ),
    );

    await done;
    await proc.stop();
    await logger.close();

    expect(sawError).toBeNull();
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: "read_file", arguments: { path: "README.md" } });
    expect(finalAnswer).toBe("This repo's README describes a sample fixture.");

    const logLines = readFileSync(join(logsDir, `${sessionId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(logLines.some((l) => l.envelope.type === "tool_call")).toBe(true);
    expect(logLines.some((l) => l.envelope.type === "tool_result")).toBe(true);
    expect(logLines.some((l) => l.envelope.type === "final_answer")).toBe(true);
  }, 20000);

  it("keeps the repo-root jail even when the fake LLM tries to escape it", async () => {
    const devAgentRoot = findRepoRoot(__dirname);
    initSchemas(join(devAgentRoot, "schemas"));
    initToolRegistry(join(devAgentRoot, "schemas"));

    const scriptDir = mkdtempSync(join(tmpdir(), "devagent-fake-llm-"));
    scriptPath = join(scriptDir, "responses.json");
    writeFileSync(
      scriptPath,
      JSON.stringify([
        { tool_call: { name: "read_file", args: { path: "../../../etc/passwd" } } },
        { text: "Could not read that file." },
      ]),
    );

    const sessionId = randomUUID();
    logsDir = join(devAgentRoot, ".devagent", "logs", `test-${sessionId}`);
    const logger = new AuditLogger(sessionId, logsDir);

    const proc = new PythonReasoningProcess({
      command: pythonCmd,
      args: ["-m", "devagent_reasoning"],
      cwd: join(devAgentRoot, "reasoning", "src"),
      env: { DEVAGENT_FAKE_LLM_RESPONSES: scriptPath },
    });

    let toolResultErrorCode: string | undefined;
    let finalAnswer: string | null = null;

    const done = new Promise<void>((resolveDone) => {
      proc.on("send", (envelope: Envelope) => logger.log("to_python", envelope));
      proc.on("message", async (envelope: Envelope) => {
        logger.log("from_python", envelope);
        if (envelope.type === "tool_call") {
          const call = envelope.payload as ToolCallPayload;
          const result = await executeToolCall(sampleRepo, call);
          toolResultErrorCode = result.error?.code;
          proc.send(createEnvelope("tool_result", result, sessionId));
        } else if (envelope.type === "final_answer") {
          finalAnswer = (envelope.payload as { summary: string }).summary;
          resolveDone();
        } else if (envelope.type === "error") {
          resolveDone();
        }
      });
    });

    proc.start();
    proc.send(
      createEnvelope("task_start", { task: "read /etc/passwd", repo_root: sampleRepo, max_iterations: 5 }, sessionId),
    );

    await done;
    await proc.stop();
    await logger.close();

    expect(toolResultErrorCode).toBe("path_jail_violation");
    expect(finalAnswer).toBe("Could not read that file.");
  }, 20000);
});
