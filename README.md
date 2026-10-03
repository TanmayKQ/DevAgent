# DevAgent

An autonomous, CLI-based coding assistant. Give it a task in plain English and a repository; it
reads the code, makes changes, runs the tests, checks its own work, and shows you everything it
does — with a diff and a confirmation before anything is written or run.

```
$ devagent run "fix the failing test for clamp() in src/math.js" --repo ./my-project
→ planning
  ⚙ read_file({"path":"src/math.js"})
  ⚙ apply_patch(...)
--- a/src/math.js
+++ b/src/math.js
-  return Math.min(n, min, max);
+  return Math.min(Math.max(n, min), max);
Apply this apply_patch to src/math.js? [y/N] y
  ⚙ run_command(npm test)  →  exit code: 0
DevAgent: Fixed clamp() to bound n between min and max; the clamp tests now pass.
```

It is built as two cooperating processes — a **Node/TypeScript harness** that owns everything
with side effects (files, commands, safety, logging) and a **Python/LangGraph reasoning loop**
that only plans and proposes actions. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quickstart

Requires Node.js 18+, Python 3.10+, and a [Gemini API key](https://aistudio.google.com/apikey).

```bash
npm install          # JavaScript dependencies
npm run setup        # creates a private .venv, installs the Python side, creates .env
# open .env and set GOOGLE_API_KEY=your-key
npm run build
npm run doctor       # checks everything is wired up correctly
```

Then:

```bash
npm run devagent -- run "what does this repo do?" --repo /path/to/your/project
```

`devagent doctor` tells you exactly what's wrong (and how to fix it) if anything isn't ready.

## Commands

| Command | What it does |
|---|---|
| `devagent run "<task>" --repo <path>` | Run a task against a repository |
| `devagent doctor` | Check Node, Python, the Python install, and your API key |
| `devagent replay <session\|latest>` | Print a past session's audit log as a readable transcript |
| `devagent selftest` | Verify the two processes can talk to each other (no API key needed) |

`run` flags: `--repo <path>` (required), `--model <name>` (default `gemini-3.8-flash`),
`--max-iterations <n>` (default 15), `--yolo` / `--auto` (skip confirmation prompts),
`--verbose` (echo raw protocol traffic). Global: `--python <cmd>` to override which Python is used.

## What it can do, and how it stays safe

The agent has seven tools: `read_file`, `list_dir`, `search_code`, `write_file`, `apply_patch`,
`run_command`, and `ask_user`.

- **Confirm by default.** Every write is shown as a diff and every command is shown before it
  runs; you answer `y`/`N`. Declining isn't a failure — the agent is told and adapts.
  `--yolo`/`--auto` skips only the prompt; everything below still applies.
- **A repository jail.** File tools resolve every path inside the repo root, rejecting `..`,
  absolute paths, UNC paths, and symlinks that point outside it. The harness enforces this; the
  Python side is never trusted with paths.
- **A command allowlist.** `run_command` only ever runs `npm test`, `npm run <script>`,
  `npx tsc`, `pytest`, `python -m pytest`, `node <file>`, and read-only `git status/diff/log`.
  Nothing else — no installs, no destructive git, no general shell tools — in any mode.
- **No shell.** Commands are spawned with an argument array, so `;`, `&&`, `|`, and redirection
  have nothing to act on. Commands run with a restricted environment (your API key is not
  passed through), a timeout with real process-tree kill, and capped output.
- **Everything is logged.** Every message in both directions is appended to
  `.devagent/logs/<session>.jsonl`; `devagent replay` reads it back.
- **It asks when it's stuck.** `ask_user` pauses for a free-text answer instead of guessing.

This is rule-based safety on a normal process, **not** OS-level isolation (no container or VM).
The allowlist and the jail do the real work; see the architecture doc for the honest limits.

## Benchmark

`benchmark/` holds 17 hand-authored tasks (real bugs, a missing function, read-only questions,
two ambiguous tasks) across two fixture repos, each with an automated pass/fail check. See
[benchmark/README.md](benchmark/README.md).

```bash
node benchmark/run.js --fake   # smoke-test the runner, no API key, no cost
node benchmark/run.js          # the real scored run — calls Gemini, uses API quota
```

Note that Gemini's free tier is capped at 20 requests/day per model — far too few for a full
run. Use a key with billing enabled (17 tasks cost well under a dollar). The agent waits out
short per-minute rate limits automatically and fails fast with a clear message on a daily cap.

## Tests

```bash
npm test                          # harness unit + integration tests (Vitest)
python -m pytest reasoning/tests  # reasoning-loop tests (pytest)
```

No test needs an API key: the reasoning loop honors `DEVAGENT_FAKE_LLM_RESPONSES` (a JSON file
of scripted steps) to stand in for the model, so the integration tests exercise the real
cross-process protocol and real tool execution without calling Gemini.

## Repo layout

```
harness/     Node/TypeScript — CLI, protocol, process lifecycle, audit log, jailed tools
reasoning/   Python — protocol mirror, LangGraph plan/act/observe/reflect/finish graph, Gemini model
schemas/     JSON Schemas shared by both sides: wire protocol AND each tool's arguments
benchmark/   17-task benchmark: fixture repos, task definitions, runner
scripts/     setup.js (one-command install)
docs/        Architecture and demo script
```

Project state and every design decision (with the reasoning) live in `context.md`;
the original requirements are in `DevAgent_PRD.md`.
