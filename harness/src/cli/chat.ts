import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createConfirmChannel, type ConfirmChannel } from "./confirm.js";
import { createTtyChannel, type TtyChannel } from "./ttyChannel.js";
import { Screen } from "./screen.js";
import { createAgentSession, type HistoryEntry } from "../session.js";

export interface ChatOptions {
  repoRoot: string;
  pythonCmd: string;
  model?: string;
  fast?: boolean;
  maxIterations: number;
  autoApprove: boolean;
  verbose: boolean;
  devAgentRoot: string;
}

const MAX_HISTORY_TURNS = 8;
const MAX_ASSISTANT_CHARS = 1500;
const RESIZE_DEBOUNCE_MS = 120;

export const HELP_TEXT = [
  "Type a task or question in plain English and press Enter.",
  "",
  "  /help     show this help",
  "  /yolo     toggle auto-approve (skip the y/N prompt for writes and commands)",
  "  /fast     toggle fast mode (model skips extended thinking: quicker replies, less careful)",
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

function version(devAgentRoot: string): string {
  try {
    return JSON.parse(readFileSync(join(devAgentRoot, "package.json"), "utf8")).version as string;
  } catch {
    return "dev";
  }
}

export async function runChat(opts: ChatOptions): Promise<void> {
  // A real terminal gets the full experience (line editing, redraw on resize). Piped input (tests,
  // scripts) keeps the simple line reader. DEVAGENT_PLAIN_UI=1 forces the simple path as an escape hatch.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.DEVAGENT_PLAIN_UI);

  const screen = new Screen(process.stdout);
  const print = (text = ""): void => screen.print(text);
  const printError = (text: string): void => {
    screen.record(text);
    process.stderr.write(`${text}\n`);
  };

  let autoApprove = opts.autoApprove;
  let fast = opts.fast ?? false;

  let channel: ConfirmChannel;
  let tty: TtyChannel | undefined;
  if (interactive) {
    tty = createTtyChannel(process.stdin, process.stdout, (t) => screen.record(t));
    channel = tty;
  } else {
    channel = createConfirmChannel();
  }

  const session = createAgentSession({
    repoRoot: opts.repoRoot,
    pythonCmd: opts.pythonCmd,
    model: opts.model,
    fast,
    maxIterations: opts.maxIterations,
    autoApprove,
    verbose: opts.verbose,
    quiet: true,
    print,
    printError,
    getChannel: () => channel,
  });

  const modeLabel = (): string => (autoApprove ? "auto-approve (changes apply without asking)" : "confirm before changes");
  const thinkingLabel = (): string => (fast ? "fast (extended thinking off)" : "thorough (extended thinking on)");

  print(`DevAgent ${version(opts.devAgentRoot)}`);
  print(opts.model ?? "default model (gemini)");
  print(opts.repoRoot);
  print(`mode: ${modeLabel()}  ·  replies: ${thinkingLabel()}`);
  print(`session ${session.sessionId}  ·  /help for commands`);

  let history: HistoryEntry[] = [];
  let exitCode = 0;
  let quitting = false;
  let busy = false; // a task is running (or a confirmation is open) — don't redraw underneath it

  const shutdown = async (code: number): Promise<void> => {
    if (quitting) return;
    quitting = true;
    channel.dispose();
    await session.close(code);
  };

  const interrupt = (): void => {
    print("\nbye");
    void shutdown(130).finally(() => process.exit(130));
  };
  if (tty) tty.onInterrupt(interrupt);
  else process.once("SIGINT", interrupt);

  // Window resize: remember what was shown, clear, and draw it again at the new width. Only when
  // idle at the prompt; a resize mid-task is applied as soon as the task finishes.
  let dirty = false;
  let lastCols = process.stdout.columns;
  let resizeTimer: NodeJS.Timeout | undefined;
  if (interactive) {
    process.stdout.on("resize", () => {
      if (process.stdout.columns === lastCols) return; // height-only change: nothing to redraw
      lastCols = process.stdout.columns;
      dirty = true;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!busy && dirty) {
          screen.redraw();
          tty?.redrawPrompt();
          dirty = false;
        }
      }, RESIZE_DEBOUNCE_MS);
    });
  }

  try {
    for (;;) {
      if (!session.isAlive()) {
        printError("\nThe reasoning loop is no longer running, so I can't continue. Run `devagent doctor`.");
        exitCode = 1;
        break;
      }
      if (dirty) {
        screen.redraw();
        dirty = false;
      }
      print("");
      screen.rule();
      const line = await channel.askLine("> ");
      if (line === null) break; // stdin closed (Ctrl+D, or piped input ended)
      const input = line.trim();
      if (input === "") continue;
      // In a real terminal the user's Enter already moved to a new line; piped input has no echo.
      if (interactive) screen.rule();
      else print("");

      const lower = input.toLowerCase();
      if (["/exit", "/quit", "exit", "quit"].includes(lower)) break;
      if (lower === "/help" || lower === "?") {
        print(HELP_TEXT);
        continue;
      }
      if (lower === "/clear") {
        history = [];
        print("Conversation cleared.");
        continue;
      }
      if (lower === "/yolo") {
        autoApprove = !autoApprove;
        session.setAutoApprove(autoApprove);
        print(`mode: ${modeLabel()}`);
        continue;
      }
      if (lower === "/fast") {
        fast = !fast;
        session.setFast(fast);
        print(`replies: ${thinkingLabel()}`);
        continue;
      }
      if (lower === "/status") {
        print(
          `repo:    ${opts.repoRoot}\nmodel:   ${opts.model ?? "default"}\nmode:    ${modeLabel()}\nreplies: ${thinkingLabel()}\nhistory: ${history.length} message(s)`,
        );
        continue;
      }
      if (input.startsWith("/")) {
        print(`Unknown command ${input.split(/\s/)[0]} — type /help.`);
        continue;
      }

      busy = true;
      let result;
      try {
        result = await session.runTurn(input, trimHistory(history));
      } finally {
        busy = false;
      }
      if (result.ok) {
        print(`\n${result.summary}`);
        history.push({ user: input, assistant: result.summary ?? "" });
      }
    }
  } finally {
    clearTimeout(resizeTimer);
    print("\nbye");
    process.exitCode = exitCode;
    await shutdown(exitCode);
  }
}
