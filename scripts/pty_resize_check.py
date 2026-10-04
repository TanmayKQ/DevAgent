"""Manual end-to-end check of the chat UI in a REAL (Windows ConPTY) terminal: types a message,
then resizes the window and verifies the conversation is redrawn at the new width with a
half-typed line preserved. Not part of `npm test` (needs `pip install pywinpty`, Windows only).
Run: python scripts/pty_resize_check.py   (after `npm run build`)"""
import json, os, re, sys, tempfile, time
from winpty import PtyProcess

script = os.path.join(tempfile.mkdtemp(), "r.json")
json.dump([{"text": "Hello from the fake model."}, {"text": "Second answer."}], open(script, "w"))
repo = tempfile.mkdtemp()
env = dict(os.environ, DEVAGENT_FAKE_LLM_RESPONSES=script)
env.pop("DEVAGENT_PYTHON", None)

p = PtyProcess.spawn(["node", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "harness", "dist", "cli.js")], cwd=repo, env=env, dimensions=(30, 60))
import threading
buf = ""

def _reader():
    global buf
    while True:
        try:
            chunk = p.read(4096)
        except Exception:
            return
        if chunk:
            buf += chunk

threading.Thread(target=_reader, daemon=True).start()

def pump(seconds):
    time.sleep(seconds)

def mark():
    global buf
    buf = ""

pump(4)
print("== banner ok:", "DevAgent 0.1.0" in buf, "| prompt shown:", "> " in buf)
mark()
p.write("hi\r")
pump(6)
print("== answered:", "Hello from the fake model." in buf)

# half-type something, then resize while idle at the prompt
mark()
p.write("half typed")
pump(1)
mark()
p.setwinsize(30, 40)  # shrink 60 -> 40 columns
pump(2)
clear = "\x1b[2J" in buf
after_clear = buf.split("[2J")[-1]
widths = sorted({len(r) for r in re.findall(r"─+", after_clear)})
print("== after resize to 40 cols: screen cleared:", clear, "| rule widths drawn:", widths)
print("== transcript redrawn:", "Hello from the fake model." in buf, "| half-typed text repainted:", "half typed" in buf)

mark()
p.setwinsize(30, 90)  # grow
pump(2)
widths2 = sorted({len(r) for r in re.findall(r"─+", buf.split("[2J")[-1])})
print("== after resize to 90 cols: rule widths drawn:", widths2)

# finish the line and make sure the typed text was kept
mark()
p.write("\x15")  # ctrl-u clears line
p.write("/exit\r")
pump(3)
print("== exited cleanly:", not p.isalive(), "| bye shown:", "bye" in buf)
try:
    p.terminate(force=True)
except Exception:
    pass
