"""Protocol framing, schema loading, and envelope validation for the reasoning loop.

Mirrors harness/src/protocol/{framing,envelope}.ts and harness/src/config/repoPaths.ts —
both sides read the exact same schema files under schemas/ so they cannot drift apart.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator
from jsonschema.exceptions import ValidationError

MESSAGE_TYPES = (
    "task_start",
    "tool_call",
    "tool_result",
    "plan_update",
    "ask_user",
    "final_answer",
    "error",
    "ping",
    "pong",
)


class FramingError(Exception):
    pass


class LineFramer:
    """Accumulates raw bytes and only decodes complete lines, so a chunk boundary
    landing mid multi-byte UTF-8 character never corrupts a message."""

    def __init__(self, max_line_bytes: int = 10 * 1024 * 1024) -> None:
        self._buffer = bytearray()
        self._max_line_bytes = max_line_bytes

    def push(self, chunk: bytes) -> list[str]:
        self._buffer.extend(chunk)
        lines: list[str] = []
        while True:
            idx = self._buffer.find(b"\n")
            if idx == -1:
                break
            if idx > self._max_line_bytes:
                raise FramingError(f"line exceeds max size of {self._max_line_bytes} bytes")
            line_bytes = bytes(self._buffer[:idx])
            del self._buffer[: idx + 1]
            lines.append(line_bytes.decode("utf-8"))
        if len(self._buffer) > self._max_line_bytes:
            raise FramingError(f"unterminated line exceeds max size of {self._max_line_bytes} bytes")
        return lines


def encode_message(envelope: dict[str, Any]) -> bytes:
    return (json.dumps(envelope) + "\n").encode("utf-8")


def find_repo_root(start_dir: Path, max_levels: int = 8) -> Path:
    """Walks upward looking for schemas/envelope.schema.json + reasoning/pyproject.toml."""
    d = start_dir
    for _ in range(max_levels):
        if (d / "schemas" / "envelope.schema.json").exists() and (d / "reasoning" / "pyproject.toml").exists():
            return d
        if d.parent == d:
            break
        d = d.parent
    raise FileNotFoundError(f"Could not locate DevAgent repo root starting from {start_dir}")


@dataclass
class ValidationResult:
    valid: bool
    errors: list[str]


class SchemaRegistry:
    def __init__(self, schemas_dir: Path) -> None:
        envelope_schema = json.loads((schemas_dir / "envelope.schema.json").read_text("utf-8"))
        self._envelope_validator = Draft7Validator(envelope_schema)
        self._payload_validators: dict[str, Draft7Validator] = {}
        messages_dir = schemas_dir / "messages"
        if messages_dir.is_dir():
            for f in sorted(messages_dir.glob("*.schema.json")):
                msg_type = f.name[: -len(".schema.json")]
                schema = json.loads(f.read_text("utf-8"))
                self._payload_validators[msg_type] = Draft7Validator(schema)
        # Message types without a dedicated payload schema yet (added milestone by
        # milestone) fall back to "any object" so the envelope type enum stays complete.
        self._fallback_validator = Draft7Validator({"type": "object"})

    def validate_envelope(self, data: Any) -> ValidationResult:
        errors = [self._format_error(e) for e in self._envelope_validator.iter_errors(data)]
        if errors:
            return ValidationResult(valid=False, errors=errors)
        msg_type = data.get("type")
        payload_validator = self._payload_validators.get(msg_type, self._fallback_validator)
        payload_errors = [self._format_error(e) for e in payload_validator.iter_errors(data.get("payload"))]
        if payload_errors:
            return ValidationResult(valid=False, errors=payload_errors)
        return ValidationResult(valid=True, errors=[])

    @staticmethod
    def _format_error(e: ValidationError) -> str:
        path = "/" + "/".join(str(p) for p in e.path)
        return f"{path or '/'} {e.message}"


def make_envelope(msg_type: str, payload: dict[str, Any], session_id: str) -> dict[str, Any]:
    return {
        "v": 1,
        "id": str(uuid.uuid4()),
        "session_id": session_id,
        "ts": datetime.now(timezone.utc).isoformat(),
        "type": msg_type,
        "payload": payload,
    }
