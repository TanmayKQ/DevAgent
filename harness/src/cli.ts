#!/usr/bin/env node
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { initSchemas, createEnvelope } from "./protocol/envelope.js";
import { findRepoRoot } from "./config/repoPaths.js";
import { PythonReasoningProcess } from "./process/pythonProcess.js";
import { AuditLogger } from "./logging/auditLog.js";
import { initToolRegistry, executeToolCall, type ToolCallPayload } from "./tools/registry.js";
import type { Envelope } from "./protocol/envelope.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const program = new Command();
program
  .name("devagent")
  .description("Autonomous CLI coding assistant")
  .option("--verbose", "echo raw protocol traffic to stderr", false)
  .option("--python <command>", "python interpreter to use", process.env.DEVAGENT_PYTHON || "python");

program
  .command("selftest")
  .description("spawn the reasoning loop and verify the ping/pong handshake")
  .action(async () => {
    const opts = program.opts<{ verbose: boolean; python: string }>();
    await runSelftest(opts.python, opts.verbose);
  });

async function runSelftest(pythonCmd: string, verbose: boolean): Promise<void> {
  const sessionId = randomUUID();
  const repoRoot = findRepoRoot(__dirname);
  initSchemas(join(repoRoot, "schemas"));

  const logger = new AuditLogger(sessionId, join(repoRoot, ".devagent", "logs"));
  const proc = new PythonReasoningProcess({
    command: pythonCmd,
    args: ["-m", "devagent_reasoning"],
    cwd: join(repoRoot, "reasoning", "src"),
  });

  proc.on("send", (envelope: Envelope) => {
    logger.log("to_python", envelope);
    if (verbose) process.stderr.write(`-> ${JSON.stringify(envelope)}\n`);
  });
  proc.on("message", (envelope: Envelope) => {
    logger.log("from_python", envelope);
    if (verbose) process.stderr.write(`<- ${JSON.stringify(envelope)}\n`);
  });
  proc.on("stderr", (text: string) => {
    if (verbose) process.stderr.write(`[python:stderr] ${text}`);
  });
  proc.on("error", (err: Error) => {
    logger.log("internal", { note: "process error", message: err.message });
    console.error("Error:", err.message);
  });

  proc.start();

  try {
    const start = Date.now();
    const pong = await proc.ping(sessionId, 5000);
    const rttMs = Date.now() - start;
    console.log(`Reasoning loop is alive (round-trip ${rttMs}ms, replied ${pong.type}). session=${sessionId}`);
    process.exitCode = 0;
  } catch (err) {
    console.error("Handshake failed:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await proc.stop();
    await logger.close();
  }
}

program
  .command("run <task>")
  .description("run a natural-language task against a repository")
  .requiredOption("--repo <path>", "path to the target repository")
  .option("--model <name>", "override the reasoning loop's default model")
  .option("--max-iterations <n>", "maximum plan/act iterations before giving up", "15")
  .action(async (task: string, cmdOpts: { repo: string; model?: string; maxIterations: string }) => {
    const opts = program.opts<{ verbose: boolean; python: string }>();
    const maxIterations = Number.parseInt(cmdOpts.maxIterations, 10);
    if (!Number.isInteger(maxIterations) || maxIterations < 1) {
      console.error(`--max-iterations must be a positive integer, got: ${cmdOpts.maxIterations}`);
      process.exitCode = 1;
      return;
    }
    await runTask(task, cmdOpts.repo, maxIterations, cmdOpts.model, opts.python, opts.verbose);
  });

async function runTask(
  task: string,
  repoArg: string,
  maxIterations: number,
  model: string | undefined,
  pythonCmd: string,
  verbose: boolean,
): Promise<void> {
  const targetRepoRoot = resolve(process.cwd(), repoArg);
  if (!existsSync(targetRepoRoot) || !statSync(targetRepoRoot).isDirectory()) {
    console.error(`--repo does not point to an existing directory: ${targetRepoRoot}`);
    process.exitCode = 1;
    return;
  }

  const sessionId = randomUUID();
  const devAgentRoot = findRepoRoot(__dirname);
  const schemasDir = join(devAgentRoot, "schemas");
  initSchemas(schemasDir);
  initToolRegistry(schemasDir);

  const logger = new AuditLogger(sessionId, join(devAgentRoot, ".devagent", "logs"));
  const proc = new PythonReasoningProcess({
    command: pythonCmd,
    args: ["-m", "devagent_reasoning"],
    cwd: join(devAgentRoot, "reasoning", "src"),
  });

  proc.on("send", (envelope: Envelope) => {
    logger.log("to_python", envelope);
    if (verbose) process.stderr.write(`-> ${JSON.stringify(envelope)}\n`);
  });
  proc.on("stderr", (text: string) => {
    if (verbose) process.stderr.write(`[python:stderr] ${text}`);
  });

  let settle!: (exitCode: number) => void;
  const done = new Promise<number>((resolvePromise) => {
    settle = resolvePromise;
  });

  proc.on("message", (envelope: Envelope) => {
    logger.log("from_python", envelope);
    if (verbose) process.stderr.write(`<- ${JSON.stringify(envelope)}\n`);
    void handleMessage(envelope);
  });
  proc.on("error", (err: Error) => {
    logger.log("internal", { note: "process error", message: err.message });
    console.error("Error:", err.message);
    settle(1);
  });

  async function handleMessage(envelope: Envelope): Promise<void> {
    switch (envelope.type) {
      case "plan_update": {
        const payload = envelope.payload as { step: string; detail?: unknown };
        const detail = payload.detail ? ` ${JSON.stringify(payload.detail)}` : "";
        console.log(`→ ${payload.step}${detail}`);
        return;
      }
      case "tool_call": {
        const call = envelope.payload as ToolCallPayload;
        console.log(`  ⚙ ${call.name}(${JSON.stringify(call.arguments)})`);
        const result = await executeToolCall(targetRepoRoot, call);
        console.log(result.ok ? "  ← ok" : `  ← error: ${result.error?.message}`);
        proc.send(createEnvelope("tool_result", result, sessionId));
        return;
      }
      case "final_answer": {
        const payload = envelope.payload as { summary: string };
        console.log(`\nDevAgent: ${payload.summary}`);
        settle(0);
        return;
      }
      case "error": {
        const payload = envelope.payload as { code: string; message: string };
        console.error(`\nReasoning loop error [${payload.code}]: ${payload.message}`);
        settle(1);
        return;
      }
      default:
        return;
    }
  }

  proc.start();
  proc.send(
    createEnvelope(
      "task_start",
      { task, repo_root: targetRepoRoot, max_iterations: maxIterations, ...(model ? { model } : {}) },
      sessionId,
    ),
  );

  process.exitCode = await done;
  await proc.stop();
  await logger.close();
}

program.parseAsync(process.argv);
