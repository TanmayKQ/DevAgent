"""The plan -> act -> observe -> reflect -> finish state graph (PRD FR3).

`act` never touches the filesystem or a shell itself — it calls `interrupt()`, which pauses
the compiled graph and hands the tool-call payload back to whoever invoked it (__main__.py).
The harness executes the tool and the caller resumes the graph with `Command(resume=result)`.
This is the mechanism that keeps the reasoning loop honest about never having real side
effects: the only way out of `act` is through the caller.
"""
from __future__ import annotations

import json
import operator
from typing import Annotated, Any, Callable, Optional, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.runnables import Runnable
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import interrupt

SYSTEM_PROMPT = (
    "You are DevAgent, an autonomous coding assistant with read-only access to a repository "
    "via the read_file, list_dir, and search_code tools. Use them as needed to answer the "
    "user's question about the repository. When you have enough information, reply with a "
    "final plain-text answer and do not call any more tools."
)

NotifyFn = Callable[[str, Optional[dict[str, Any]]], None]


class AgentState(TypedDict):
    task: str
    repo_root: str
    max_iterations: int
    iterations: int
    messages: Annotated[list[BaseMessage], add_messages]
    last_tool_call_id: Optional[str]
    last_tool_result: Optional[dict[str, Any]]
    final_answer: Optional[str]


def build_graph(model: Runnable, notify: NotifyFn, checkpointer=None):
    """`model` must already have tools bound (model.invoke(messages) -> AIMessage). Injecting
    it as a plain Runnable (rather than constructing a provider client in here) is what lets
    tests pass a scripted fake model instead of ever calling a real LLM API (NFR5)."""

    def plan(state: AgentState) -> dict:
        notify("planning", {"iteration": state["iterations"]})
        ai_message = model.invoke(state["messages"])
        # Notify here, not in `act`: a node with an interrupt() re-runs everything before
        # the interrupt on resume, so a notify() placed in `act` would fire twice per call.
        if isinstance(ai_message, AIMessage) and ai_message.tool_calls:
            call = ai_message.tool_calls[0]
            notify("calling_tool", {"name": call["name"], "arguments": call["args"]})
        return {"messages": [ai_message]}

    def route_after_plan(state: AgentState) -> str:
        last = state["messages"][-1]
        if isinstance(last, AIMessage) and last.tool_calls:
            return "act"
        return "finish"

    def act(state: AgentState) -> dict:
        last = state["messages"][-1]
        call = last.tool_calls[0]  # M1: one tool call per turn
        tool_result = interrupt({"call_id": call["id"], "name": call["name"], "arguments": call["args"]})
        return {"last_tool_call_id": call["id"], "last_tool_result": tool_result}

    def observe(state: AgentState) -> dict:
        result = state["last_tool_result"] or {}
        call_id = state["last_tool_call_id"] or ""
        if result.get("ok"):
            content = json.dumps(result.get("result", {}))
        else:
            err = result.get("error", {})
            content = f"ERROR[{err.get('code', 'unknown')}]: {err.get('message', 'tool failed')}"
        notify("observed", {"ok": bool(result.get("ok"))})
        return {
            "messages": [ToolMessage(content=content, tool_call_id=call_id)],
            "iterations": state["iterations"] + 1,
        }

    def reflect(state: AgentState) -> dict:
        if state["iterations"] >= state["max_iterations"]:
            notify("reflecting", {"decision": "stop_max_iterations"})
            return {"final_answer": "Stopped: reached max iterations before producing a final answer."}
        notify("reflecting", {"decision": "continue"})
        return {}

    def route_after_reflect(state: AgentState) -> str:
        return "finish" if state.get("final_answer") else "plan"

    def finish(state: AgentState) -> dict:
        if state.get("final_answer"):
            return {}
        last = state["messages"][-1]
        text = last.content if isinstance(last.content, str) else str(last.content)
        notify("finished", None)
        return {"final_answer": text}

    graph = StateGraph(AgentState)
    graph.add_node("plan", plan)
    graph.add_node("act", act)
    graph.add_node("observe", observe)
    graph.add_node("reflect", reflect)
    graph.add_node("finish", finish)

    graph.add_edge(START, "plan")
    graph.add_conditional_edges("plan", route_after_plan, {"act": "act", "finish": "finish"})
    graph.add_edge("act", "observe")
    graph.add_edge("observe", "reflect")
    graph.add_conditional_edges("reflect", route_after_reflect, {"plan": "plan", "finish": "finish"})
    graph.add_edge("finish", END)

    return graph.compile(checkpointer=checkpointer)


def initial_state(task: str, repo_root: str, max_iterations: int) -> AgentState:
    from langchain_core.messages import HumanMessage, SystemMessage

    return {
        "task": task,
        "repo_root": repo_root,
        "max_iterations": max_iterations,
        "iterations": 0,
        "messages": [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=task)],
        "last_tool_call_id": None,
        "last_tool_result": None,
        "final_answer": None,
    }
