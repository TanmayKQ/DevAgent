/**
 * The allowlist is the primary safety layer for run_command: a command is only ever spawned
 * if its executable name AND its leading arguments match one of these rules exactly. Everything
 * else is refused before anything runs, regardless of --yolo. Extend this list deliberately —
 * each entry is a decision about what DevAgent is trusted to run unattended.
 */
export interface CommandRule {
  command: string;
  /**
   * If omitted, any arguments are allowed for this command. If present, the actual args must
   * start with (be prefixed by) at least one of these token sequences — e.g. ["run"] permits
   * `npm run <anything>`, since npm run is bounded by scripts the repo itself defines.
   */
  allowedArgPrefixes?: string[][];
}

export const COMMAND_ALLOWLIST: readonly CommandRule[] = [
  { command: "npm", allowedArgPrefixes: [["test"], ["run"]] },
  { command: "npx", allowedArgPrefixes: [["tsc"]] },
  { command: "pytest" },
  { command: "python", allowedArgPrefixes: [["-m", "pytest"]] },
  { command: "node" },
  { command: "git", allowedArgPrefixes: [["status"], ["diff"], ["log"]] },
];

function argsMatchPrefix(actual: string[], prefix: string[]): boolean {
  if (actual.length < prefix.length) return false;
  return prefix.every((token, i) => actual[i] === token);
}

export function isCommandAllowed(command: string, args: string[]): boolean {
  const rule = COMMAND_ALLOWLIST.find((r) => r.command === command);
  if (!rule) return false;
  if (!rule.allowedArgPrefixes) return true;
  return rule.allowedArgPrefixes.some((prefix) => argsMatchPrefix(args, prefix));
}

/**
 * Best-effort screen for a path-like argument that reaches outside the repo (a literal `..`
 * segment, or something that looks like an absolute/UNC path). This is defense in depth, not a
 * real jail: unlike file-tool paths, run_command's args are opaque per-tool flags/values with
 * no generic way to know which ones are paths, so this can be evaded by a determined command
 * (e.g. `git -C ..`). The allowlist — which excludes general-purpose file-access programs — is
 * what's actually carrying the safety weight here; this just catches the obvious case.
 */
export function findSuspiciousArg(args: string[]): string | null {
  for (const arg of args) {
    const segments = arg.split(/[\\/]/);
    if (segments.includes("..")) return arg;
    if (/^[a-zA-Z]:[\\/]/.test(arg) || arg.startsWith("/") || arg.startsWith("\\\\")) return arg;
  }
  return null;
}
