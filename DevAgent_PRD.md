# Product Requirements Document — DevAgent

## 1. Overview

**DevAgent** is an autonomous, CLI-based coding assistant that plans and executes multi-step software engineering tasks (reading a codebase, writing/editing files, running commands, fixing failing tests, opening PRs) using LLM-driven tool-calling. It is the final-year engineering project, built to portfolio/production quality.

**Architecture at a glance:** a Node.js/TypeScript **harness** owns the CLI, filesystem, sandboxing, and tool execution; a Python/**LangGraph** **reasoning loop** owns planning, memory, and LLM orchestration. The two processes communicate over stdio using newline-delimited JSON ("JSON lines").

## 2. Problem Statement

Existing AI coding tools are either IDE-locked, closed-source, or opaque about how they plan and execute actions. DevAgent aims to be a transparent, inspectable, locally-runnable agent that demonstrates a full agentic loop — plan → act → observe → replan — with real tool use (file I/O, shell, git, test runners), not just chat.

## 3. Goals

- G1: Given a natural-language task, DevAgent can autonomously read a repo, form a plan, and execute it via a bounded set of tools.
- G2: The agent loop is observable and debuggable — every plan, tool call, and observation is logged and replayable.
- G3: The system is safe by default — no destructive action (file delete, force-push, `rm -rf`, arbitrary shell) runs without an explicit permission model.
- G4: The project is demo-ready and deployable — a real user can `npm install -g` (or `pipx install`) it and point it at a repo.
- G5: The two-process architecture (TS harness / Python reasoning loop) is clean enough to be a talking point in interviews — it should showcase protocol design, not just "call an LLM in a loop."

## 4. Non-Goals

- Not a VSCode/JetBrains extension (CLI-first; an editor plugin is a stretch goal, not v1).
- Not a multi-agent / multi-user SaaS product in v1.
- Not aiming to beat SOTA benchmarks (SWE-bench etc.) — correctness on real, scoped tasks matters more than leaderboard chasing.
- Not building a custom LLM — DevAgent is a harness/orchestrator over existing hosted models (Claude/GPT/etc. via API).

## 5. Users & Use Cases

Primary user: a developer working in a git repo who wants to delegate a scoped task.

Representative use cases:
1. "Add input validation to the `/users` endpoint and write a test for it."
2. "Find why `npm test` is failing in `payments/` and fix it."
3. "Refactor `utils/date.ts` to remove the moment.js dependency."
4. "Read this repo and generate a `CONTRIBUTING.md`."

## 6. System Architecture

### 6.1 Two-process design

```
┌─────────────────────────┐        JSON lines over stdio        ┌──────────────────────────┐
│   Node.js / TypeScript   │  <-------------------------------> │  Python / LangGraph        │
│   Harness                │                                    │  Reasoning Loop            │
│                           │                                    │                            │
│ - CLI entrypoint & UX     │                                    │ - Planner / graph nodes    │
│ - Tool registry & exec    │                                    │ - LLM calls (tool-calling) │
│ - Sandboxing / permissions│                                    │ - Memory / scratchpad      │
│ - File system access      │                                    │ - Replanning on failure    │
│ - Process/shell execution │                                    │                            │
│ - Session + audit log      │                                   │                            │
└─────────────────────────┘                                    └──────────────────────────┘
```

- The **harness** is the only process with real-world side effects (fs, shell, git, network). It exposes a fixed set of **tools** as JSON-schema-described capabilities.
- The **reasoning loop** never touches the filesystem directly. It receives the task + tool schemas, plans via a LangGraph state graph, emits `tool_call` messages, and receives `tool_result` messages back.
- Protocol messages (line-delimited JSON): `task_start`, `tool_call`, `tool_result`, `plan_update`, `ask_user`, `final_answer`, `error`.

### 6.2 Tool set (v1)

| Tool | Description | Risk tier |
|---|---|---|
| `read_file` / `list_dir` | Read-only fs access | Low |
| `search_code` | Grep/AST-aware search across repo | Low |
| `write_file` / `apply_patch` | Create/edit files (diff-based) | Medium — requires confirmation unless `--yolo` |
| `run_command` | Run whitelisted shell commands (test runners, linters, package managers) | Medium/High — sandboxed, allowlisted, timeout-bound |
| `git_status` / `git_diff` / `git_commit` | Git plumbing | Medium |
| `ask_user` | Pause and ask the human a clarifying question | n/a |

### 6.3 Safety model

- Default mode: **plan-then-confirm** — every `write_file`/`run_command` batch is shown as a diff/command preview and requires a keypress to apply.
- `--auto` / `--yolo` mode: skips confirmation but still enforces the command allowlist, working-directory jail, and a hard timeout per tool call.
- All shell commands run inside a restricted working directory; path traversal outside the repo root is blocked at the harness layer (never trust the Python side's paths).
- Full audit log of every tool call + result, written to `.devagent/logs/<session-id>.jsonl`, so any run can be replayed or inspected.

## 7. Functional Requirements

- FR1: CLI accepts a task string (`devagent "fix the failing test in src/payments"`) plus flags for repo path, model, mode (`--auto`/`--confirm`), and max iterations.
- FR2: Harness spawns/manages the Python reasoning-loop subprocess and owns its lifecycle (start, health-check, graceful kill).
- FR3: Reasoning loop maintains a LangGraph state machine with at least: `plan`, `act`, `observe`, `reflect/replan`, `finish` nodes.
- FR4: Every tool call is validated against a JSON schema before execution; malformed calls are rejected back to the LLM with an error message, not silently dropped.
- FR5: The agent must be able to detect its own failure (e.g., a test still fails after a patch) and attempt at least one replan before giving up and asking the user.
- FR6: A session can be resumed from its audit log (at least for inspection/replay in v1; live resume is a stretch goal).
- FR7: Streaming CLI output — the user sees plan steps and tool calls as they happen, not just a final answer.

## 8. Non-Functional Requirements

- NFR1 (Reliability): a single tool-call failure must not crash the whole session; errors are caught, logged, and surfaced to the reasoning loop as an observation.
- NFR2 (Security): no tool call may escape the configured repo root; shell commands run through an allowlist, not arbitrary `exec`.
- NFR3 (Observability): structured JSON logs for every message on the wire; a `--verbose` flag prints the raw protocol traffic.
- NFR4 (Portability): harness distributable via `npm`; reasoning loop distributable via `pip`/`pipx`; a single `devagent` command wires both together (bundling strategy TBD in context.md).
- NFR5 (Testability): tool implementations and the LangGraph nodes are unit-testable in isolation from the LLM (mockable LLM responses for the graph, mockable fs for the tools).

## 9. Success Metrics (for a final-year project / portfolio)

- Completes a set of ~15–20 hand-authored benchmark tasks (across 2–3 sample repos) end-to-end without manual intervention, at an agreed success rate (target ≥ 70%).
- Zero sandbox escapes / destructive actions across the benchmark run.
- Demo-able live: a fresh clone + `npm install` + one command reproduces the whole thing.
- README + architecture doc clear enough that someone unfamiliar with the project can run and understand it in under 10 minutes.

## 10. Milestones

1. **M0 — Protocol & skeleton**: JSON-lines protocol defined; harness spawns the Python process and can exchange a trivial ping/pong.
2. **M1 — Read-only agent**: `read_file`, `list_dir`, `search_code` wired end-to-end; agent can answer questions about a repo.
3. **M2 — Write path**: `apply_patch`/`write_file` with diff preview + confirmation.
4. **M3 — Execution**: `run_command` with allowlist + sandboxing; agent can run tests and read output.
5. **M4 — Full loop**: plan → act → observe → replan working on the benchmark task set.
6. **M5 — Hardening & packaging**: audit logging, error recovery, CLI polish, install story, docs, demo video.

## 11. Risks

- LangGraph/Node interop adds real complexity (process lifecycle, backpressure, partial JSON lines) — mitigate with a strict framing protocol (length-prefixed or newline-delimited with escaping) and a small integration-test suite early.
- Tool-calling reliability depends on the underlying model — mitigate with strict JSON schema validation + retry-with-error-feedback rather than trusting first output.
- Scope creep toward "another Claude Code clone" — mitigate by keeping v1 scoped to the benchmark task list, not open-ended capability.
