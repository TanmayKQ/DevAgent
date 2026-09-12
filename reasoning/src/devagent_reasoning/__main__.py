"""Entry point for the DevAgent reasoning loop: reads/writes protocol envelopes over stdio.

At M0 this only answers `ping` with `pong`; task planning/tool-calling arrive at M1+.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from .protocol import FramingError, LineFramer, SchemaRegistry, encode_message, find_repo_root, make_envelope


def main() -> int:
    repo_root = find_repo_root(Path(__file__).resolve().parent)
    registry = SchemaRegistry(repo_root / "schemas")

    framer = LineFramer()
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer

    while True:
        # read1(), not read(): BufferedReader.read(n) blocks trying to fill n bytes even
        # when the pipe stays open (our harness never closes stdin between messages).
        # read1() returns after a single underlying read, as soon as any data is available.
        chunk = stdin.read1(4096)
        if not chunk:
            break
        try:
            lines = framer.push(chunk)
        except FramingError as exc:
            _write(stdout, make_envelope("error", {"code": "framing_error", "message": str(exc)}, "unknown"))
            break
        for line in lines:
            _handle_line(line, registry, stdout)
    return 0


def _handle_line(line: str, registry: SchemaRegistry, stdout) -> None:
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as exc:
        _write(stdout, make_envelope("error", {"code": "invalid_json", "message": str(exc)}, "unknown"))
        return

    result = registry.validate_envelope(obj)
    if not result.valid:
        session_id = obj.get("session_id", "unknown") if isinstance(obj, dict) else "unknown"
        _write(
            stdout,
            make_envelope(
                "error", {"code": "schema_validation_failed", "message": "; ".join(result.errors)}, session_id
            ),
        )
        return

    if obj["type"] == "ping":
        _write(stdout, make_envelope("pong", {"in_reply_to": obj["id"]}, obj["session_id"]))
    # Other message types are handled starting M1.


def _write(stdout, envelope: dict) -> None:
    stdout.write(encode_message(envelope))
    stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
