#!/usr/bin/env node
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initSchemas } from "./protocol/envelope.js";
import { findRepoRoot } from "./config/repoPaths.js";
import { PythonReasoningProcess } from "./process/pythonProcess.js";
import { AuditLogger } from "./logging/auditLog.js";
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

program.parseAsync(process.argv);
