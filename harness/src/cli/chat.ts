import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createConfirmChannel, type ConfirmChannel } from "./confirm.js";
import { createAgentSession, type HistoryEntry } from "../session.js";

export interface ChatOptions {
  repoRoot: string;
  pythonCmd: string;
  model?: string;
  maxIterations: number;
  autoApprove: boolean;
  verbose: boolean;
  devAgentRoot: string;
}

const MAX_HISTORY_TURNS = 8;
const MAX_ASSISTANT_CHARS = 1500;

export const HELP_TEXT = [
  "Type a task or question in plain English and press Enter.",
  "",
  "  /help     show this help",
  "  /yolo     toggle auto-approve (skip the y/N prompt for writes and commands)",
  "  /clear    forget the conversation so far (the agent starts fresh)",
  "  /status   show the repo, model, and mode",
  "  /exit     quit (also: /quit, exit, quit, Ctrl+C)",
  "",
  "Every file change and command is shown to you first. The agent remembers your last few",
  "messages, but re-reads files itself — it does not keep file contents between messages.",
].join("\n");

/** Trims history to what's worth sending back: recent turns, with long answers clipped. */
export function trimHistory(history: HistoryEntry[]): HistoryEntry[] {
  return history.slice(-MAX_HISTORY_TURNS).map((h) => ({
    user: h.user,
    assistant: h.assistant.length > MAX_ASSISTANT_CHARS ? `${h.assistant.slice(0, MAX_ASSISTANT_CHARS)}…` : h.assistant,
  }));
}

export type SlashResult = "exit" | "handled" | "task";

function rule(): string {
  const width = Math.min(process.stdout.columns ?? 80, 100);
  return "─".repeat(width);
}

function version(devAgentRoot: string): string {
  try {
    return JSON.parse(readFileSync(join(devAgentRoot, "package.json"), "utf8")).version as string;
  } catch {
    return "dev";
  }
}

export async function runChat(opts: ChatOptions): Promise<void> {
  let autoApprove = opts.autoApprove;
  let channel: ConfirmChannel | undefined;
  const getChannel = (): ConfirmChannel => (channel ??= createConfirmChannel());

  const session = createAgentSession({
    repoRoot: opts.repoRoot,
    pythonCmd: opts.pythonCmd,
    model: opts.model,
    maxIterations: opts.maxIterations,
    autoApprove,
    verbose: opts.verbose,
    quiet: true,
    getChannel,
  });

  const modeLabel = (): string => (autoApprove ? "auto-approve (changes apply without asking)" : "confirm before changes");

  console.log(`DevAgent ${version(opts.devAgentRoot)}`);
  console.log(opts.model ?? "default model (gemini)");
  console.log(opts.repoRoot);
  console.log(`mode: ${modeLabel()}`);
  console.log(`session ${session.sessionId}`);

  let history: HistoryEntry[] = [];
  let exitCode = 0;
  let quitting = false;

  const shutdown = async (code: number): Promise<void> => {
    if (quitting) return;
    quitting = true;
    channel?.dispose();
    await session.close(code);
  };

  // Ctrl+C at the prompt (or mid-turn): close the session cleanly rather than orphaning the
  // Python child, then leave with the conventional SIGINT exit status.
  process.once("SIGINT", () => {
    console.log("\nbye");
    void shutdown(130).finally(() => process.exit(130));
  });

  try {
    for (;;) {
      if (!session.isAlive()) {
        console.error("\nThe reasoning loop is no longer running, so I can't continue. Run `devagent doctor`.");
        exitCode = 1;
        break;
      }
      console.log(`\n${rule()}`);
      const line = await getChannel().askLine("> ");
      if (line === null) break; // stdin closed (e.g. piped input ended)
      const input = line.trim();
      if (input === "") continue;
      // In a real terminal the user's Enter already moved to a new line; piped input has no echo.
      console.log(process.stdin.isTTY ? rule() : "");

      const lower = input.toLowerCase();
      if (["/exit", "/quit", "exit", "quit"].includes(lower)) break;
      if (lower === "/help" || lower === "?") {
        console.log(HELP_TEXT);
        continue;
      }
      if (lower === "/clear") {
        history = [];
        console.log("Conversation cleared.");
        continue;
      }
      if (lower === "/yolo") {
        autoApprove = !autoApprove;
        session.setAutoApprove(autoApprove);
        console.log(`mode: ${modeLabel()}`);
        continue;
      }
      if (lower === "/status") {
        console.log(`repo:    ${opts.repoRoot}\nmodel:   ${opts.model ?? "default"}\nmode:    ${modeLabel()}\nhistory: ${history.length} message(s)`);
        continue;
      }
      if (input.startsWith("/")) {
        console.log(`Unknown command ${input.split(/\s/)[0]} — type /help.`);
        continue;
      }

      const result = await session.runTurn(input, trimHistory(history));
      if (result.ok) {
        console.log(`\n${result.summary}`);
        history.push({ user: input, assistant: result.summary ?? "" });
      }
    }
  } finally {
    console.log("\nbye");
    process.exitCode = exitCode;
    await shutdown(exitCode);
  }
}
