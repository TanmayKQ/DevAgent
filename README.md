# DevAgent

Autonomous, CLI-based coding assistant. A Node.js/TypeScript **harness** (filesystem, shell,
sandboxing, CLI, audit logging) drives a Python/LangGraph **reasoning loop** (planning, LLM
tool-calling, replanning) over a newline-delimited JSON protocol on stdio. Only the harness
ever touches the filesystem or runs a command; the reasoning loop only ever proposes tool calls.

See `DevAgent_PRD.md` for the full spec and `context.md` for current project state and decisions.

## Status

**M0 (protocol skeleton) and M1 (read-only agent) are done.** The harness can spawn the
reasoning loop and run a full plan -> act -> observe -> reflect -> finish loop against a real
repository using `read_file`, `list_dir`, and `search_code`, backed by Gemini. Every message is
schema-validated and audit-logged. See `context.md` for the milestone checklist and what's next
(write path with confirmation lands at M2).

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
(default 15), `--verbose` (echo raw protocol traffic). Requires `GOOGLE_API_KEY`/`GEMINI_API_KEY`.

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
.devagent/   Runtime output (audit logs). Gitignored.
```
