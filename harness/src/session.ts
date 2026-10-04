import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSchemas, createEnvelope, type Envelope } from "./protocol/envelope.js";
import { findRepoRoot } from "./config/repoPaths.js";
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
import type { ConfirmChannel } from "./cli/confirm.js";

export interface HistoryEntry {
  user: string;
  assistant: string;
}

export interface SessionOptions {
  repoRoot: string;
  pythonCmd: string;
  model?: string;
  /** Skip the model's extended thinking for faster (less careful) replies. */
  fast?: boolean;
  maxIterations: number;
  autoApprove: boolean;
  verbose: boolean;
  /** Chat mode: hide the per-node status stream, show a compact tool line instead. */
  quiet: boolean;
  /** Where user-visible output goes (default: console). The chat routes it through its Screen so a
   * window resize can redraw the whole conversation. */
  print?: (text?: string) => void;
  printError?: (text: string) => void;
  /** The one shared stdin reader (confirmations, ask_user answers, and the chat prompt). */
  getChannel: () => ConfirmChannel;
}

export interface TurnResult {
  ok: boolean;
  summary?: string;
}

export interface AgentSession {
  readonly sessionId: string;
  setAutoApprove(value: boolean): void;
  setFast(value: boolean): void;
  /** Runs one task to completion. The Python process (and its model) stays alive between turns. */
  runTurn(task: string, history: HistoryEntry[]): Promise<TurnResult>;
  /** False once the reasoning loop has died; further turns would just hang. */
  isAlive(): boolean;
  close(exitCode?: number): Promise<void>;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * One reasoning-loop process, one audit log, any number of tasks ("turns"). Owns the whole
 * harness side of a conversation with the Python process: validating and executing tool calls,
 * previewing and confirming risky ones, and answering ask_user.
 */
export function createAgentSession(opts: SessionOptions): AgentSession {
  const sessionId = randomUUID();
  const devAgentRoot = findRepoRoot(moduleDir);
  const schemasDir = join(devAgentRoot, "schemas");
  initSchemas(schemasDir);
  initToolRegistry(schemasDir);

  const print = opts.print ?? ((t = "") => console.log(t));
  const printError = opts.printError ?? ((t: string) => console.error(t));
  const targetRepoRoot = opts.repoRoot;
  let autoApprove = opts.autoApprove;
  let fast = opts.fast ?? false;
  const logger = new AuditLogger(sessionId, join(devAgentRoot, ".devagent", "logs"));
  const proc = new PythonReasoningProcess({
    command: opts.pythonCmd,
    args: ["-m", "devagent_reasoning"],
    cwd: join(devAgentRoot, "reasoning", "src"),
  });

  logger.log("internal", {
    note: "session start",
    repo: targetRepoRoot,
    model: opts.model ?? "default",
    autoApprove,
    maxIterations: opts.maxIterations,
  });

  let stderrTail = "";
  let closing = false;
  let alive = true;
  let settleTurn: ((r: TurnResult) => void) | null = null;

  proc.on("send", (envelope: Envelope) => {
    logger.log("to_python", envelope);
    if (opts.verbose) process.stderr.write(`-> ${JSON.stringify(envelope)}\n`);
  });
  proc.on("stderr", (text: string) => {
    stderrTail = (stderrTail + text).slice(-800);
    if (opts.verbose) process.stderr.write(`[python:stderr] ${text}`);
  });
  proc.on("message", (envelope: Envelope) => {
    logger.log("from_python", envelope);
    if (opts.verbose) process.stderr.write(`<- ${JSON.stringify(envelope)}\n`);
    void handleMessage(envelope);
  });
  proc.on("error", (err: Error) => {
    logger.log("internal", { note: "process error", message: err.message });
    printError(`Error: ${err.message}`);
    alive = false;
    settleTurn?.({ ok: false });
  });
  // If the reasoning loop dies mid-task nothing else would ever settle the turn — the CLI would
  // hang forever. A deliberate shutdown (close()) is excluded.
  proc.on("exit", (code: number | null) => {
    alive = false;
    if (closing) return;
    logger.log("internal", { note: "reasoning loop exited unexpectedly", code });
    printError(`\nThe reasoning loop exited unexpectedly (code ${code}).`);
    if (stderrTail.trim()) printError(`Its last output:\n${stderrTail.trim()}`);
    printError("Run `devagent doctor` to check your setup.");
    settleTurn?.({ ok: false });
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

    print(buildDiffPreview(plan));

    let approved: boolean;
    if (autoApprove) {
      approved = true;
    } else {
      approved = await opts.getChannel().ask(`Apply this ${call.name} to ${plan.relPath}? [y/N] `);
      print(); // keep the result line on its own line regardless of how the terminal echoed the answer
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

    print(`  DevAgent wants to run: ${[plan.command, ...plan.args].join(" ")}`);
    print(`  in: ${plan.relCwd === "." ? "(repository root)" : plan.relCwd}`);

    let approved: boolean;
    if (autoApprove) {
      approved = true;
    } else {
      approved = await opts.getChannel().ask(`Proceed? [y/N] `);
      print();
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
      print(`  exit code: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`);
      return { call_id: call.call_id, ok: true, result: result as unknown as object };
    } catch (err) {
      // e.g. the program isn't installed (spawn ENOENT) — report it to the agent, don't crash the session.
      return toToolResultError(call.call_id, err);
    }
  }

  async function handleMessage(envelope: Envelope): Promise<void> {
    switch (envelope.type) {
      case "plan_update": {
        const payload = envelope.payload as { step: string; detail?: Record<string, unknown> };
        if (opts.quiet) {
          if (payload.step === "rate_limited") {
            print(`  … rate limited by the model API, retrying in ${payload.detail?.retry_in_s}s`);
          }
          return;
        }
        const detail = payload.detail ? ` ${JSON.stringify(payload.detail)}` : "";
        print(`→ ${payload.step}${detail}`);
        return;
      }
      case "tool_call": {
        const call = envelope.payload as ToolCallPayload;
        const args = JSON.stringify(call.arguments);
        print(`  ⚙ ${call.name}(${opts.quiet && args.length > 110 ? `${args.slice(0, 110)}…` : args})`);
        const result =
          call.name === "run_command"
            ? await handleRunCommandCall(call)
            : toolRequiresConfirmation(call.name)
              ? await handleWriteToolCall(call)
              : await executeToolCall(targetRepoRoot, call);
        print(result.ok ? "  ← ok" : `  ← error: ${result.error?.message}`);
        proc.send(createEnvelope("tool_result", result, sessionId));
        return;
      }
      case "ask_user": {
        const payload = envelope.payload as { question: string };
        print(`\nDevAgent asks: ${payload.question}`);
        const answer = await opts.getChannel().askText("> ");
        print();
        proc.send(createEnvelope("ask_user_response", { answer }, sessionId));
        return;
      }
      case "final_answer": {
        const payload = envelope.payload as { summary: string };
        settleTurn?.({ ok: true, summary: payload.summary });
        return;
      }
      case "error": {
        const payload = envelope.payload as { code: string; message: string };
        printError(`\nReasoning loop error [${payload.code}]: ${payload.message}`);
        settleTurn?.({ ok: false });
        return;
      }
      default:
        return;
    }
  }

  proc.start();

  return {
    sessionId,
    setAutoApprove(value: boolean): void {
      autoApprove = value;
      logger.log("internal", { note: "auto-approve changed", autoApprove: value });
    },
    setFast(value: boolean): void {
      fast = value;
      logger.log("internal", { note: "fast mode changed", fast: value });
    },
    isAlive: () => alive,
    runTurn(task: string, history: HistoryEntry[]): Promise<TurnResult> {
      logger.log("internal", { note: "turn start", task });
      return new Promise<TurnResult>((resolvePromise) => {
        settleTurn = (r) => {
          settleTurn = null;
          resolvePromise(r);
        };
        proc.send(
          createEnvelope(
            "task_start",
            {
              task,
              repo_root: targetRepoRoot,
              max_iterations: opts.maxIterations,
              ...(opts.model ? { model: opts.model } : {}),
              ...(fast ? { fast: true } : {}),
              ...(history.length > 0 ? { history } : {}),
            },
            sessionId,
          ),
        );
      });
    },
    async close(exitCode?: number): Promise<void> {
      closing = true;
      logger.log("internal", { note: "session end", exitCode: exitCode ?? 0 });
      await proc.stop();
      await logger.close();
    },
  };
}
