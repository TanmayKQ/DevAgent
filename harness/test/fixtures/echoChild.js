// Minimal stdio fixture standing in for the Python reasoning loop in process-manager unit
// tests. Replies to "ping" with "pong" unless DEVAGENT_TEST_SILENT=1, in which case it never
// responds — used to exercise PythonReasoningProcess's ping timeout path deterministically.
import { randomUUID } from "node:crypto";

const silent = process.env.DEVAGENT_TEST_SILENT === "1";

let buffered = "";

process.stdin.on("data", (chunk) => {
  buffered += chunk.toString("utf8");
  let idx;
  while ((idx = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, idx);
    buffered = buffered.slice(idx + 1);
    if (line.trim().length > 0) handleLine(line);
  }
});

function handleLine(line) {
  const envelope = JSON.parse(line);
  if (envelope.type === "ping" && !silent) {
    const pong = {
      v: 1,
      id: randomUUID(),
      session_id: envelope.session_id,
      ts: new Date().toISOString(),
      type: "pong",
      payload: { in_reply_to: envelope.id },
    };
    process.stdout.write(JSON.stringify(pong) + "\n");
  }
}
