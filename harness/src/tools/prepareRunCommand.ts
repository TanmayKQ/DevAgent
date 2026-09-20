import { statSync } from "node:fs";
import { resolveSafePath } from "./pathJail.js";
import { ToolExecutionError } from "./errors.js";
import { isCommandAllowed, findSuspiciousArg } from "./commandAllowlist.js";

export interface RunCommandArgs {
  command: string;
  args?: string[];
  cwd?: string;
}

/** Validated, ready-to-run command — computed without spawning anything, so the CLI can
 * preview it (and reject it outright) before ever asking for confirmation. */
export interface CommandPlan {
  command: string;
  args: string[];
  relCwd: string;
  safeCwd: string;
}

export function prepareRunCommand(repoRoot: string, rawArgs: RunCommandArgs): CommandPlan {
  const args = rawArgs.args ?? [];
  const relCwd = rawArgs.cwd ?? ".";

  if (!isCommandAllowed(rawArgs.command, args)) {
    throw new ToolExecutionError(
      "command_not_allowed",
      `"${rawArgs.command}${args.length ? " " + args.join(" ") : ""}" is not on the allowed command list`,
    );
  }

  const suspicious = findSuspiciousArg(args);
  if (suspicious) {
    throw new ToolExecutionError(
      "suspicious_argument",
      `argument looks like it reaches outside the repository: ${suspicious}`,
    );
  }

  const safeCwd = resolveSafePath(repoRoot, relCwd);
  const stat = statSync(safeCwd, { throwIfNoEntry: false });
  if (!stat) {
    throw new ToolExecutionError("not_found", `no such directory: ${relCwd}`);
  }
  if (!stat.isDirectory()) {
    throw new ToolExecutionError("not_a_directory", `${relCwd} is not a directory`);
  }

  return { command: rawArgs.command, args, relCwd, safeCwd };
}
