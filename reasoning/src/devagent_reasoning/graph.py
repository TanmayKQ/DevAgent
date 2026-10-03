"""The plan -> act -> observe -> reflect -> finish state graph (PRD FR3).

`act` never touches the filesystem or a shell itself — it calls `interrupt()`, which pauses
the compiled graph and hands the tool-call payload back to whoever invoked it (__main__.py).
The harness executes the tool and the caller resumes the graph with `Command(resume=result)`.
This is the mechanism that keeps the reasoning loop honest about never having real side
effects: the only way out of `act` is through the caller.
"""
from __future__ import annotations

import json
from typing import Annotated, Any, Callable, Optional, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.runnables import Runnable
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import interrupt

from .retry import invoke_with_retry

SYSTEM_PROMPT = (
    "You are DevAgent, an autonomous coding assistant working in a repository via read_file, "
    "list_dir, search_code, write_file, apply_patch, run_command, and ask_user. Read before you "
    "write: use read_file to see a file's exact current content before editing it. Prefer "
    "apply_patch (an exact old_string/new_string replacement) for small, targeted edits to "
    "existing files — it's safer and easier for the user to review than rewriting a whole file; "
    "use write_file only to create a new file or when a full rewrite is genuinely what's needed. "
    "Use run_command to run tests, a build, a type-check, or a read-only git query after making "
    "a change, so you can verify your own work instead of assuming it's correct — but only a "
    "fixed set of commands is actually permitted (roughly: npm test, npm run <script>, npx tsc, "
    "pytest, python -m pytest, node <file>, git status/diff/log); anything else will be "
    "rejected, so don't try to install packages, use other git subcommands, or invoke general "
    "shell tools. Every write and every command is shown to the user first and may be declined, "
    "so if a tool_result reports the change or command was rejected or failed, adapt your "
    "approach rather than repeating the same call.\n\n"
    "You get multiple iterations — use them. A task is not done just because a write or a "
    "command succeeded; a write can apply cleanly and still be wrong, and 'ran without error' is "
    "not the same as 'passes'. After making a change, verify it (re-run the relevant test, "
    "build, or type-check) before treating the task as finished, whenever a way to verify is "
    "available. If verification fails, read the failure output, form a specific hypothesis about "
    "the cause, and try a different, targeted fix — don't repeat the same call hoping for a "
    "different result, and don't declare success on an assumption you haven't checked.\n\n"
    "If you're genuinely stuck — the task is ambiguous between reasonable interpretations, "
    "required information isn't discoverable with your tools, or you've tried multiple sound "
    "fixes and still can't get it to verify — use ask_user rather than guessing indefinitely or "
    "quietly giving up. Don't use ask_user for something you could just go check yourself. When "
    "you have enough information and (where verification is possible) it checks out, reply with "
    "a final plain-text answer and do not call any more tools."
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


def build_graph(model: Runnable, notify: NotifyFn, checkpointer=None, sleep=None):
    """`model` must already have tools bound (model.invoke(messages) -> AIMessage). Injecting
    it as a plain Runnable (rather than constructing a provider client in here) is what lets
    tests pass a scripted fake model instead of ever calling a real LLM API (NFR5)."""

    def plan(state: AgentState) -> dict:
        notify("planning", {"iteration": state["iterations"]})
        retry_kwargs = {"sleep": sleep} if sleep else {}
        ai_message = invoke_with_retry(lambda: model.invoke(state["messages"]), notify, **retry_kwargs)
        # Notify here, not in `act`: a node with an interrupt() re-runs everything before
        # the interrupt on resume, so a notify() placed in `act` would fire twice per call.
        if isinstance(ai_message, AIMessage) and ai_message.tool_calls:
            call = ai_message.tool_calls[0]
            step = "asking_user" if call["name"] == "ask_user" else "calling_tool"
            notify(step, {"name": call["name"], "arguments": call["args"]})
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
