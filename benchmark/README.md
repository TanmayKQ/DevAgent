# DevAgent benchmark

17 hand-authored tasks across two small, self-contained fixture repos (`repos/js-utils`,
`repos/py-utils`) — each with real bugs, one missing function, a couple of read-only
questions, and two deliberately ambiguous tasks. `run.js` copies the relevant fixture repo to a
fresh temp directory per task, runs the real `devagent` CLI against the copy, checks an
automated pass/fail condition, and prints a scorecard. The checked-in fixture repos are never
modified — every run works on a throwaway copy.

## Running it

```bash
npm run build -w harness   # the runner spawns the built CLI, not the dev (tsx) entrypoint

node benchmark/run.js --fake        # smoke-test the runner itself — no API key, no cost
node benchmark/run.js               # the real benchmark — calls Gemini, uses your API quota
node benchmark/run.js --filter gcd  # run only tasks whose id contains "gcd"
node benchmark/run.js --verbose     # dump full agent output for any failing task
```

`--fake` replays each task's hand-scripted `fakeResponses` (the same `DEVAGENT_FAKE_LLM_RESPONSES`
mechanism the test suite uses) instead of calling a real model. It proves the runner's mechanics
— copy, spawn, verify, report — work correctly, but it is **not** a measure of the agent's actual
capability, since the responses are pre-written, not reasoned. Only a real (no `--fake`) run
produces a meaningful score against the PRD's ≥70% target.

Every run is unattended (`--yolo`): confirmations are skipped (still logged, still jailed,
still allowlisted) and stdin is closed immediately, so an `ask_user` call gets an empty answer
right away instead of hanging.

A JSON report lands in `benchmark/results/<timestamp>-<fake|live>.json` (gitignored) after each
run.

## Task format (`tasks.json`)

Each task has:
- `id`, `repo` (`js-utils` or `py-utils`), `task` (the natural-language prompt), `maxIterations`.
- `verify` — one of:
  - `{"type": "run_command", "command", "args"}` — runs that command against the task's repo
    copy after the agent finishes; pass = exit code 0. Used for every bugfix/write task (the
    fixture's own test files, scoped to just the relevant function — see below).
  - `{"type": "final_answer_contains", "all" | "any": [...]}` — case-insensitive substring
    check against the agent's final answer text. Used for read-only Q&A tasks.
  - `{"type": "completes"}` — passes if the agent produced any non-empty final answer. Used for
    the two deliberately ambiguous tasks, where "did something reasonable, possibly asked for
    clarification" is the bar, not a specific fix.
- `fakeResponses` — the scripted step sequence used only in `--fake` mode.

## Why the fixture repos' tests are split into one file per function

Each fixture repo has several independent bugs at once. If `npm test`/`pytest` (whole-suite)
were the verify command, a task targeting one bug would still "fail" verification because of
the other, unrelated bugs still present elsewhere in the same repo copy. Splitting into
`test/<function>.test.js` / `tests/test_<function>.py` lets each task's `verify` command target
only the function that task is actually about.
