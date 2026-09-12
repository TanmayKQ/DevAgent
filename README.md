# DevAgent

Autonomous, CLI-based coding assistant. A Node.js/TypeScript **harness** (filesystem, shell,
sandboxing, CLI, audit logging) drives a Python/LangGraph **reasoning loop** (planning, LLM
tool-calling, replanning) over a newline-delimited JSON protocol on stdio. Only the harness
ever touches the filesystem or runs a command; the reasoning loop only ever proposes tool calls.

See `DevAgent_PRD.md` for the full spec and `context.md` for current project state and decisions.

## Status

**M0 — protocol & skeleton: done.** The harness can spawn the reasoning loop, perform a real
ping/pong handshake over the wire protocol, validate every message against a shared JSON
Schema, and write a full audit log of the exchange. See `context.md` for the milestone
checklist and what's next.

## Setup

Prerequisites: Node.js 18+, Python 3.10+.

```bash
npm install                      # installs harness deps (npm workspaces)
pip install -e reasoning[dev]    # installs the reasoning loop in editable mode
```

If `python` doesn't resolve to your intended interpreter, set `DEVAGENT_PYTHON=<path>` (used
by the CLI and by the integration test).

## Verify the harness <-> reasoning-loop handshake

```bash
npm run build
node harness/dist/cli.js selftest --verbose
```

or, in dev, without building:

```bash
npm run selftest
```

This spawns the Python reasoning loop, sends a `ping`, waits for the matching `pong`, and
prints the round-trip time. The full exchange is logged to `.devagent/logs/<session-id>.jsonl`.

## Tests

```bash
npm test                          # harness unit + integration tests (Vitest)
python -m pytest reasoning/tests  # reasoning-loop unit tests (pytest)
```

The integration test actually spawns `python -m devagent_reasoning`, so the reasoning package
must be installed (`pip install -e reasoning[dev]`) in whichever interpreter `python` (or
`DEVAGENT_PYTHON`) resolves to.

## Repo layout

```
harness/     Node/TypeScript package — CLI, protocol framing/validation, process lifecycle,
             audit logging. The only package with real side effects.
reasoning/   Python package — devagent_reasoning: protocol mirror + stdio entrypoint.
             Planning/LLM tool-calling land here starting M1.
schemas/     Single source of truth JSON Schemas for the wire protocol. Both packages load
             these exact files (ajv on the TS side, jsonschema on the Python side) so the
             two implementations can't silently drift apart.
.devagent/   Runtime output (audit logs). Gitignored.
```
