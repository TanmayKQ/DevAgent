# Demo script (about 5 minutes)

Prep: `npm run setup`, add your key to `.env`, `npm run build`, `npm run doctor` (all green).
Use a fresh copy of a fixture so you can re-run it:

```bash
cp -r benchmark/repos/js-utils /tmp/demo-repo      # Windows: Copy-Item -Recurse
```

## 1. The pitch (30s)
"It's a coding agent in two processes. A Node harness owns every side effect and every safety
check; a Python LangGraph loop only plans. They talk over a JSON protocol I can replay and test."

## 2. A read-only question (30s)
```bash
npm run devagent -- run "Which functions in src/math.js are buggy?" --repo /tmp/demo-repo
```
Show the live stream: `planning` → `read_file` → answer. Nothing was changed.

## 3. Fix a bug, with confirmation (90s)
```bash
npm run devagent -- run "Fix clamp() in src/math.js so test/clamp.test.js passes" --repo /tmp/demo-repo
```
Point out: the **diff preview**, the `[y/N]` prompt, then `run_command` showing the command
*before* it runs. Answer `n` once to show the agent adapts to a declined change.

## 4. The safety story (60s)
- Ask it to `curl` something → rejected by the allowlist *before any prompt*.
- Mention: no shell, restricted env (key not passed to children), jail, timeout.
- `--yolo` skips the prompt but not the allowlist.

## 5. Audit + replay (45s)
```bash
npm run devagent -- replay latest
```
A readable transcript of the whole session — reconstructed from the log, not from memory.

## 6. It asks when stuck (30s)
```bash
npm run devagent -- run "Improve the format.js module" --repo /tmp/demo-repo
```
Show `DevAgent asks: …` and answer in plain text.

## 7. Under the hood (60s)
Open `docs/ARCHITECTURE.md`'s diagram. Mention: shared JSON Schemas, the `interrupt()` pause that
keeps the Python side side-effect-free, and that the whole suite (and a 17-task benchmark runner)
runs with a scripted fake model — no API key.

If you have quota, finish with `node benchmark/run.js --filter clamp` for a live pass.
