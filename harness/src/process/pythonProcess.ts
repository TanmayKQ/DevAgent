import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LineFramer, encodeMessage } from "../protocol/framing.js";
import { validateEnvelope, createEnvelope, initSchemas, type Envelope } from "../protocol/envelope.js";
import { findRepoRoot } from "../config/repoPaths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface PythonProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Owns the lifecycle of the Python reasoning-loop subprocess: spawn, health-check
 * (ping/pong), framed send/receive, and graceful-then-forceful shutdown.
 *
 * Events: "send" (Envelope, outbound), "message" (Envelope, inbound & schema-valid),
 * "stderr" (string), "exit" (number | null), "error" (Error).
 */
export class PythonReasoningProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly framer = new LineFramer();

  constructor(private readonly options: PythonProcessOptions) {
    super();
  }

  start(): void {
    if (this.child) throw new Error("process already started");
    // Resolved from this module's own location (not options.cwd) so schema validation
    // works regardless of what working directory the child process is spawned in.
    initSchemas(join(findRepoRoot(__dirname), "schemas"));
    this.child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1", ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk: Buffer) => this.onStdoutData(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString("utf8")));
    this.child.on("exit", (code) => this.emit("exit", code));
    this.child.on("error", (err) => this.emit("error", err));
  }

  private onStdoutData(chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.framer.push(chunk);
    } catch (err) {
      this.emit("error", err as Error);
      return;
    }
    for (const line of lines) {
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch (err) {
      this.emit("error", new Error(`invalid JSON from reasoning loop: ${(err as Error).message}`));
      return;
    }
    const result = validateEnvelope(data);
    if (!result.valid) {
      this.emit("error", new Error(`schema validation failed: ${result.errors.join("; ")}`));
      return;
    }
    this.emit("message", data as Envelope);
  }

  send(envelope: Envelope): void {
    if (!this.child) throw new Error("process not started");
    this.emit("send", envelope);
    this.child.stdin.write(encodeMessage(envelope));
  }

  /** Sends a ping and resolves with the matching pong, or rejects on timeout. */
  async ping(sessionId: string, timeoutMs = 5000): Promise<Envelope> {
    const pingEnvelope = createEnvelope("ping", {}, sessionId);
    return new Promise((resolve, reject) => {
      const onMessage = (envelope: Envelope) => {
        if (envelope.type === "pong") {
          clearTimeout(timer);
          this.off("message", onMessage);
          resolve(envelope);
        }
      };
      const timer = setTimeout(() => {
        this.off("message", onMessage);
        reject(new Error(`ping timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.on("message", onMessage);
      this.send(pingEnvelope);
    });
  }

  /** SIGTERM, escalating to SIGKILL after `graceMs` if the child hasn't exited. */
  async stop(graceMs = 2000): Promise<number | null> {
    if (!this.child) return null;
    const child = this.child;
    return new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, graceMs);
      child.once("exit", (code) => {
        clearTimeout(killTimer);
        resolve(code);
      });
      child.kill("SIGTERM");
    });
  }
}
