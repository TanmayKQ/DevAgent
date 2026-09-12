# context.md — DevAgent

Persistent project context for whichever AI coding assistant (Claude Code, Cursor, etc.) is used to build DevAgent. Keep this file updated as decisions are made — treat it as the single source of truth that survives across sessions/context resets.

## What this project is

DevAgent is a final-year, portfolio-grade, autonomous CLI coding assistant. Two processes:
- **Harness** — Node.js + TypeScript. Owns the CLI, filesystem, shell execution, sandboxing, permissions, and audit logging. The only process allowed real side effects.
- **Reasoning loop** — Python + LangGraph. Owns planning, LLM tool-calling, memory/scratchpad, and replanning on failure. Never touches the filesystem directly.
- **Protocol** — newline-delimited JSON ("JSON lines") over stdio between the two processes.

Full requirements live in `DevAgent_PRD.md` in this same output — read it before making architectural decisions that contradict it.

## Author context

- Tanmay, 4th-year Computer Engineering student, DYPCOE Pune, graduating June 2027.
- Comfortable stack: Node.js/Express/TypeScript, PostgreSQL/Prisma, React. Growing depth in RAG/agentic/LLM tooling.
- This is a **final-year project** — code quality, documentation, and a working demo all matter for evaluation, not just raw functionality.

## Non-negotiable constraints

1. **Safety first.** No `write_file`/`apply_patch`/`run_command` executes without going through the permission model (confirm-by-default, `--auto` allowlisted). Never implement a raw `exec(userString)` shell tool.
2. **Repo-root jail.** Every filesystem/shell tool call must be validated against the configured repo root in the **harness**, not trusted from the Python side.
3. **Schema-validated tool calls.** Every tool call from the reasoning loop must be validated against a JSON schema in the harness before execution. Malformed calls get bounced back as errors, not silently dropped or best-effort-parsed.
4. **Observability.** Every message on the wire gets logged as structured JSON to `.devagent/logs/<session-id>.jsonl`. `--verbose` shows raw protocol traffic.
5. **Testable without a live LLM.** Tool implementations and LangGraph nodes must be unit-testable with a mocked LLM/mocked fs — don't hard-wire real API calls into anything you want to unit test.

## Current state

- [x] M0 — Protocol & skeleton (harness ⇄ Python ping/pong)
- [ ] M1 — Read-only agent (`read_file`, `list_dir`, `search_code`)
- [ ] M2 — Write path (`apply_patch`/`write_file` + diff preview/confirm)
- [ ] M3 — Execution (`run_command` + allowlist + sandbox)
- [ ] M4 — Full plan → act → observe → replan loop on benchmark tasks
- [ ] M5 — Hardening, packaging, docs, demo

Update this checklist as milestones land. Note actual decisions made (library choices, protocol framing format, model provider) below as they're finalized, so future sessions don't re-litigate them.

## Current state — detail (M0)

Repo layout is live: `harness/` (Node/TS), `reasoning/` (Python, `devagent_reasoning` package),
`schemas/` (shared JSON Schemas, single source of truth for both sides). Root `package.json`
uses npm workspaces (`["harness"]`). Git repo initialized 2026-09-12; nothing committed yet —
first commit is the user's call.

What works end-to-end: `node harness/dist/cli.js selftest` (or `npm run selftest`) spawns
`python -m devagent_reasoning`, sends a schema-validated `ping`, gets a `pong` back, prints
round-trip time, and writes both directions to `.devagent/logs/<session-id>.jsonl`. 14 Vitest
tests (framing, envelope validation, process-manager lifecycle against a fake fixture child,
and a real end-to-end integration test against actual Python) + 9 pytest tests (mirrored
framing/schema coverage) all pass.

Protocol implemented for M0: envelope validated against `schemas/envelope.schema.json`
(draft-07); only `ping`/`pong`/`error` have dedicated payload schemas so far — every other
`type` in the enum (`task_start`, `tool_call`, `tool_result`, `plan_update`, `ask_user`,
`final_answer`) falls back to a permissive `{"type":"object"}` validator until its milestone
defines the real payload shape. `PythonReasoningProcess.start()` auto-initializes the schema
registry from its own module location — callers never need to remember to call `initSchemas()`
themselves (an early version required this and every test/CLI call site that forgot it crashed
with a confusing "Schemas not initialized" error deep inside the stdout handler; that failure
mode should not resurface as M1+ adds more entry points).

## Decisions log

- **Wire format: pure NDJSON, not length-prefixed** (resolves the PRD's open framing risk).
  `JSON.stringify`/`json.dumps` never emit raw newlines inside one serialized object, so a
  strict line-buffer (accumulate raw bytes, split on `\n`, decode only complete lines) is safe
  and simpler than length-prefixing. Both `LineFramer` implementations buffer raw
  bytes/`bytearray` (not strings) specifically so a chunk boundary landing mid multi-byte UTF-8
  character can't corrupt a message — covered by a dedicated test on both sides. A max-line-size
  guard (10MB default) prevents an unbounded buffer on malformed/runaway input. — 2026-09-12
- **Envelope schema: draft-07, not draft 2020-12.** Ajv's 2020-12 build lives at a deep subpath
  (`ajv/dist/2020`) that's fragile under Node's `NodeNext` ESM resolution; draft-07 covers
  everything the envelope/payload schemas need (const, enum, pattern, additionalProperties) via
  ajv's plain default export, avoiding that risk entirely. Python side uses
  `jsonschema.Draft7Validator` to match. — 2026-09-12
- **No `"format"` keyword in schemas** (e.g. for the `id`/`ts` fields) — ajv and `jsonschema`
  differ on whether format is enforced by default, which would let a message pass validation on
  one side and fail on the other. Used `"pattern"` (regex) instead on both, which behaves
  identically in both libraries. — 2026-09-12
- **`ping`/`pong` are protocol message types alongside the PRD's 7**, used only for the startup
  health-check, so a real session's audit log isn't cluttered with handshake noise when reading
  it back later (session log = task-relevant messages; ping/pong is transport plumbing). —
  2026-09-12
- **ajv import must be named, not default**: `import Ajv from "ajv"` fails to type-check
  ("not constructable") under `moduleResolution: NodeNext` even though it works fine at
  runtime — a known ajv/TS-ESM interop gap. Fix: `import { Ajv } from "ajv"` (ajv also exports
  the class by name). — 2026-09-12
- **Python stdin must be read with `.read1(n)`, never `.read(n)`.** `BufferedReader.read(n)`
  blocks trying to fill the full `n` bytes, which only returns early at EOF — fine when a shell
  pipes input and closes stdin, but the harness keeps stdin open for the life of the session, so
  a real ping sat unread indefinitely until enough bytes queued up. `.read1(n)` returns after a
  single underlying read (whatever's available up to `n` bytes), which is what a live NDJSON
  stream needs. Confirmed by reproducing the hang with a persistent pipe before/after the fix.
  — 2026-09-12
- **Schema-root/repo-root discovery is an upward filesystem search from `import.meta.url`
  (`findRepoRoot` in `harness/src/config/repoPaths.ts`, mirrored as `find_repo_root` in
  `reasoning/src/devagent_reasoning/protocol.py`)**, not a fixed relative-path offset — works
  identically whether code runs from `harness/src` (dev, via tsx) or `harness/dist` (built),
  and doesn't care what cwd a subprocess is spawned with. — 2026-09-12
- **Deferred, not decided**: LLM provider(s) — real decision point is M1, once actual
  tool-calling starts. Packaging/bundling strategy — M5. Live session resume — stretch goal,
  post-M4. See "Open questions" below; these are still open.

## Open questions

- Final packaging strategy: single `npm` package that shells out to a bundled Python venv, vs. two separate installs the user wires together, vs. bundling the Python side as a PyInstaller binary.
- Which LLM provider(s) to support first (single-provider v1 vs. abstracted from the start).
- How session resume should work beyond read-only replay (stretch goal per PRD).

## How to use this file

At the start of any new session working on DevAgent: read this file and the PRD first. At the end of a session, update "Current state" and "Decisions log" before stopping, so the next session (or the next assistant) doesn't have to rediscover context.
