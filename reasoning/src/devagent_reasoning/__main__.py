"""Entry point for the DevAgent reasoning loop: reads/writes protocol envelopes over stdio.

`ping` is answered directly. `task_start` drives the plan/act/observe/reflect/finish graph
(graph.py) to completion, using a single shared envelope generator so the blocking wait for
each tool's `tool_result` can interleave with the top-level dispatch loop without losing data.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Iterator

from dotenv import load_dotenv
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from .graph import build_graph, initial_state
from .model import build_model
from .protocol import FramingError, LineFramer, SchemaRegistry, encode_message, find_repo_root, make_envelope

DEFAULT_MODEL = "gemini-3.8-flash"


_MODELS: dict[str, Any] = {}


def _get_model(schemas_dir: Path, name: str):
    """One model per process: an interactive session sends many tasks, and rebuilding the client
    (or restarting a scripted fake model) for each one would be wasteful and wrong."""
    if name not in _MODELS:
        _MODELS[name] = build_model(schemas_dir, name)
    return _MODELS[name]


def main() -> int:
    repo_root = find_repo_root(Path(__file__).resolve().parent)
    load_dotenv(repo_root / ".env")
    registry = SchemaRegistry(repo_root / "schemas")

    stdout = sys.stdout.buffer
    checkpointer = InMemorySaver()

    envelopes = _iter_envelopes(sys.stdin.buffer, registry)
    for kind, item in envelopes:
        if kind == "error":
            _write(stdout, item)
            continue
        envelope = item
        if envelope["type"] == "ping":
            _write(stdout, make_envelope("pong", {"in_reply_to": envelope["id"]}, envelope["session_id"]))
        elif envelope["type"] == "task_start":
            _run_task(envelope, envelopes, stdout, repo_root, checkpointer)
        # Other top-level message types are not expected from the harness at M1.
    return 0


def _run_task(task_envelope: dict, envelopes: Iterator[tuple[str, Any]], stdout, repo_root: Path, checkpointer) -> None:
    session_id = task_envelope["session_id"]
    payload = task_envelope["payload"]

    def notify(step: str, detail: dict | None) -> None:
        body: dict[str, Any] = {"step": step}
        if detail is not None:
            body["detail"] = detail
        _write(stdout, make_envelope("plan_update", body, session_id))

    try:
        model = _get_model(repo_root / "schemas", payload.get("model") or DEFAULT_MODEL)
        graph = build_graph(model, notify, checkpointer=checkpointer)

        # A fresh thread per task: one chat session sends many task_starts, and reusing the session id
        # would merge each new task into the previous task's finished checkpoint.
        config = {"configurable": {"thread_id": task_envelope["id"]}}
        state = initial_state(payload["task"], payload["repo_root"], payload["max_iterations"], payload.get("history"))
        result = graph.invoke(state, config=config)

        while "__interrupt__" in result:
            call_payload = result["__interrupt__"][0].value
            if call_payload["name"] == "ask_user":
                question = call_payload["arguments"]["question"]
                _write(stdout, make_envelope("ask_user", {"question": question}, session_id))
                answer = _await_ask_user_response(envelopes, stdout)
                resume_payload: dict[str, Any] = {"ok": True, "result": {"answer": answer}}
            else:
                _write(stdout, make_envelope("tool_call", call_payload, session_id))
                resume_payload = _await_tool_result(envelopes, call_payload["call_id"], stdout)
            result = graph.invoke(Command(resume=resume_payload), config=config)

        _write(stdout, make_envelope("final_answer", {"summary": result.get("final_answer") or ""}, session_id))
    except Exception as exc:  # noqa: BLE001 - a task failure must become an error envelope, never a crash (NFR1)
        _write(
            stdout,
            make_envelope("error", {"code": "task_failed", "message": f"{type(exc).__name__}: {exc}"}, session_id),
        )


def _await_tool_result(envelopes: Iterator[tuple[str, Any]], call_id: str, stdout) -> dict:
    for kind, item in envelopes:
        if kind == "error":
            _write(stdout, item)
            continue
        envelope = item
        if envelope["type"] == "tool_result" and envelope["payload"].get("call_id") == call_id:
            return envelope["payload"]
        if envelope["type"] == "ping":
            _write(stdout, make_envelope("pong", {"in_reply_to": envelope["id"]}, envelope["session_id"]))
            continue
        # Ignore anything else (e.g. a stale tool_result) while awaiting this specific call.
    raise RuntimeError("stdin closed while awaiting a tool_result")


def _await_ask_user_response(envelopes: Iterator[tuple[str, Any]], stdout) -> str:
    for kind, item in envelopes:
        if kind == "error":
            _write(stdout, item)
            continue
        envelope = item
        if envelope["type"] == "ask_user_response":
            return envelope["payload"]["answer"]
        if envelope["type"] == "ping":
            _write(stdout, make_envelope("pong", {"in_reply_to": envelope["id"]}, envelope["session_id"]))
            continue
        # Ignore anything else (e.g. a stale message) while awaiting this specific answer.
    raise RuntimeError("stdin closed while awaiting an ask_user_response")


def _iter_envelopes(stdin, registry: SchemaRegistry) -> Iterator[tuple[str, Any]]:
    framer = LineFramer()
    while True:
        chunk = stdin.read1(4096)
        if not chunk:
            return
        try:
            lines = framer.push(chunk)
        except FramingError as exc:
            yield ("error", make_envelope("error", {"code": "framing_error", "message": str(exc)}, "unknown"))
            return
        for line in lines:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                yield ("error", make_envelope("error", {"code": "invalid_json", "message": str(exc)}, "unknown"))
                continue
            result = registry.validate_envelope(obj)
            if not result.valid:
                session_id = obj.get("session_id", "unknown") if isinstance(obj, dict) else "unknown"
                yield (
                    "error",
                    make_envelope(
                        "error", {"code": "schema_validation_failed", "message": "; ".join(result.errors)}, session_id
                    ),
                )
                continue
            yield ("ok", obj)


def _write(stdout, envelope: dict) -> None:
    stdout.write(encode_message(envelope))
    stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
