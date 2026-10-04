/**
 * Why this exists: terminal output is write-once. A separator printed as 80 dashes stays 80
 * dashes forever — the terminal doesn't know it was meant to span the window. To make the UI
 * adapt to a resize, the program has to remember *what* it showed (not just the characters),
 * and on a resize event clear the screen and draw it all again for the new width.
 *
 * So everything the chat shows goes through here. Plain text is stored as-is (the terminal
 * re-wraps that itself); a separator is stored as "a rule" and only turned into dashes at draw
 * time, using the width at that moment.
 */
export type Block = { kind: "text"; text: string } | { kind: "rule" };

export interface ScreenOutput {
  write(chunk: string): unknown;
  columns?: number;
}

/** Clears the visible screen AND the scrollback (3J), then homes the cursor. */
export const CLEAR_SCREEN = "\x1b[2J\x1b[3J\x1b[H";

const MAX_BLOCKS = 3000;
const MAX_RULE_WIDTH = 100;

export class Screen {
  private blocks: Block[] = [];

  constructor(private readonly out: ScreenOutput) {}

  width(): number {
    return Math.max(10, Math.min(this.out.columns ?? 80, MAX_RULE_WIDTH));
  }

  private ruleText(): string {
    return "─".repeat(this.width());
  }

  private remember(block: Block): void {
    this.blocks.push(block);
    if (this.blocks.length > MAX_BLOCKS) this.blocks.splice(0, this.blocks.length - MAX_BLOCKS);
  }

  /** Show text (one or more lines) and remember it. */
  print(text = ""): void {
    this.remember({ kind: "text", text });
    this.out.write(`${text}\n`);
  }

  /** Show a full-width separator and remember it as a *rule*, so a redraw can resize it. */
  rule(): void {
    this.remember({ kind: "rule" });
    this.out.write(`${this.ruleText()}\n`);
  }

  /** Remember text that is already on screen (e.g. echoed by the terminal as the user typed it)
   * without writing it again. */
  record(text: string): void {
    this.remember({ kind: "text", text });
  }

  /** Clear everything and draw the remembered conversation again at the current width. */
  redraw(): void {
    this.out.write(CLEAR_SCREEN);
    for (const b of this.blocks) {
      this.out.write(b.kind === "rule" ? `${this.ruleText()}\n` : `${b.text}\n`);
    }
  }

  get blockCount(): number {
    return this.blocks.length;
  }
}
