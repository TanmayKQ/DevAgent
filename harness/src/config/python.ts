import { existsSync } from "node:fs";
import { join } from "node:path";

/** The private virtualenv created by `npm run setup`, if it exists. */
export function venvPython(repoRoot: string): string | null {
  const candidate =
    process.platform === "win32"
      ? join(repoRoot, ".venv", "Scripts", "python.exe")
      : join(repoRoot, ".venv", "bin", "python");
  return existsSync(candidate) ? candidate : null;
}

/**
 * Which Python runs the reasoning loop. An explicit choice (--python or DEVAGENT_PYTHON) always
 * wins; otherwise the private venv from `npm run setup`; otherwise whatever `python` is on PATH.
 */
export function resolvePython(explicit: string | undefined, repoRoot: string): string {
  return explicit || venvPython(repoRoot) || "python";
}
