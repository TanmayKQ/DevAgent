import { createInterface } from "node:readline";

/**
 * Prompts on `output` and resolves true only for an explicit y/yes (case-insensitive) —
 * anything else, including empty input or a closed stream, is treated as "no". Streams are
 * injectable so tests can simulate a user's answer without a real TTY.
 */
export async function confirm(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    return await new Promise<boolean>((resolve) => {
      let answered = false;
      rl.question(question, (answer) => {
        answered = true;
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
      // If the input stream ends (EOF) before a full line comes in — a closed/non-interactive
      // stdin — `question`'s callback never fires on its own. Without this, confirm() would
      // hang forever instead of falling back to the safe "no" default.
      rl.on("close", () => {
        if (!answered) resolve(false);
      });
    });
  } finally {
    rl.close();
  }
}
