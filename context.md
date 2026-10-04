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
- [x] M3 — Execution (`run_command` + allowlist + sandbox)
- [x] M4 — Full plan → act → observe → replan loop on benchmark tasks
- [~] M5 — Hardening, packaging, docs, demo (built; see below — one M4 item still unproven)

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

## Current state — detail (M3)

`run_command` works end-to-end, gated behind four independent layers (allowlist, no-shell
execution, restricted env + directory confinement, timeout), on top of the same
preview-then-confirm UX as M2's write tools:

- **Allowlist** (`harness/src/tools/commandAllowlist.ts`): a fixed table of
  `{command, allowedArgPrefixes}` rules. Only `npm test`, `npm run <anything>`, `npx tsc`,
  `pytest` (any args), `python -m pytest` (only that prefix — blocks `python -c` entirely),
  `node` (any args), and read-only `git status`/`diff`/`log` are permitted. Nothing else, in any
  mode — `--yolo` skips the confirmation *prompt*, never the allowlist.
- **No shell**: `spawn(command, args, {shell:false, ...})`, args passed as a real array — there
  is no shell interpreter in the loop to misinterpret `;`/`&&`/`|`/backticks/redirection, which
  closes off classic command-injection entirely rather than trying to filter for it.
- **Best-effort argument screening** (`findSuspiciousArg`): rejects an arg containing a literal
  `..` path segment or an absolute/UNC-looking path, on top of the allowlist. Documented as
  defense-in-depth, not a real jail — unlike file-tool paths, run_command's args are opaque
  per-tool flags/values with no generic way to know which ones are paths, so this can be evaded
  by a sufficiently creative allowed command. The allowlist (which excludes general-purpose
  file-access programs) is what's actually carrying the safety weight.
- **Restricted environment**: the child only gets a small allowlisted set of OS/tooling vars
  (PATH, TEMP, SystemRoot, etc.) — never `GOOGLE_API_KEY`/`GEMINI_API_KEY` or anything else
  DevAgent itself holds. Verified with a real subprocess reading `process.env` for a canary var.
- **Timeout + real process-tree kill**: 120s default. On timeout, `taskkill /pid <pid> /T /F` on
  Windows (a plain `child.kill()` only kills the immediate process — a hung `npm test` that had
  spawned its own child would otherwise survive), `SIGKILL` to the process group on POSIX.
  Verified by actually starting a 30-second hang and confirming it's dead well before that.
- **Output caps**: stdout/stderr each capped at 256KB (same cap as `read_file`), `truncated`
  flags in the result rather than an unbounded buffer.

`prepareRunCommand()` mirrors M2's plan/commit split: validates the allowlist, args, and cwd
jail with zero side effects, so the CLI can preview ("DevAgent wants to run: `<command>`") and
reject outright *before* ever prompting — a disallowed command never shows a confirmation prompt
at all (verified end-to-end: no "Proceed?" in output, no stdin needed for that case to resolve).

While manually exercising a real two-step task (write a file, then run it) — a scenario none of
the M2 single-confirmation tests happened to cover — found and fixed a real bug in the
confirmation prompt itself; see the decisions log entry below. That fix (`confirm.ts` rewritten
around a hand-rolled line reader instead of `node:readline`) applies to M2's write confirmations
too, not just M3.

31 new tests (allowlist matching, suspicious-arg screening, `prepareRunCommand` validation,
`runCommand` execution incl. a real timeout-kill and real env-scrubbing check, extended registry
coverage, 4 end-to-end `run_command` confirm/decline/`--yolo`/disallowed tests, and 2 multi-step
regression tests) plus a full rewrite of the `confirm()` test suite — 108 Vitest + 13 pytest
total, all passing, still no live API key required anywhere.

## Current state — detail (M4)

Two things landed together: `ask_user`, and the 17-task benchmark.

**`ask_user`** closes the "attempt a replan... before giving up and asking the user" half of
FR5. It's its own envelope type pair (`ask_user`/`ask_user_response`), not routed through
`tool_call`/`tool_result` — matching the PRD's own message-type list, which already named
`ask_user` separately. To the LLM it's presented as an ordinary bindable tool (in
`tools.py`/`schemas/tools/ask_user.schema.json`), so no graph.py changes were needed at all:
`act`'s `interrupt()` doesn't know or care that this call is special. All the routing is in
`__main__.py` — it checks the interrupted call's `name`, and if it's `"ask_user"` sends an
`ask_user` envelope + awaits `ask_user_response` instead of `tool_call`/`tool_result`, then
translates the human's `{answer}` into the same `{ok:true, result:{...}}` shape every other tool
result already uses before resuming the graph. `ConfirmChannel` gained `askText()` (free-text,
not y/n) on the same shared `LineReader`. Never gated by `--yolo` — asking has no side effect to
skip a confirmation for.

The **benchmark** (`benchmark/`) is 17 tasks across two small, dependency-free fixture repos
(`repos/js-utils`, `repos/py-utils`) — 12 real bugs to fix, 2 "add a missing function" tasks, 2
read-only Q&A tasks, and 2 deliberately ambiguous tasks (candidates for `ask_user`, though not
required to use it — see decisions log). Each fixture repo's tests are split one-file-per-function
specifically so a task's `verify` step can check just the relevant fix without unrelated
pre-existing bugs elsewhere in the same repo copy causing a false failure. `run.js` copies the
task's repo to a fresh temp dir, runs the real built CLI with `--yolo` (unattended — stdin is
closed immediately so an `ask_user` call can't hang the run), checks the task's `verify`
condition (`run_command` exit-0, `final_answer_contains`, or `completes`), and writes a
scorecard + JSON report. Verified by running all 17 in `--fake` mode (scripted responses, no API
key) — 17/17 passed, confirming the runner's mechanics (copy/spawn/verify/report) work
correctly; this is not a real capability score, which requires a live-model run against real API
quota — not yet done as of this writing, pending the user's decision on when to spend it.

14 new tests (schema validation for both new message types, `ConfirmChannel.askText`, a graph
test proving `ask_user` reuses the exact same interrupt/resume contract as any tool with zero
graph-side special-casing, and 3 end-to-end CLI-subprocess tests) — 114 Vitest + 18 pytest total,
all passing.

## Current state — detail (M5, plus the first live run)

**First live Gemini run (do this before trusting M4).** Running against the real model for the first
time found bugs that fake-mode could never catch: `npm`/`npx` never launched on Windows (`.cmd`
shims: `spawn` with `shell:false` gets ENOENT, and Node >= 20.12 refuses to spawn `.cmd` without a
shell — fixed by running the wrapped `npm-cli.js` under the current node binary, keeping the
no-shell guarantee); a failed spawn crashed the whole CLI instead of becoming a `tool_result`
error; the default model `gemini-2.5-flash` was retired (now `gemini-3.8-flash`); and LLM rate
limits killed tasks (added `retry.py`: honors the provider's retry hint, bounded attempts, injectable
sleep; fails fast on hard quotas). A single live task (`js-clamp`) passed.

**Still unproven:** the PRD's >=70% benchmark target. The user's free Gemini key allows 20
requests/day/model and was exhausted, so the full 17-task live run did NOT complete — only
fake-mode (17/17, scripted) and one live task have passed. Needs a key with billing (est. well
under $1 for 17 tasks) or several days of free quota. `node benchmark/run.js` is ready.

**M5 built:** packaging, `devagent doctor`, crash recovery, session audit records + `replay`, docs.
- `npm run setup` (`scripts/setup.js`) creates `.venv`, pip-installs `reasoning[dev]`, creates `.env`.
  `resolvePython`: `--python`/`DEVAGENT_PYTHON` > `.venv` > `python`. Verified from scratch (~100s),
  and the CLI picks the venv up with `DEVAGENT_PYTHON` unset.
- `devagent doctor`: Node >= 18, Python >= 3.10, reasoning package importable, API key present
  (never printed), schemas found — each failure prints a fix.
- Crash recovery: if the Python process dies mid-task the CLI now exits 1 with its last stderr and a
  doctor hint instead of hanging forever (`exit` handler, guarded by a `finished` flag so a normal
  shutdown isn't reported as a crash).
- Audit log: `session start`/`session end` records; `run` prints the session id; `devagent replay
  <id|path|latest>` renders a transcript. Read-only inspection only — live resume is NOT built.
- Docs: README rewritten around the quickstart, `docs/ARCHITECTURE.md`, `docs/DEMO.md` (script only;
  the demo video itself is not recorded).

**Interactive chat (added after M5, user request).** Bare `devagent` (or `devagent chat`) opens a
REPL in the current directory — the intended primary interface; `run` stays for scripts and the
benchmark. Architecture: the per-task logic moved out of `cli.ts` into `harness/src/session.ts`
(`createAgentSession`: one Python process, one audit log, many `runTurn` calls); `run` is now a thin
wrapper over it, so every existing test still covers the same code. `harness/src/cli/chat.ts` is
the REPL: banner, `> ` prompt, `/help /yolo /clear /status /exit`, Ctrl+C closes the session cleanly.
Quiet mode hides the per-node status stream and shows a compact tool line instead.
- **One stdin reader for everything.** The prompt, `[y/N]` confirmations and `ask_user` answers all
  go through the same `ConfirmChannel`/`LineReader` (new `askLine` returns null at EOF so the REPL can
  tell Enter-on-empty from stdin-closed). Two readers on one stdin would reintroduce the
  lost-answer bug from M3.
- **Memory = recent exchanges, not tool output.** `task_start` gained optional `history`
  (`[{user, assistant}]`, max 20; harness sends the last 8 turns, answers clipped to 1500 chars).
  `initial_state` puts them before the new task as Human/AI messages. The agent re-reads files itself.
- **Python side:** a fresh LangGraph `thread_id` per task (the `task_start` envelope id) — reusing the
  session id would merge each task into the previous one's finished checkpoint; and one model instance
  per process (`_get_model`), which also makes scripted fake models continue across turns.
- `package.json` has `bin.devagent`; `npm link` gives a global `devagent` (not run automatically — it
  changes the user's global npm state).
- **Not verified:** a real interactive terminal. Everything is tested with piped stdin; true TTY
  behavior (line editing, Ctrl+C mid-turn, the rule drawn after input) has not been exercised by me.

Not done: recording the demo video; live session resume (stretch); the real benchmark score.

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
- **`run_command`'s allowlist is `{command, allowedArgPrefixes}` rules, not just a bare list of
  executable names.** A bare-executable allowlist would let `npm` through and then be unable to
  distinguish `npm test` from `npm publish`, or `git status` from `git push --force`. Each rule's
  args must match one of its allowed *prefixes* (e.g. `["run"]` permits `npm run <any script>`,
  since that's bounded by the target repo's own package.json — a trust boundary already implied
  by allowing `npm test` at all) — this is also what specifically defeats `python -c "<anything>"`
  (python's rule only matches the exact prefix `["-m", "pytest"]`). — 2026-09-14
- **`run_command` is not real OS-level sandboxing (no container/VM), and the user was told this
  explicitly before M3 was built, not after.** The allowlist, no-shell execution, restricted
  environment, directory confinement, and timeout are all "smart rules applied to a process
  running directly on the host," not physical isolation — a command that's on the allowlist and
  misbehaves within its own normal abilities inside the repo folder is not something this stops.
  Chose this deliberately over adding Docker/container-based isolation: extra required software,
  meaningful added complexity, and it would break the "clone + one command" demo experience that
  is a stated project goal. Revisit only if a future milestone's threat model changes. — 2026-09-14
- **The repo-root jail is real for `cwd` but only best-effort for `run_command`'s other
  arguments** (`findSuspiciousArg`, screening for `..`/absolute/UNC patterns) — unlike
  `read_file`/`write_file`/`apply_patch` where the harness knows exactly which argument is *the*
  path and can fully resolve+contain it, `run_command`'s `args` are opaque per-tool
  flags/values with no generic way to know which ones are paths at all, so a generic full-jail
  check isn't tractable the same way. The allowlist (deliberately excluding general-purpose
  file-access programs like `cat`/`cp`) is what actually keeps this safe, not the argument
  screen — documented as such in code, not left implicit. — 2026-09-14
- **`confirm()` was fully rewritten off `node:readline` onto a hand-rolled line reader** — a more
  serious version of the EOF bug above, found by actually running a real two-confirmation task by
  hand (write a file, then run it) rather than only unit-testing one confirmation at a time.
  `readline.Interface` auto-closes itself as soon as its underlying stream ends, *discarding any
  already-buffered-but-undelivered line* even if a second `question()` call would arrive moments
  later — with piped/scripted input (the realistic case for any non-interactive run, including
  every integration test), all answers typically arrive in one chunk before the stream ends, so
  a task's *second* confirmation was silently resolving to "declined" no matter what the piped
  answer said, with no error. Reusing one `Interface` across questions (the first fix attempted)
  was not sufficient — the auto-close-on-stream-end behavior undermines even a shared instance.
  Fix: a minimal hand-rolled line reader (`LineReader` in `harness/src/cli/confirm.ts`, the same
  buffer-and-extract-a-line shape as the wire protocol's `LineFramer`) that reads directly off
  the stream's own 'data'/'end' events instead of delegating to readline's interface lifecycle.
  Real TTY use loses nothing — line editing/echo/backspace come from the OS terminal's own
  cooked-mode handling, not from Node's readline. Must call `.dispose()` when done (removes the
  'data' listener and pauses the stream) — leaving a stream in flowing mode would otherwise keep
  the whole CLI process alive past when it should exit. Locked in with both a unit-level
  regression test (two answers in one chunk) and a real end-to-end test driving the actual CLI
  through a two-tool-call task. — 2026-09-14
- **`ask_user` is its own envelope type pair (`ask_user`/`ask_user_response`), not a `tool_call`
  variant** — the PRD's own protocol message list already names `ask_user` separately from
  `tool_call`/`tool_result`, and semantically it isn't risk-tiered the way write_file/apply_patch/
  run_command are (no side effect, never needs `--yolo` gating), so it doesn't belong in the
  same family as those. It IS still presented to the LLM as an ordinary bindable tool (same
  `schemas/tools/*.schema.json` mechanism) — the distinction is purely in which wire envelope
  `__main__.py` chooses to send, decided by checking the interrupted call's `name`. This keeps
  `graph.py` completely unaware ask_user is special: `act`'s `interrupt()`/resume contract is
  identical for every tool, real or not, which is what made adding this require zero graph
  changes. — 2026-09-20
- **Benchmark fixture repos split their tests one file per function**, not one whole-suite
  `npm test`/`pytest tests/`. Each fixture repo carries several independent bugs simultaneously
  (to get enough tasks out of two small repos) — a whole-suite verify command would report
  failure for a task whose specific bug the agent DID fix, just because a different, unrelated
  bug elsewhere in the same repo copy was still present. Scoping each task's `verify` to
  `test/<function>.test.js` / `tests/test_<function>.py` makes each task's pass/fail
  independent of every other task's state. — 2026-09-20
- **Benchmark tasks carry hand-scripted `fakeResponses` used only by `run.js --fake`.** This
  smoke-tests the runner's own mechanics (fixture copy, unattended real-CLI spawn, verify
  check, report) without an API key or cost, and doing that surfaced real integration issues
  cheaply (path-jail/allowlist interplay, whether `--yolo` + closed stdin actually avoids
  hanging on an `ask_user` call). It is explicitly **not** a capability score — the responses
  are pre-written, not reasoned — that requires a real (non-`--fake`) run against live Gemini,
  which costs API quota and hasn't been run yet as of this writing; that's the user's call on
  timing, not something to spend automatically. — 2026-09-20
- **The runner closes the spawned CLI's stdin immediately (`--yolo` + `child.stdin.end()`)
  rather than leaving it open unattended.** `--yolo` skips write/command confirmation prompts,
  but `ask_user` is deliberately never gated by `--yolo` (see above) — without also closing
  stdin, a task that triggers `ask_user` (scripted or, in a real run, the model's own choice)
  would sit blocked on a prompt nothing will ever answer until the runner's 3-minute per-task
  timeout. A closed stdin resolves that prompt to an empty string immediately, per `confirm.ts`'s
  existing EOF-safe design — this is the runner relying on, not working around, that guarantee.
  — 2026-09-20

- **Packaging: one `npm run setup` command that builds a private `.venv`** (user's choice from
  three options). Chosen over two separate installs (worst first-run, wrong-Python errors) and a
  PyInstaller binary (LangChain/LangGraph/Google SDKs make it heavy and per-OS). The CLI resolves
  Python as explicit > `.venv` > `python`, so users never choose an interpreter. — 2026-10-03
- **Windows `npm`/`npx` are launched via `node <npm-cli.js>`, not by loosening the no-shell rule.**
  Re-adding a shell to start `.cmd` shims would have undone the injection protection that is the
  point of `run_command`'s design. Found only by a live run — fake-mode never launches npm. — 2026-10-03
- **A hard API quota must fail fast, not retry.** A 16-hour retry hint was first treated like a
  per-minute limit and burned 15 minutes per task. Hints longer than the retry cap now raise a clear
  "quota exhausted" error immediately. — 2026-10-03
- **A reasoning-loop crash must never hang the CLI.** Only `error`/`final_answer` used to settle the
  run; a Python process dying silently left it waiting forever. The `exit` handler now settles with
  the process's last stderr — excluded after normal completion so shutdown isn't misreported. — 2026-10-03

## Open questions

- (Resolved 2026-10-03: packaging = one-command setup with an auto-used `.venv`. See decisions log.)
- How session resume should work beyond read-only replay (stretch goal per PRD).

## How to use this file

At the start of any new session working on DevAgent: read this file and the PRD first. At the end of a session, update "Current state" and "Decisions log" before stopping, so the next session (or the next assistant) doesn't have to rediscover context.
