"""Constructs the real Gemini-backed chat model with tools bound. Kept separate from
graph.py so the graph itself only ever depends on a plain Runnable — tests inject a fake
model instead of importing anything from this module (NFR5: no live LLM calls in unit tests).

Set DEVAGENT_FAKE_LLM_RESPONSES to the path of a JSON file (a list of
`{"tool_call": {"name", "args"}}` or `{"text": "..."}` steps) to swap in a scripted fake
model instead of a real one — this is what lets the harness's own integration test drive a
real cross-process run (real stdio, real tool execution) without a live API key.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from langchain_core.messages import AIMessage
from langchain_core.runnables import Runnable

from .tools import load_tool_specs


def build_model(schemas_dir: Path, model_name: str, fast: bool = False) -> Runnable:
    fake_responses_path = os.environ.get("DEVAGENT_FAKE_LLM_RESPONSES")
    if fake_responses_path:
        return _build_fake_model(Path(fake_responses_path))

    from langchain_google_genai import ChatGoogleGenerativeAI

    # fast=True turns off extended 'thinking': roughly halves reply latency, at the cost of less
    # careful reasoning on hard multi-step tasks — which is why it's an opt-in, not the default.
    llm = ChatGoogleGenerativeAI(model=model_name, **({"thinking_budget": 0} if fast else {}))
    return llm.bind_tools(load_tool_specs(schemas_dir))


def _build_fake_model(path: Path) -> Runnable:
    from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel

    steps = json.loads(path.read_text("utf-8"))
    responses = []
    for i, step in enumerate(steps):
        if "tool_call" in step:
            call = step["tool_call"]
            responses.append(
                AIMessage(
                    content="",
                    tool_calls=[
                        {"name": call["name"], "args": call["args"], "id": f"fake_call_{i}", "type": "tool_call"}
                    ],
                )
            )
        else:
            responses.append(AIMessage(content=step["text"]))
    return FakeMessagesListChatModel(responses=responses)
