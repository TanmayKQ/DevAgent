import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export function checkNodeVersion(version: string): Check {
  const major = Number.parseInt(version.replace(/^v/, ""), 10);
  return major >= 18
    ? { name: "Node.js", ok: true, detail: version }
    : { name: "Node.js", ok: false, detail: `${version} (need 18+)`, fix: "Install Node.js 18 or newer." };
}

/** Looks for a non-empty key in the environment or in .env text. Never returns the key itself. */
export function checkApiKey(env: NodeJS.ProcessEnv, envFileText: string | null): Check {
  const names = ["GOOGLE_API_KEY", "GEMINI_API_KEY"];
  const fromEnv = names.some((n) => (env[n] ?? "").trim().length > 0);
  const fromFile =
    envFileText !== null &&
    envFileText.split(/\r?\n/).some((line) => {
      const m = line.match(/^\s*(GOOGLE_API_KEY|GEMINI_API_KEY)\s*=\s*(.*)$/);
      return m !== null && m[2].replace(/^["']|["']$/g, "").trim().length > 0;
    });
  return fromEnv || fromFile
    ? { name: "Gemini API key", ok: true, detail: "found" }
    : {
        name: "Gemini API key",
        ok: false,
        detail: "not set",
        fix: "Add GOOGLE_API_KEY=... to .env (get one at https://aistudio.google.com/apikey).",
      };
}

export function checkPythonVersion(output: string | null): Check {
  if (output === null) {
    return { name: "Python", ok: false, detail: "could not run", fix: "Run `npm run setup`, or set DEVAGENT_PYTHON." };
  }
  const [major, minor] = output.trim().split(" ").map(Number);
  return major === 3 && minor >= 10
    ? { name: "Python", ok: true, detail: `${major}.${minor}` }
    : { name: "Python", ok: false, detail: `${major}.${minor} (need 3.10+)`, fix: "Install Python 3.10+ and re-run `npm run setup`." };
}

function tryRun(python: string, code: string): string | null {
  const r = spawnSync(python, ["-c", code], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}

export function runDoctor(repoRoot: string, python: string, env: NodeJS.ProcessEnv): Check[] {
  const checks: Check[] = [checkNodeVersion(process.version)];

  checks.push(checkPythonVersion(tryRun(python, "import sys; print(sys.version_info[0], sys.version_info[1])")));

  const importable = tryRun(python, "import devagent_reasoning, langgraph, langchain_google_genai; print('ok')");
  checks.push(
    importable
      ? { name: "Reasoning loop installed", ok: true, detail: `via ${python}` }
      : {
          name: "Reasoning loop installed",
          ok: false,
          detail: `not importable by ${python}`,
          fix: "Run `npm run setup` (creates .venv and installs it).",
        },
  );

  const envPath = join(repoRoot, ".env");
  checks.push(checkApiKey(env, existsSync(envPath) ? readFileSync(envPath, "utf8") : null));

  const schemasOk = existsSync(join(repoRoot, "schemas", "envelope.schema.json"));
  checks.push({ name: "Protocol schemas", ok: schemasOk, detail: schemasOk ? "found" : "missing", fix: "Re-clone the repo." });

  return checks;
}

export function formatChecks(checks: Check[]): string {
  const lines = checks.map((c) => `${c.ok ? "ok  " : "FAIL"}  ${c.name}: ${c.detail}${c.ok || !c.fix ? "" : `\n      -> ${c.fix}`}`);
  const failed = checks.filter((c) => !c.ok).length;
  lines.push("", failed === 0 ? "All good — you're ready to run `devagent run`." : `${failed} problem(s) found.`);
  return lines.join("\n");
}
