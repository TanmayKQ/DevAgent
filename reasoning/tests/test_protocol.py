import json
import random
from pathlib import Path

import pytest

from devagent_reasoning.protocol import (
    FramingError,
    LineFramer,
    SchemaRegistry,
    encode_message,
    find_repo_root,
    make_envelope,
)

REPO_ROOT = find_repo_root(Path(__file__).resolve().parent)


def test_line_framer_reassembles_arbitrarily_chunked_input():
    messages = [{"n": i, "note": "x" * (i % 5)} for i in range(50)]
    raw = b"".join((json.dumps(m) + "\n").encode("utf-8") for m in messages)

    rng = random.Random(42)
    chunks = []
    i = 0
    while i < len(raw):
        step = rng.randint(1, 7)
        chunks.append(raw[i : i + step])
        i += step

    framer = LineFramer()
    seen = []
    for chunk in chunks:
        for line in framer.push(chunk):
            seen.append(json.loads(line))

    assert seen == messages


def test_line_framer_rejects_oversized_line():
    framer = LineFramer(max_line_bytes=10)
    with pytest.raises(FramingError):
        framer.push(b"x" * 20 + b"\n")


def test_line_framer_handles_multibyte_utf8_split_across_chunks():
    raw = encode_message({"text": "café ✅"})
    framer = LineFramer()
    seen = []
    for i in range(len(raw)):
        for line in framer.push(raw[i : i + 1]):
            seen.append(json.loads(line))
    assert seen == [{"text": "café ✅"}]


def test_encode_message_round_trips():
    envelope = make_envelope("ping", {}, "session-1")
    encoded = encode_message(envelope)
    assert encoded.endswith(b"\n")
    decoded = json.loads(encoded.decode("utf-8").strip())
    assert decoded == envelope


def test_schema_registry_accepts_valid_ping():
    registry = SchemaRegistry(REPO_ROOT / "schemas")
    envelope = make_envelope("ping", {}, "session-1")
    result = registry.validate_envelope(envelope)
    assert result.valid, result.errors


def test_schema_registry_accepts_valid_pong():
    registry = SchemaRegistry(REPO_ROOT / "schemas")
    envelope = make_envelope("pong", {"in_reply_to": "abc"}, "session-1")
    result = registry.validate_envelope(envelope)
    assert result.valid, result.errors


def test_schema_registry_rejects_missing_required_field():
    registry = SchemaRegistry(REPO_ROOT / "schemas")
    envelope = make_envelope("error", {"message": "oops"}, "session-1")  # missing "code"
    result = registry.validate_envelope(envelope)
    assert not result.valid


def test_schema_registry_rejects_unknown_envelope_field():
    registry = SchemaRegistry(REPO_ROOT / "schemas")
    envelope = make_envelope("ping", {}, "session-1")
    envelope["unexpected"] = "nope"
    result = registry.validate_envelope(envelope)
    assert not result.valid


def test_schema_registry_falls_back_to_permissive_validation_for_unmapped_type():
    # ask_user has no schemas/messages/ask_user.schema.json yet (arrives when M2/M3 need it).
    registry = SchemaRegistry(REPO_ROOT / "schemas")
    envelope = make_envelope("ask_user", {"anything": "goes"}, "session-1")
    result = registry.validate_envelope(envelope)
    assert result.valid, result.errors
