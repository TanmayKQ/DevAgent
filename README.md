# DevAgent

Autonomous, CLI-based coding assistant. A Node.js/TypeScript **harness** (filesystem, shell,
sandboxing, CLI, audit logging) drives a Python/LangGraph **reasoning loop** (planning, LLM
tool-calling, replanning) over a newline-delimited JSON protocol on stdio. Only the harness
ever touches the filesystem or runs a command; the reasoning loop only ever proposes tool calls.

See `DevAgent_PRD.md` for the full spec and `context.md` for current project state and decisions.

## Status

**M0-M4 are done** (protocol skeleton, read-only agent, write path, command execution, full
loop + benchmark). The harness runs a full plan -> act -> observe -> reflect -> finish loop
against a real repository using `read_file`, `list_dir`, `search_code`, `write_file`,
`apply_patch`, `run_command`, and `ask_user`, backed by Gemini. Every write and every command is
shown to the user and requires confirmation by default (`--yolo`/`--auto` to skip the prompt).
`run_command` only ever runs a fixed allowlist of commands (test runners, builds, type-checks,
read-only git), with no shell, a restricted environment, a timeout, and capped output. Every
message is schema-validated and audit-logged. A 17-task benchmark (`benchmark/`) exercises the
whole loop against two fixture repos with real bugs. See `context.md` for the milestone
checklist and what's next (M5: hardening, packaging, docs, demo).

## Setup

Prerequisites: Node.js 18+, Python 3.10+.

```bash
npm install                      # installs harness deps (npm workspaces)
pip install -e reasoning[dev]    # installs the reasoning loop in editable mode
```

If `python` doesn't resolve to your intended interpreter, set `DEVAGENT_PYTHON=<path>` (used
by the CLI and by the integration tests).

### LLM provider

DevAgent uses Google Gemini via `langchain-google-genai`. Copy `.env.example` to `.env` at the
repo root and fill in your key:

```
GOOGLE_API_KEY=your-key-here
```

(`GEMINI_API_KEY` also works, checked as a fallback.) `.env` is gitignored and loaded
automatically by the reasoning loop — no key ever needs to be passed on the command line.

## Verify the harness <-> reasoning-loop handshake

```bash
npm run build
node harness/dist/cli.js selftest --verbose
```

This spawns the Python reasoning loop, sends a `ping`, waits for the matching `pong`, and
prints the round-trip time. No API key needed.

## Run a task against a repository

```bash
node harness/dist/cli.js run "what does this repo do?" --repo /path/to/some/repo --verbose
```

Streams each plan step and tool call live, then prints DevAgent's final answer. Flags:
`--repo <path>` (required), `--model <name>` (default `gemini-2.5-flash`), `--max-iterations <n>`
(default 15), `--yolo`/`--auto` (skip write confirmation), `--verbose` (echo raw protocol
traffic). Requires `GOOGLE_API_KEY`/`GEMINI_API_KEY`.

Any `write_file` or `apply_patch` call is shown as a unified diff and needs a `y`/`N` answer
before it's applied — decline and the reasoning loop gets told so it can adapt. `--yolo`/`--auto`
applies changes without asking (the diff is still printed and still logged).

### Running commands (`run_command`)

Only a fixed allowlist of commands can ever run, regardless of mode: `npm test`, `npm run
<script>`, `npx tsc`, `pytest`, `python -m pytest`, `node <file>`, and read-only `git
status`/`diff`/`log`. Nothing else — no installs, no destructive git, no general-purpose shell
tools — is ever permitted, and there's no shell in the loop (so no `;`/`&&`/`|`/redirection).
Each command also runs with a restricted environment (no API keys or other secrets DevAgent is
holding are passed through), a timeout, and capped output. Like writes, every command is shown
(`DevAgent wants to run: <command>`) and confirmed before it runs, unless `--yolo`/`--auto`.

### Asking you a question (`ask_user`)

When the task is genuinely ambiguous or the agent has tried multiple reasonable fixes and is
still stuck, it can pause and ask a free-text question instead of guessing indefinitely:

```
DevAgent asks: Should I use tabs or spaces?
>
```

Your typed answer becomes its next observation and it continues the task. Unlike write/command
confirmations, this isn't a risk gate (asking has no side effect), so it always happens — it's
never skipped by `--yolo`/`--auto`.

## Benchmark

`benchmark/` has 17 hand-authored tasks (real bugs to fix, a function to add, read-only
questions, and two deliberately ambiguous tasks) across two small fixture repos, run end-to-end
through the real CLI with an automated pass/fail check per task. See `benchmark/README.md`.

```bash
node benchmark/run.js --fake   # smoke-test the runner, no API key needed
node benchmark/run.js          # the real scored run — calls Gemini, uses API quota
```

## Tests

```bash
npm test                          # harness unit + integration tests (Vitest)
python -m pytest reasoning/tests  # reasoning-loop unit tests (pytest)
```

No test requires a live API key — the reasoning loop honors `DEVAGENT_FAKE_LLM_RESPONSES`
(path to a JSON file of scripted `{"tool_call": {...}}` / `{"text": "..."}` steps) to swap in a
scripted model, which is what the end-to-end integration test uses to exercise the real
cross-process wire protocol and real tool execution without calling Gemini.

The integration tests spawn `python -m devagent_reasoning`, so the reasoning package must be
installed (`pip install -e reasoning[dev]`) in whichever interpreter `python` (or
`DEVAGENT_PYTHON`) resolves to.

## Repo layout

```
harness/     Node/TypeScript package — CLI, protocol framing/validation, process lifecycle,
             audit logging, path-jailed tool implementations. The only package with real side
             effects.
reasoning/   Python package — devagent_reasoning: protocol mirror, the LangGraph
             plan/act/observe/reflect/finish graph, and the Gemini-backed model.
schemas/     Single source of truth JSON Schemas for the wire protocol AND for each tool's
             arguments (also reused as the LLM's tool-call descriptions). Both packages load
             these exact files (ajv on the TS side, jsonschema on the Python side) so the two
             implementations can't silently drift apart.
benchmark/   17-task benchmark: fixture repos with real bugs (repos/), task definitions
             (tasks.json), and the runner (run.js). See benchmark/README.md.
.devagent/   Runtime output (audit logs). Gitignored.
```
