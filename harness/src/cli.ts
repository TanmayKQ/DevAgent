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

  logger.log("internal", { note: "session start", task, repo: targetRepoRoot, model: model ?? "default", autoApprove, maxIterations });
  console.log(`session ${sessionId}  (replay later with: devagent replay ${sessionId})`);

  proc.on("send", (envelope: Envelope) => {
    logger.log("to_python", envelope);
    if (verbose) process.stderr.write(`-> ${JSON.stringify(envelope)}\n`);
  });
  let stderrTail = "";
  proc.on("stderr", (text: string) => {
    stderrTail = (stderrTail + text).slice(-800);
    if (verbose) process.stderr.write(`[python:stderr] ${text}`);
  });

  let settle!: (exitCode: number) => void;
  const done = new Promise<number>((resolvePromise) => {
    settle = resolvePromise;
  });

  // One channel for the whole task run, created lazily on the first confirmation actually
  // needed (a read-only task never touches stdin at all) and reused for every one after it —
  // see confirm.ts for why this matters with piped/scripted input.
  let confirmChannel: ConfirmChannel | undefined;
  function getConfirmChannel(): ConfirmChannel {
    if (!confirmChannel) confirmChannel = createConfirmChannel();
    return confirmChannel;
  }

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
  // If the reasoning loop dies mid-task nothing else would ever settle `done` — the CLI would
  // hang forever. A normal shutdown (after the task finished) is excluded via `finished`.
  let finished = false;
  proc.on("exit", (code: number | null) => {
    if (finished) return;
    logger.log("internal", { note: "reasoning loop exited unexpectedly", code });
    console.error(`
The reasoning loop exited unexpectedly (code ${code}).`);
    if (stderrTail.trim()) console.error(`Its last output:
${stderrTail.trim()}`);
    console.error("Run `devagent doctor` to check your setup.");
    settle(1);
  });

  async function handleWriteToolCall(call: ToolCallPayload): Promise<ToolResultPayload> {
    const validation = validateToolCallArguments(call);
    if (!validation.valid) {
      return { call_id: call.call_id, ok: false, error: { code: "invalid_arguments", message: validation.errors.join("; ") } };
    }

    let plan;
    try {
      plan =
        call.name === "write_file"
          ? planWriteFile(targetRepoRoot, call.arguments as WriteFileArgs)
          : planApplyPatch(targetRepoRoot, call.arguments as ApplyPatchArgs);
    } catch (err) {
      return toToolResultError(call.call_id, err);
    }

    console.log(buildDiffPreview(plan));

    let approved: boolean;
    if (autoApprove) {
      approved = true;
    } else {
      approved = await getConfirmChannel().ask(`Apply this ${call.name} to ${plan.relPath}? [y/N] `);
      console.log(); // keep the result line on its own line regardless of how the terminal echoed the answer
    }
    if (!approved) {
      return {
        call_id: call.call_id,
        ok: false,
        error: { code: "user_rejected", message: "The user declined to apply this change." },
      };
    }

    const applied = commitWrite(plan);
    return { call_id: call.call_id, ok: true, result: applied as unknown as object };
  }

  async function handleRunCommandCall(call: ToolCallPayload): Promise<ToolResultPayload> {
    const validation = validateToolCallArguments(call);
    if (!validation.valid) {
      return { call_id: call.call_id, ok: false, error: { code: "invalid_arguments", message: validation.errors.join("; ") } };
    }

    let plan;
    try {
      plan = prepareRunCommand(targetRepoRoot, call.arguments as RunCommandArgs);
    } catch (err) {
      return toToolResultError(call.call_id, err);
    }

    console.log(`  DevAgent wants to run: ${[plan.command, ...plan.args].join(" ")}`);
    console.log(`  in: ${plan.relCwd === "." ? "(repository root)" : plan.relCwd}`);

    let approved: boolean;
    if (autoApprove) {
      approved = true;
    } else {
      approved = await getConfirmChannel().ask(`Proceed? [y/N] `);
      console.log(); // keep the result line on its own line regardless of how the terminal echoed the answer
    }
    if (!approved) {
      return {
        call_id: call.call_id,
        ok: false,
        error: { code: "user_rejected", message: "The user declined to run this command." },
      };
    }

    try {
      const result = await executePlan(plan);
      console.log(`  exit code: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`);
      return { call_id: call.call_id, ok: true, result: result as unknown as object };
    } catch (err) {
      // e.g. the program isn't installed (spawn ENOENT) — report it to the agent, don't crash the session.
      return toToolResultError(call.call_id, err);
    }
  }

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
        const result =
          call.name === "run_command"
            ? await handleRunCommandCall(call)
            : toolRequiresConfirmation(call.name)
              ? await handleWriteToolCall(call)
              : await executeToolCall(targetRepoRoot, call);
        console.log(result.ok ? "  ← ok" : `  ← error: ${result.error?.message}`);
        proc.send(createEnvelope("tool_result", result, sessionId));
        return;
      }
      case "ask_user": {
        const payload = envelope.payload as { question: string };
        console.log(`\nDevAgent asks: ${payload.question}`);
        const answer = await getConfirmChannel().askText("> ");
        console.log();
        proc.send(createEnvelope("ask_user_response", { answer }, sessionId));
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
  finished = true;
  logger.log("internal", { note: "session end", exitCode: process.exitCode });
  confirmChannel?.dispose();
  await proc.stop();
  await logger.close();
}

program.parseAsync(process.argv);
