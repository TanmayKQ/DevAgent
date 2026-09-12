import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PythonReasoningProcess } from "../../src/process/pythonProcess.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = join(__dirname, "..", "fixtures", "echoChild.js");

describe("PythonReasoningProcess", () => {
  let proc: PythonReasoningProcess | null = null;

  afterEach(async () => {
    if (proc) {
      await proc.stop();
      proc = null;
    }
  });

  it("resolves ping() once the child responds with pong", async () => {
    proc = new PythonReasoningProcess({ command: process.execPath, args: [fixture], cwd: __dirname });
    proc.start();
    const pong = await proc.ping("session-1", 2000);
    expect(pong.type).toBe("pong");
  });

  it("rejects ping() if the child never responds", async () => {
    proc = new PythonReasoningProcess({
      command: process.execPath,
      args: [fixture],
      cwd: __dirname,
      env: { DEVAGENT_TEST_SILENT: "1" },
    });
    proc.start();
    await expect(proc.ping("session-1", 100)).rejects.toThrow(/timed out/);
  });

  it("emits 'send' for outbound and 'message' for inbound envelopes", async () => {
    proc = new PythonReasoningProcess({ command: process.execPath, args: [fixture], cwd: __dirname });
    proc.start();

    const sent: string[] = [];
    const received: string[] = [];
    proc.on("send", (e) => sent.push(e.type));
    proc.on("message", (e) => received.push(e.type));

    await proc.ping("session-1", 2000);

    expect(sent).toEqual(["ping"]);
    expect(received).toEqual(["pong"]);
  });

  it("stop() terminates the child process", async () => {
    proc = new PythonReasoningProcess({ command: process.execPath, args: [fixture], cwd: __dirname });
    proc.start();
    const code = await proc.stop();
    expect(code === null || typeof code === "number").toBe(true);
    proc = null;
  });
});
