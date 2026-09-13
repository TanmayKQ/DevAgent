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
- [x] M1 — Read-only agent (`read_file`, `list_dir`, `search_code`)
- [x] M2 — Write path (`apply_patch`/`write_file` + diff preview/confirm)
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

## Current state — detail (M1)

Real end-to-end agent loop works: `devagent run "<task>" --repo <path>` spawns the reasoning
loop, drives a LangGraph `plan -> act -> observe -> reflect -> finish` graph, executes
`read_file`/`list_dir`/`search_code` through the harness's schema-validated, jailed tool
registry, and streams `plan_update`/`tool_call`/`tool_result`/`final_answer` to the terminal.
LLM provider is **Google Gemini** (user's choice — see decisions log), via
`langchain-google-genai` + `langgraph`, default model `gemini-2.5-flash`, overridable with
`--model`. Key comes from `GOOGLE_API_KEY`/`GEMINI_API_KEY`, loaded from a gitignored `.env` at
the repo root (`.env.example` documents the var).

43 Vitest tests (path jail incl. symlink-escape and `..`/absolute/UNC rejection, all three
tools against a fixture `sample-repo`, the tool registry's schema validation and error
handling, plus two full cross-process integration tests) + 13 pytest tests (protocol mirror +
4 graph tests against a scripted fake model) all pass. No test needs a live API key — see the
`DEVAGENT_FAKE_LLM_RESPONSES` decision below.

## Current state — detail (M2)

Write path works end-to-end: the LLM can call `write_file` (create/overwrite) and `apply_patch`
(exact old_string/new_string replacement — see decisions log for why not a raw unified diff).
Both are registered as `requiresConfirmation: true` in the tool registry. In `devagent run`,
any call to one of them is intercepted in the CLI *before* `executeToolCall` — the harness
computes a `WritePlan` (reads current content, works out the new content, but does not write
yet), renders it as a real unified diff (`diff` npm package's `createTwoFilesPatch`), prints it,
and prompts `Apply this <tool> to <path>? [y/N]` (skipped, not hidden, under `--yolo`/`--auto`).
Only on approval does `commitWrite()` actually touch disk. A decline becomes a
`tool_result{ok:false, error:{code:"user_rejected"}}` fed back to the graph — same
replan-on-failure path as any other tool error, so the LLM sees the rejection and can adapt.

`executeToolCall` (the registry's own mechanical path, used directly by tests and any
non-interactive caller) still supports `write_file`/`apply_patch` with **no** confirmation —
confirmation is deliberately a CLI/UX-layer concern layered on top, not baked into tool
execution itself, so the registry stays a plain "validate then run" dispatcher regardless of
risk tier.

29 new tests (11 `writePlan`/`commitWrite`, 2 diff-preview, 6 `confirm()`, extended registry
coverage, and 3 end-to-end tests that spawn the actual built `devagent` binary as a subprocess
with piped `y`/`n`/no stdin) — 72 Vitest + 13 pytest total, all passing, still no live API key
required anywhere.

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
- **LLM provider: Google Gemini** (user's explicit choice when asked at the start of M1), via
  `langchain-google-genai`'s `ChatGoogleGenerativeAI` + `langgraph`. Default model
  `gemini-2.5-flash`, overridable per-run with `--model`. Packaging/bundling strategy (M5) and
  live session resume (post-M4 stretch) are still open — see "Open questions". — 2026-09-12
- **Tool call/result get their own generic envelope schema plus a second, per-tool schema**
  (`schemas/tools/<name>.schema.json`), rather than one big oneOf. `tool_call.schema.json`
  only constrains `{call_id, name, arguments:object}`; the harness's tool registry validates
  `arguments` a second time against the specific tool's schema before executing. Keeps adding
  tools (M2 write, M3 exec) additive instead of editing one growing union schema. The same
  per-tool schema file doubles as the LLM's tool-call description (`schemas/tools/*.schema.json`
  read by `reasoning/src/devagent_reasoning/tools.py`) — one file, two consumers, no drift.
  — 2026-09-12
- **Cross-process tool execution uses LangGraph's `interrupt()`/`Command(resume=...)`**
  (verified directly against the installed `langgraph` 1.2.11 API before building on it, not
  assumed from memory — this project's LangGraph version is newer than commonly-documented
  examples). The `act` node calls `interrupt(tool_call_payload)`, which pauses the compiled
  graph and returns control to `__main__.py`; the harness executes the tool and
  `__main__.py` resumes with `Command(resume=tool_result)`. This is *the* mechanism that keeps
  the reasoning loop honest about never touching the filesystem: the only way out of `act` is
  through the caller. Gotcha: LangGraph re-runs all of a node's code before its `interrupt()`
  call on every resume, so a `notify()` placed in `act` fired twice per tool call; moved to
  `plan` (which runs exactly once) instead. — 2026-09-12
- **`DEVAGENT_FAKE_LLM_RESPONSES` env var** (path to a JSON file of scripted
  `{"tool_call":{name,args}}` / `{"text":...}` steps) swaps in a `FakeMessagesListChatModel`
  instead of constructing `ChatGoogleGenerativeAI`. This is what lets
  `harness/test/integration/task.test.ts` spawn a *real* Python process and exercise the *real*
  wire protocol and *real* tool execution end-to-end with no API key — stronger coverage than
  graph-level unit tests alone, and still satisfies "no live LLM calls in tests" (NFR5).
  — 2026-09-12
- **A tool-call failure (bad args, unknown tool, path-jail violation, handler exception) becomes
  a `tool_result{ok:false, error}`, not a protocol-level `error` envelope** — it's fed back into
  the graph as a `ToolMessage` so the LLM can see what went wrong and retry differently (a
  concrete instance of FR5's "replan on failure" even for read-only tools). Protocol-level
  `error` envelopes stay reserved for envelope/schema violations and unexpected exceptions
  (e.g. the LLM call itself failing, such as a missing API key) that abort the whole task rather
  than one step of it. — 2026-09-12
- **`apply_patch` is exact-match search/replace (`old_string`/`new_string`/`replace_all`), not a
  raw unified diff the LLM writes freely.** Free-form diff hunks are a known LLM failure mode
  (off-by-one context lines, whitespace drift) — requiring an exact substring match forces the
  model to have accurate knowledge of the file's current content (normally from having just
  `read_file`'d it), and a mismatch fails cleanly (`no_match`/`ambiguous_match`) instead of
  silently applying wrong. Same design Claude Code's own Edit tool uses. The harness still
  builds a real unified diff for the confirmation UI — the LLM-facing *input* format and the
  human-facing *preview* format are independent choices. — 2026-09-13
- **Write execution is a plan/commit split** (`planWriteFile`/`planApplyPatch` compute the
  prospective new content without touching disk; `commitWrite` does the actual write), not one
  step. This lets the CLI build an accurate diff and ask for confirmation *before* any mutation,
  then apply exactly what was previewed with no re-validation gap between "shown to user" and
  "written to disk". `executeToolCall` (registry.ts) composes the same two steps back-to-back
  for callers that don't need a confirmation step (tests, `--yolo` doesn't even need this
  distinction since it still previews, just doesn't block on an answer). — 2026-09-13
- **Confirmation lives in the CLI, not the tool registry.** `executeToolCall` stays a pure
  "validate then run" dispatcher for every tool regardless of risk tier — a registry consumer
  (tests, a future non-interactive caller) that wants write tools to just work does not have to
  fight an interactive prompt baked into the tool layer. The CLI's `run` command is the one place
  that checks `toolRequiresConfirmation(name)` and interposes the diff+prompt for write-tier
  tools before ever calling the mutation. — 2026-09-13
- **`confirm()` must treat a closed/EOF'd input stream as "no", not hang forever.**
  `readline.question()`'s callback only fires on a newline-terminated line; an input stream that
  ends without one (piped-then-closed stdin, `/dev/null`, a non-interactive CI shell) never
  fires it, and the original implementation awaited that callback alone — found via a test using
  `Readable.from([""])` that hung until Vitest's timeout. Fixed by also resolving `false` on the
  readline interface's `close` event. Real-world implication this prevents: `devagent run`
  without `--yolo` in any environment with closed/absent stdin would otherwise deadlock forever
  on the first write tool call instead of failing safe. — 2026-09-13

## Open questions

- Final packaging strategy: single `npm` package that shells out to a bundled Python venv, vs. two separate installs the user wires together, vs. bundling the Python side as a PyInstaller binary.
- How session resume should work beyond read-only replay (stretch goal per PRD).

## How to use this file

At the start of any new session working on DevAgent: read this file and the PRD first. At the end of a session, update "Current state" and "Decisions log" before stopping, so the next session (or the next assistant) doesn't have to rediscover context.
