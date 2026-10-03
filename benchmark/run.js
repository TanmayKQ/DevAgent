#!/usr/bin/env node
/**
 * DevAgent benchmark runner. For each task in tasks.json: copies the task's fixture repo to a
 * fresh temp directory, runs the real built `devagent` CLI against it (--yolo, since this runs
 * unattended), then checks the task's `verify` condition. Prints a scorecard.
 *
 * Two modes:
 *   --fake   Uses each task's scripted `fakeResponses` (DEVAGENT_FAKE_LLM_RESPONSES) instead of
 *            a real model call. No API key needed, no cost — this is for proving the runner
 *            itself (copy/spawn/verify/report) works correctly, not for scoring the agent.
 *   (none)   Calls the real configured model (Gemini, via GOOGLE_API_KEY/.env). This is what
 *            actually produces a benchmark score, and costs real API usage.
 *
 * Usage:
 *   node benchmark/run.js --fake
 *   node benchmark/run.js [--filter <substring>] [--model <name>]
 */
const { spawn, execFileSync } = require("node:child_process");
const { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const BENCHMARK_ROOT = __dirname;
const DEVAGENT_ROOT = join(BENCHMARK_ROOT, "..");
const CLI_PATH = join(DEVAGENT_ROOT, "harness", "dist", "cli.js");
const PER_TASK_TIMEOUT_MS = 900000; // live runs on a rate-limited tier spend most of their time waiting

function parseArgs() {
  const args = process.argv.slice(2);
  const filterIdx = args.indexOf("--filter");
  const modelIdx = args.indexOf("--model");
  return {
    fake: args.includes("--fake"),
    verbose: args.includes("--verbose"),
    filter: filterIdx !== -1 ? args[filterIdx + 1] : null,
    model: modelIdx !== -1 ? args[modelIdx + 1] : null,
  };
}

function loadTasks(filter) {
  const all = JSON.parse(readFileSync(join(BENCHMARK_ROOT, "tasks.json"), "utf8")).tasks;
  return filter ? all.filter((t) => t.id.includes(filter)) : all;
}

function runDevAgent(task, repoDir, opts) {
  return new Promise((resolvePromise) => {
    const args = [
      "run",
      task.task,
      "--repo",
      repoDir,
      "--yolo",
      "--max-iterations",
      String(task.maxIterations || 10),
    ];
    if (opts.model) args.push("--model", opts.model);

    const env = { ...process.env };
    if (opts.fake) {
      const fakeScriptPath = join(repoDir, "..", "fake-responses.json");
      writeFileSync(fakeScriptPath, JSON.stringify(task.fakeResponses || []));
      env.DEVAGENT_FAKE_LLM_RESPONSES = fakeScriptPath;
    }

    const child = spawn(process.execPath, [CLI_PATH, ...args], { env });
    // Unattended run: nothing will ever answer an ask_user prompt or a confirmation that
    // somehow got past --yolo, so close stdin immediately — every prompt path treats a closed
    // stream as an immediate (not hung) "no"/empty answer, per confirm.ts's design.
    child.stdin.end();

    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
    }, PER_TASK_TIMEOUT_MS);
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stdout += c.toString()));
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout });
    });
  });
}

function extractFinalAnswer(agentStdout) {
  const match = agentStdout.match(/DevAgent: (.+)/s);
  return match ? match[1].trim() : null;
}

function runVerify(task, repoDir, agentStdout) {
  const v = task.verify;
  if (v.type === "completes") {
    const answer = extractFinalAnswer(agentStdout);
    return answer ? { pass: true, detail: "produced a final answer" } : { pass: false, detail: "no final answer found" };
  }
  if (v.type === "final_answer_contains") {
    const answer = (extractFinalAnswer(agentStdout) || "").toLowerCase();
    const required = (v.all || v.any || []).map((s) => s.toLowerCase());
    const hits = required.map((s) => answer.includes(s));
    const pass = v.all ? hits.every(Boolean) : hits.some(Boolean);
    return { pass, detail: `final answer: "${answer.slice(0, 200)}"` };
  }
  if (v.type === "run_command") {
    try {
      execFileSync(v.command, v.args, { cwd: repoDir, stdio: "pipe", timeout: 30000 });
      return { pass: true, detail: "verify command exited 0" };
    } catch (err) {
      const firstLine = String(err.message).split("\n")[0];
      return { pass: false, detail: `verify command failed: ${firstLine}` };
    }
  }
  return { pass: false, detail: `unknown verify type: ${v.type}` };
}

async function runTask(task, opts) {
  const sourceRepo = join(DEVAGENT_ROOT, "benchmark", "repos", task.repo);
  const workDir = mkdtempSync(join(tmpdir(), `devagent-bench-${task.id}-`));
  const repoCopy = join(workDir, "repo");
  cpSync(sourceRepo, repoCopy, { recursive: true });

  const start = Date.now();
  const { code, stdout } = await runDevAgent(task, repoCopy, opts);
  const elapsedMs = Date.now() - start;

  const result = code !== 0 ? { pass: false, detail: `devagent exited with code ${code}` } : runVerify(task, repoCopy, stdout);

  rmSync(workDir, { recursive: true, force: true });
  return { id: task.id, pass: result.pass, detail: result.detail, elapsedMs, agentStdout: stdout };
}

async function main() {
  const opts = parseArgs();
  if (!existsSync(CLI_PATH)) {
    console.error(`Built CLI not found at ${CLI_PATH} — run "npm run build -w harness" first.`);
    process.exit(1);
  }
  if (!opts.fake && !process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY && !existsSync(join(DEVAGENT_ROOT, ".env"))) {
    console.error("No GOOGLE_API_KEY/GEMINI_API_KEY found and no .env file present. Set one, or pass --fake to smoke-test the runner without a live model.");
    process.exit(1);
  }

  const tasks = loadTasks(opts.filter);
  const modeLabel = opts.fake ? "fake LLM mode (no API key used)" : "LIVE mode — this will call Gemini and use API quota";
  console.log(`Running ${tasks.length} task(s), ${modeLabel}...\n`);

  const results = [];
  for (const task of tasks) {
    process.stdout.write(`${task.id} ... `);
    const result = await runTask(task, opts);
    results.push(result);
    const seconds = (result.elapsedMs / 1000).toFixed(1);
    console.log(result.pass ? `PASS (${seconds}s)` : `FAIL (${seconds}s) — ${result.detail}`);
    if (!result.pass && opts.verbose) {
      console.log("--- agent output ---");
      console.log(result.agentStdout);
      console.log("--- end agent output ---\n");
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const pct = results.length ? ((passed / results.length) * 100).toFixed(0) : "0";
  console.log(`\n${passed}/${results.length} passed (${pct}%)`);

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.log("\nFailed tasks:");
    for (const f of failed) console.log(`  - ${f.id}: ${f.detail}`);
  }

  const resultsDir = join(BENCHMARK_ROOT, "results");
  mkdirSync(resultsDir, { recursive: true });
  const reportPath = join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${opts.fake ? "fake" : "live"}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify(
      { mode: opts.fake ? "fake" : "live", passed, total: results.length, results: results.map(({ agentStdout, ...r }) => r) },
      null,
      2,
    ),
  );
  console.log(`\nReport written to ${reportPath}`);

  process.exitCode = passed === results.length ? 0 : 1;
}

main();
