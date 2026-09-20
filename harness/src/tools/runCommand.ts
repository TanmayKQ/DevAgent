import { spawn } from "node:child_process";
import { prepareRunCommand, type RunCommandArgs, type CommandPlan } from "./prepareRunCommand.js";

export type { RunCommandArgs };

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

// Everything a command actually needs to find and run `npm`/`node`/`python`/`git` correctly on
// Windows or POSIX — nothing else. Notably excludes GOOGLE_API_KEY/GEMINI_API_KEY and anything
// else DevAgent itself might be holding: a child command has no business reading those.
const ENV_KEEP_NAMES = new Set([
  "path",
  "systemroot",
  "systemdrive",
  "temp",
  "tmp",
  "appdata",
  "localappdata",
  "programfiles",
  "programfiles(x86)",
  "windir",
  "home",
  "userprofile",
  "pathext",
  "comspec",
]);

function buildRestrictedEnv(): NodeJS.ProcessEnv {
  const restricted: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ENV_KEEP_NAMES.has(key.toLowerCase())) {
      restricted[key] = value;
    }
  }
  return restricted;
}

/** Force-kills a command and (best-effort) any child processes it spawned. A plain
 * `child.kill()` only kills the immediate process — on Windows especially, a hung `npm test`
 * that has spawned its own subprocess would otherwise survive the timeout. */
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // negative pid = the whole process group (see `detached` below)
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
  }
}

function makeCollector(maxBytes: number) {
  let buf = Buffer.alloc(0);
  let truncated = false;
  return {
    push(chunk: Buffer): void {
      if (truncated) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > maxBytes) {
        buf = buf.subarray(0, maxBytes);
        truncated = true;
      }
    },
    get text(): string {
      return buf.toString("utf8");
    },
    get isTruncated(): boolean {
      return truncated;
    },
  };
}

export interface RunCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
}

/** Actually spawns an already-validated plan. Separate from runCommand() so the CLI can
 * validate + preview via prepareRunCommand(), ask for confirmation, and only then call this —
 * without re-resolving anything between "shown to the user" and "what actually ran". */
export async function executePlan(plan: CommandPlan, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunCommandResult> {
  const stdout = makeCollector(MAX_OUTPUT_BYTES);
  const stderr = makeCollector(MAX_OUTPUT_BYTES);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;

    const child = spawn(plan.command, plan.args, {
      cwd: plan.safeCwd,
      env: buildRestrictedEnv(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.isTruncated,
        stderrTruncated: stderr.isTruncated,
        timedOut,
      });
    });
  });
}

export async function runCommand(
  repoRoot: string,
  args: RunCommandArgs,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RunCommandResult> {
  const plan = prepareRunCommand(repoRoot, args);
  return executePlan(plan, timeoutMs);
}
