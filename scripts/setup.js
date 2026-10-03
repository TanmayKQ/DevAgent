#!/usr/bin/env node
/**
 * One-command install for the Python half: creates a private .venv at the repo root and
 * pip-installs the reasoning loop into it. The CLI finds that venv automatically afterwards, so
 * users never have to think about which Python is on their PATH.
 */
const { spawnSync } = require("node:child_process");
const { existsSync, copyFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const venvDir = join(root, ".venv");
const venvPy = process.platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.error || r.status !== 0) {
    console.error(`\nsetup failed while running: ${cmd} ${args.join(" ")}`);
    process.exit(1);
  }
}

function findSystemPython() {
  for (const cmd of [process.env.DEVAGENT_PYTHON, "python3", "python", "py"].filter(Boolean)) {
    const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info[0], sys.version_info[1])"], { encoding: "utf8" });
    if (r.status === 0) {
      const [major, minor] = r.stdout.trim().split(" ").map(Number);
      if (major === 3 && minor >= 10) return cmd;
    }
  }
  return null;
}

if (!existsSync(venvPy)) {
  const py = findSystemPython();
  if (!py) {
    console.error("Python 3.10+ not found. Install it from https://www.python.org/downloads/ (or set DEVAGENT_PYTHON), then re-run `npm run setup`.");
    process.exit(1);
  }
  console.log(`Creating virtualenv at .venv using ${py} ...`);
  run(py, ["-m", "venv", venvDir]);
} else {
  console.log("Reusing existing .venv");
}

console.log("Installing the reasoning loop into .venv (this can take a minute) ...");
run(venvPy, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);
run(venvPy, ["-m", "pip", "install", "--quiet", "-e", "reasoning[dev]"]);

const envFile = join(root, ".env");
if (!existsSync(envFile)) {
  copyFileSync(join(root, ".env.example"), envFile);
  console.log("\nCreated .env from .env.example — open it and add your GOOGLE_API_KEY.");
}

console.log("\nSetup complete. Next: add your key to .env, then run `npm run build` and `node harness/dist/cli.js doctor`.");
