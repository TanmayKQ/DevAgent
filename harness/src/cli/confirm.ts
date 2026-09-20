/**
 * A minimal, hand-rolled line reader — deliberately NOT node:readline's Interface. Interface
 * turned out to be unsafe for asking multiple sequential questions over piped/scripted input:
 * it auto-closes itself as soon as its underlying stream ends, even if a later line is already
 * sitting in its internal buffer waiting for a question that hasn't been asked yet. With piped
 * input (the whole answer script arrives and the stream ends almost immediately), that meant a
 * second confirm() call could throw "readline was closed" — or, with a fresh Interface created
 * per question instead of shared, silently lose the second answer instead of throwing. Found by
 * actually running a task with two confirmable tool calls end-to-end, not just a single-question
 * unit test — see confirm.test.ts's regression test for the reproduction.
 *
 * A plain TTY still gets normal line editing/echo/backspace for free from the OS terminal driver
 * itself (that's "cooked mode", the default) — none of that is readline's doing, so nothing is
 * lost by not using it here.
 */
class LineReader {
  private buffer = "";
  private ended = false;
  private pending: ((line: string | null) => void) | null = null;

  private readonly onData = (chunk: string | Buffer): void => {
    this.buffer += chunk.toString();
    this.flush();
  };

  private readonly onEnd = (): void => {
    this.ended = true;
    this.flush();
  };

  constructor(private readonly input: NodeJS.ReadableStream) {
    input.on("data", this.onData);
    input.on("end", this.onEnd);
    input.on("close", this.onEnd);
  }

  private flush(): void {
    if (!this.pending) return;
    const newlineIndex = this.buffer.indexOf("\n");
    if (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const resolve = this.pending;
      this.pending = null;
      resolve(line);
      return;
    }
    if (this.ended) {
      const resolve = this.pending;
      this.pending = null;
      resolve(null);
    }
  }

  /** Resolves with the next line, or null if the stream ended with no (more) lines. Only one
   * call may be in flight at a time — confirm() always awaits one answer before asking again. */
  readLine(): Promise<string | null> {
    return new Promise((resolve) => {
      this.pending = resolve;
      this.flush();
    });
  }

  /** Stops consuming the stream. Required before process exit — adding the 'data' listener
   * above switches the stream into flowing mode, which otherwise keeps a real process alive. */
  dispose(): void {
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("close", this.onEnd);
    (this.input as { pause?: () => void }).pause?.();
  }
}

export interface ConfirmChannel {
  /** Prompts on the channel's output and resolves true only for an explicit y/yes
   * (case-insensitive) — anything else, including empty input or a closed stream, is "no". */
  ask(question: string): Promise<boolean>;
  /** Prompts on the channel's output and resolves with the raw line typed back (for ask_user,
   * which wants a free-text answer, not a yes/no) — empty string if the stream closed with no
   * answer, same "absence is not an error" spirit as ask(). */
  askText(question: string): Promise<string>;
  /** Releases the underlying input stream so the process can exit naturally. Call once, after
   * the last ask()/askText(). */
  dispose(): void;
}

/** Create exactly one channel per session and reuse it for every prompt in that session (see
 * the class doc above for why) — confirmations and free-text questions share the same reader. */
export function createConfirmChannel(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): ConfirmChannel {
  const reader = new LineReader(input);
  return {
    async ask(question: string): Promise<boolean> {
      output.write(question);
      const line = await reader.readLine();
      return line !== null && /^y(es)?$/i.test(line.trim());
    },
    async askText(question: string): Promise<string> {
      output.write(question);
      const line = await reader.readLine();
      return line ?? "";
    },
    dispose(): void {
      reader.dispose();
    },
  };
}
