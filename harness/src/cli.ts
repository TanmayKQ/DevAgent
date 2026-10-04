#!/usr/bin/env node
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { initSchemas, createEnvelope } from "./protocol/envelope.js";
import { findRepoRoot } from "./config/repoPaths.js";
import { resolvePython } from "./config/python.js";
import { runDoctor, formatChecks } from "./cli/doctor.js";
import { parseLog, formatReplay, resolveLogPath } from "./cli/replay.js";
import { runChat } from "./cli/chat.js";
import { createAgentSession } from "./session.js";
import { readFileSync } from "node:fs";
import { PythonReasoningProcess } from "./process/pythonProcess.js";
import { AuditLogger } from "./logging/auditLog.js";
import {
  initToolRegistry,
  executeToolCall,
  toolRequiresConfirmation,
  validateToolCallArguments,
  toToolResultError,
  type ToolCallPayload,
  type ToolResultPayload,
} from "./tools/registry.js";
import { planWriteFile, planApplyPatch, commitWrite, type WriteFileArgs, type ApplyPatchArgs } from "./tools/writePlan.js";
import { buildDiffPreview } from "./tools/diffPreview.js";
import { prepareRunCommand, type RunCommandArgs } from "./tools/prepareRunCommand.js";
import { executePlan } from "./tools/runCommand.js";
import { createConfirmChannel, type ConfirmChannel } from "./cli/confirm.js";
import type { Envelope } from "./protocol/envelope.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const program = new Command();
program
  .name("devagent")
  .description("Autonomous CLI coding assistant")
  .option("--verbose", "echo raw protocol traffic to stderr", false)
  .option("--python <command>", "python interpreter to use (default: the .venv from `npm run setup`, else `python`)");

program
  .command("doctor")
  .description("check that Node, Python, the reasoning loop, and your API key are set up correctly")
  .action(() => {
    const opts = program.opts<{ python?: string }>();
    const root = findRepoRoot(__dirname);
    const python = resolvePython(opts.python ?? process.env.DEVAGENT_PYTHON, root);
    const checks = runDoctor(root, python, process.env);
    console.log(formatChecks(checks));
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
  });

program
  .command("replay <session>")
  .description("print a past session's audit log as a readable transcript (a session id, a .jsonl path, or \"latest\")")
  .action((session: string) => {
    try {
      const logsDir = join(findRepoRoot(__dirname), ".devagent", "logs");
      const path = resolveLogPath(logsDir, session);
      console.log(`Replaying ${path}\n`);
      console.log(formatReplay(parseLog(readFileSync(path, "utf8"))));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("selftest")
  .description("spawn the reasoning loop and verify the ping/pong handshake")
  .action(async () => {
    const opts = program.opts<{ verbose: boolean; python?: string }>();
    await runSelftest(resolvePython(opts.python ?? process.env.DEVAGENT_PYTHON, findRepoRoot(__dirname)), opts.verbose);
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
  .command("chat", { isDefault: true })
  .description("interactive chat with the agent in the current directory (this is what `devagent` does with no command)")
  .option("--repo <path>", "repository to work in (default: the current directory)")
  .option("--model <name>", "override the reasoning loop's default model")
  .option("--max-iterations <n>", "maximum plan/act iterations per message", "15")
  .option("--yolo", "start with confirmations off (toggle later with /yolo)", false)
  .option("--auto", "alias for --yolo", false)
  .action(
    async (cmdOpts: { repo?: string; model?: string; maxIterations: string; yolo: boolean; auto: boolean }) => {
      const opts = program.opts<{ verbose: boolean; python?: string }>();
      const maxIterations = Number.parseInt(cmdOpts.maxIterations, 10);
      if (!Number.isInteger(maxIterations) || maxIterations < 1) {
        console.error(`--max-iterations must be a positive integer, got: ${cmdOpts.maxIterations}`);
        process.exitCode = 1;
        return;
      }
      const repoRoot = resolve(process.cwd(), cmdOpts.repo ?? ".");
      if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
        console.error(`--repo does not point to an existing directory: ${repoRoot}`);
        process.exitCode = 1;
        return;
      }
      await runChat({
        repoRoot,
        pythonCmd: resolvePython(opts.python ?? process.env.DEVAGENT_PYTHON, findRepoRoot(__dirname)),
        model: cmdOpts.model,
        maxIterations,
        autoApprove: cmdOpts.yolo || cmdOpts.auto,
        verbose: opts.verbose,
        devAgentRoot: findRepoRoot(__dirname),
      });
    },
  );

program
  .command("run <task>")
  .description("run a natural-language task against a repository")
  .requiredOption("--repo <path>", "path to the target repository")
  .option("--model <name>", "override the reasoning loop's default model")
  .option("--max-iterations <n>", "maximum plan/act iterations before giving up", "15")
  .option(
    "--yolo",
    "skip the confirmation prompt for write_file/apply_patch/run_command (still previewed, still jailed/allowlisted, still logged)",
    false,
  )
  .option("--auto", "alias for --yolo", false)
  .action(
    async (
      task: string,
      cmdOpts: { repo: string; model?: string; maxIterations: string; yolo: boolean; auto: boolean },
    ) => {
      const opts = program.opts<{ verbose: boolean; python?: string }>();
      const maxIterations = Number.parseInt(cmdOpts.maxIterations, 10);
      if (!Number.isInteger(maxIterations) || maxIterations < 1) {
        console.error(`--max-iterations must be a positive integer, got: ${cmdOpts.maxIterations}`);
        process.exitCode = 1;
        return;
      }
      await runTask(
        task,
        cmdOpts.repo,
        maxIterations,
        cmdOpts.model,
        resolvePython(opts.python ?? process.env.DEVAGENT_PYTHON, findRepoRoot(__dirname)),
        opts.verbose,
        cmdOpts.yolo || cmdOpts.auto,
      );
    },
  );

async function runTask(
  task: string,
  repoArg: string,
  maxIterations: number,
  model: string | undefined,
  pythonCmd: string,
  verbose: boolean,
  autoApprove: boolean,
): Promise<void> {
  const targetRepoRoot = resolve(process.cwd(), repoArg);
  if (!existsSync(targetRepoRoot) || !statSync(targetRepoRoot).isDirectory()) {
    console.error(`--repo does not point to an existing directory: ${targetRepoRoot}`);
    process.exitCode = 1;
    return;
  }

  // One channel for the whole run, created lazily on the first prompt actually needed (a
  // read-only task never touches stdin at all) — see confirm.ts for why one shared reader matters.
  let channel: ConfirmChannel | undefined;
  const getChannel = (): ConfirmChannel => (channel ??= createConfirmChannel());

  const session = createAgentSession({
    repoRoot: targetRepoRoot,
    pythonCmd,
    model,
    maxIterations,
    autoApprove,
    verbose,
    quiet: false,
    getChannel,
  });
  console.log(`session ${session.sessionId}  (replay later with: devagent replay ${session.sessionId})`);

  const result = await session.runTurn(task, []);
  if (result.ok) console.log(`\nDevAgent: ${result.summary}`);
  process.exitCode = result.ok ? 0 : 1;
  channel?.dispose();
  await session.close(process.exitCode);
}

program.parseAsync(process.argv);
