from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from devagent_reasoning.graph import build_graph, initial_state


def _notifier():
    events = []

    def notify(step, detail):
        events.append((step, detail))

    return notify, events


def test_single_tool_call_then_final_answer():
    responses = [
        AIMessage(
            content="",
            tool_calls=[{"name": "list_dir", "args": {"path": "."}, "id": "call_1", "type": "tool_call"}],
        ),
        AIMessage(content="There are 2 files: a.py and b.py."),
    ]
    model = FakeMessagesListChatModel(responses=responses)
    notify, events = _notifier()
    graph = build_graph(model, notify, checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "t-single"}}

    result = graph.invoke(initial_state("what files are here?", "/fake/repo", 10), config=config)
    assert "__interrupt__" in result
    call = result["__interrupt__"][0].value
    assert call == {"call_id": "call_1", "name": "list_dir", "arguments": {"path": "."}}

    result = graph.invoke(
        Command(resume={"call_id": "call_1", "ok": True, "result": {"entries": []}}),
        config=config,
    )
    assert "__interrupt__" not in result
    assert result["final_answer"] == "There are 2 files: a.py and b.py."
    # calling_tool must be emitted exactly once per call, not once per resume-replay of `act`.
    assert events.count(("calling_tool", {"name": "list_dir", "arguments": {"path": "."}})) == 1


def test_no_tool_calls_finishes_immediately():
    model = FakeMessagesListChatModel(responses=[AIMessage(content="This repo has no README.")])
    notify, _ = _notifier()
    graph = build_graph(model, notify, checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "t-direct"}}

    result = graph.invoke(initial_state("is there a README?", "/fake/repo", 10), config=config)
    assert "__interrupt__" not in result
    assert result["final_answer"] == "This repo has no README."


def test_failed_tool_result_is_fed_back_as_an_error_observation():
    responses = [
        AIMessage(
            content="",
            tool_calls=[{"name": "read_file", "args": {"path": "missing.txt"}, "id": "call_1", "type": "tool_call"}],
        ),
        AIMessage(content="That file doesn't exist."),
    ]
    model = FakeMessagesListChatModel(responses=responses)
    notify, _ = _notifier()
    graph = build_graph(model, notify, checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "t-error"}}

    result = graph.invoke(initial_state("read missing.txt", "/fake/repo", 10), config=config)
    result = graph.invoke(
        Command(resume={"call_id": "call_1", "ok": False, "error": {"code": "not_found", "message": "no such file"}}),
        config=config,
    )
    assert result["final_answer"] == "That file doesn't exist."
    tool_messages = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert any("ERROR[not_found]" in m.content for m in tool_messages)


def test_gives_up_after_max_iterations():
    # Every response is another tool call — the agent never produces a final answer on its own.
    responses = [
        AIMessage(
            content="",
            tool_calls=[{"name": "list_dir", "args": {"path": "."}, "id": f"call_{i}", "type": "tool_call"}],
        )
        for i in range(10)
    ]
    model = FakeMessagesListChatModel(responses=responses)
    notify, events = _notifier()
    graph = build_graph(model, notify, checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "t-maxiter"}}

    result = graph.invoke(initial_state("loop forever", "/fake/repo", 2), config=config)
    for _ in range(2):
        result = graph.invoke(
            Command(resume={"call_id": result["__interrupt__"][0].value["call_id"], "ok": True, "result": {}}),
            config=config,
        )

    assert "__interrupt__" not in result
    assert result["final_answer"] == "Stopped: reached max iterations before producing a final answer."
    assert ("reflecting", {"decision": "stop_max_iterations"}) in events


def test_ask_user_uses_the_same_interrupt_resume_contract_as_a_tool_call():
    # graph.py has no ask_user-specific branching at all — __main__.py is the only place that
    # tells ask_user apart from a real tool, purely by checking the interrupted call's `name`.
    # This test locks in that the interrupt payload shape and the resume shape are exactly the
    # same as any other tool, which is what makes that __main__.py-only routing possible.
    responses = [
        AIMessage(
            content="",
            tool_calls=[
                {"name": "ask_user", "args": {"question": "Tabs or spaces?"}, "id": "call_1", "type": "tool_call"}
            ],
        ),
        AIMessage(content="Using spaces, as you said."),
    ]
    model = FakeMessagesListChatModel(responses=responses)
    notify, events = _notifier()
    graph = build_graph(model, notify, checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "t-ask"}}

    result = graph.invoke(initial_state("set up formatting", "/fake/repo", 10), config=config)
    assert "__interrupt__" in result
    call = result["__interrupt__"][0].value
    assert call == {"call_id": "call_1", "name": "ask_user", "arguments": {"question": "Tabs or spaces?"}}
    assert ("asking_user", {"name": "ask_user", "arguments": {"question": "Tabs or spaces?"}}) in events

    result = graph.invoke(
        Command(resume={"call_id": "call_1", "ok": True, "result": {"answer": "spaces"}}),
        config=config,
    )
    assert "__interrupt__" not in result
    assert result["final_answer"] == "Using spaces, as you said."
    tool_messages = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert any('"answer": "spaces"' in m.content for m in tool_messages)
