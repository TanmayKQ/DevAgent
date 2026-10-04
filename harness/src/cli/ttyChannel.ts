import { createInterface, type Interface } from "node:readline";
import type { ConfirmChannel } from "./confirm.js";

export interface TtyChannel extends ConfirmChannel {
  /** Repaint the active prompt and whatever the user has typed so far (used after a screen redraw). */
  redrawPrompt(): void;
  /** Called when the user presses Ctrl+C. Without a handler readline would swallow it. */
  onInterrupt(handler: () => void): void;
}

/**
 * The prompt channel for a real terminal. Unlike the piped-input LineReader, this lets Node's
 * readline own the keyboard (raw mode): it handles line editing and history, and — crucially for
 * resize-aware redrawing — it knows the half-typed line, so a redraw can repaint it instead of
 * losing it. (node:readline was avoided for *piped* input because it auto-closes when a pipe ends;
 * that can't happen with an interactive terminal, which only ends on Ctrl+D.)
 *
 * `record` is told what each prompt+answer looked like, so the Screen can include it when it
 * redraws the conversation.
 */
export function createTtyChannel(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  record: (text: string) => void,
): TtyChannel {
  const rl: Interface = createInterface({ input, output, terminal: true, historySize: 100 });
  let closed = false;
  let waiting = false;
  rl.on("close", () => {
    closed = true;
  });

  function askLine(question: string): Promise<string | null> {
    if (closed) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      waiting = true;
      const onClose = (): void => {
        waiting = false;
        resolve(null);
      };
      rl.once("close", onClose);
      rl.question(question, (answer) => {
        waiting = false;
        rl.off("close", onClose);
        record(`${question}${answer}`);
        resolve(answer);
      });
    });
  }

  return {
    askLine,
    async ask(question: string): Promise<boolean> {
      const line = await askLine(question);
      return line !== null && /^y(es)?$/i.test(line.trim());
    },
    async askText(question: string): Promise<string> {
      return (await askLine(question)) ?? "";
    },
    redrawPrompt(): void {
      if (waiting && !closed) rl.prompt(true);
    },
    onInterrupt(handler: () => void): void {
      rl.on("SIGINT", handler);
    },
    dispose(): void {
      if (!closed) rl.close();
    },
  };
}
