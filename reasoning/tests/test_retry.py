import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver

from devagent_reasoning.graph import build_graph, initial_state
from devagent_reasoning.retry import invoke_with_retry, is_rate_limit_error, suggested_wait_s

RATE_LIMIT_MSG = (
    "GoogleRateLimitError: Error calling model 'x' (RESOURCE_EXHAUSTED): 429 RESOURCE_EXHAUSTED. "
    "Please retry in 16.6s."
)


def test_detects_rate_limit_errors_and_ignores_others():
    assert is_rate_limit_error(RuntimeError(RATE_LIMIT_MSG))
    assert not is_rate_limit_error(ValueError("bad request: schema invalid"))


def test_honors_the_providers_suggested_wait_plus_a_second():
    assert suggested_wait_s(RuntimeError(RATE_LIMIT_MSG)) == pytest.approx(17.6)


def test_falls_back_to_a_default_wait_when_no_hint():
    assert suggested_wait_s(RuntimeError("429 too many")) == 20.0


def test_retries_after_a_rate_limit_then_succeeds():
    calls, sleeps, events = [], [], []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise RuntimeError(RATE_LIMIT_MSG)
        return "ok"

    assert invoke_with_retry(flaky, lambda s, d: events.append((s, d)), sleep=sleeps.append) == "ok"
    assert len(calls) == 3 and len(sleeps) == 2
    assert [e[0] for e in events] == ["rate_limited", "rate_limited"]


def test_gives_up_after_max_attempts():
    def always():
        raise RuntimeError(RATE_LIMIT_MSG)

    with pytest.raises(RuntimeError):
        invoke_with_retry(always, lambda s, d: None, max_attempts=3, sleep=lambda _s: None)


def test_non_rate_limit_errors_are_not_retried():
    calls = []

    def broken():
        calls.append(1)
        raise ValueError("bad request")

    with pytest.raises(ValueError):
        invoke_with_retry(broken, lambda s, d: None, sleep=lambda _s: None)
    assert len(calls) == 1


def test_graph_plan_node_survives_a_rate_limited_model_call():
    class FlakyOnce(FakeMessagesListChatModel):
        failed: bool = False

        def invoke(self, *args, **kwargs):
            if not self.failed:
                self.failed = True
                raise RuntimeError(RATE_LIMIT_MSG)
            return super().invoke(*args, **kwargs)

    model = FlakyOnce(responses=[AIMessage(content="done")])
    events = []
    graph = build_graph(model, lambda s, d: events.append((s, d)), checkpointer=InMemorySaver(), sleep=lambda _s: None)
    result = graph.invoke(initial_state("t", "/r", 5), config={"configurable": {"thread_id": "rl"}})
    assert result["final_answer"] == "done"
    assert any(s == "rate_limited" for s, _ in events)
