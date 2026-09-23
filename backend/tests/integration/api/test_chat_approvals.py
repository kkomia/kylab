"""对话里的「等用户点头」端到端（v0.41，用户报的第 6 条）。

镜像同构：``app/api/v1/chat.py`` 的 ``decide_approval`` / ``_TurnSink.feed``
与 ``services/approvals.py`` → 本文件。

模块用例（``tests/unit/services/test_tool_loop.py`` 与 ``test_agent_exec.py``）
已经钉住了"循环会停下来等"与"执行器照决定办事"；这里是**把它们接上真实的请求**：

1. 流真的把 ``approval`` 事件发出来了（界面上那条确认条靠它）；
2. **它发出来之后那一轮就停住了**——这时另一个请求（端点）把决定送回来，
   那一轮继续跑完、命令真的执行了、结果回到模型手里；
3. 失效的确认（超时 / 已处理）**回 409 而不是"已记录"**。

**为什么用线程 + 一个客户端**：这是"两条并行请求"的最小复现——
``TestClient`` 的一次请求会一直读到响应体结束（见 starlette 的
``_TestClientTransport.handle_request``），所以那条流必须在**另一个线程**里跑，
主线程才能腾出来发那条决定。
"""

from __future__ import annotations

import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app.core.services import get_services
from app.services import isolation as isolation_service
from app.services.llm import LLMReply, ToolCall
from tests.conftest import admin_client as admin_session
from tests.conftest import install_fake_chat


@pytest.fixture
def client():
    with admin_session() as test_client:
        yield test_client


def _parse_sse(text: str) -> list[dict]:  # type: ignore[type-arg]
    return [json.loads(line[5:].strip()) for line in text.splitlines() if line.startswith("data:")]


def _install_runnable(monkeypatch) -> list[list[str]]:  # type: ignore[no-untyped-def]
    """把"这台机器上能跑命令"这件事搭起来，并记录**真的起了哪条命令**。

    本机（Windows）没有 bwrap / docker，不搭这一层的话链路会停在"这台机器没有隔离"
    ——那是**闸 3 在问之前就拒绝**的正确行为（见 ``test_agent_exec`` 的用例），
    但它到不了"等用户点头"这一步。所以：假装有隔离，并把 ``run_isolated`` 换成假的。
    """
    from app.services import agent_exec

    monkeypatch.setattr(
        agent_exec,
        "_detect",
        lambda force=False: isolation_service.Isolation("bwrap", True, "测试里假装就位"),
    )
    calls: list[list[str]] = []
    monkeypatch.setattr(
        isolation_service,
        "run_isolated",
        lambda argv, **kwargs: (
            calls.append(list(argv))
            or isolation_service.ExecutionResult(0, "hello\n", "", False, "bwrap")
        ),
    )
    return calls


def _run_command_call(command: str, call_id: str = "c1") -> LLMReply:
    """一条"模型想跑命令"的回复（工具循环的第一步）。"""
    return LLMReply(
        tool_calls=(
            ToolCall(id=call_id, name="run_command", arguments=json.dumps({"command": command})),
        )
    )


def _open_conversation(client: TestClient) -> str:
    return client.post("/api/v1/conversations", json={"title": "执行确认"}).json()["id"]


@pytest.fixture
def fast_timeout():
    """把等待窗口压到 5 秒：**为了让失败快点暴露**（等不到决定时不必真等 120 秒）。

    真跑起来就是"用户没回应"那条路，与生产同一条；只是这里不陪它等两分钟。
    """
    registry = get_services().approvals
    original = registry._timeout
    registry._timeout = 5.0
    yield registry
    registry._timeout = original


def test_the_stream_asks_then_waits_then_runs(  # type: ignore[no-untyped-def]
    client: TestClient, monkeypatch, fast_timeout
) -> None:
    """**这条就是用户要的那个闭环**：问 → 停住等 → 用户点允许 → 真的执行 → 结果回给模型。

    三个断言各对应用户能感知的一件事：确认条出现了、命令真的跑了、这一轮接着跑完了。
    """
    calls = _install_runnable(monkeypatch)
    install_fake_chat("跑完了", script=[_run_command_call("echo hi"), LLMReply()])
    conversation_id = _open_conversation(client)

    services = get_services()
    opened = []
    ready = threading.Event()
    original_open = services.approvals.open

    def spy(**kwargs):  # type: ignore[no-untyped-def]
        request = original_open(**kwargs)
        opened.append(request)
        ready.set()
        return request

    monkeypatch.setattr(services.approvals, "open", spy)

    # **"先发再等"要能被观察到**：记下那条 approval 事件被翻成 SSE 字符串的时刻。
    # 它必须早于我们把决定送出去——否则界面上根本看不到那条确认条，
    # 而那一轮已经在等了（两边一起等死，这就是老注释里记的那个形状）。
    from app.api.v1 import chat as chat_api

    emitted = threading.Event()
    real_sse = chat_api._sse

    def spy_sse(payload: dict, **kwargs):  # type: ignore[type-arg]
        # ``**kwargs`` 收下 ``seq``（P2-2 起，带会话那条流会给每条事件编号）：
        # 这条用例认的是"那条询问被序列化出去了"，编号是顺带的东西
        text = real_sse(payload, **kwargs)
        if payload.get("type") == "approval":
            emitted.set()
        return text

    monkeypatch.setattr(chat_api, "_sse", spy_sse)

    box: dict[str, object] = {}

    def stream() -> None:
        box["response"] = client.post(
            "/api/v1/chat/stream",
            json={"query": "看看目录", "conversation_id": conversation_id, "kb_ids": []},
        )

    worker = threading.Thread(target=stream, daemon=True)
    worker.start()
    assert ready.wait(10), "执行器应当登记一条待确认（界面上那条确认条）"
    request = opened[0]
    assert request.args == "echo hi"
    assert emitted.wait(2), "那条询问要**先送出去**，循环才会停下来等"
    # **在回答之前它什么都没跑**
    assert calls == []

    # 用户点了「允许一次」——走端点，与界面上那个按钮同一条路
    decided = client.post(
        f"/api/v1/chat/approvals/{request.approval_id}", json={"decision": "allow_once"}
    )
    assert decided.status_code == 200, decided.text
    assert decided.json()["accepted"] is True

    worker.join(15)
    assert not worker.is_alive(), "拿到决定之后那一轮应当自己往下跑完"

    events = _parse_sse(box["response"].text)  # type: ignore[union-attr]
    kinds = [event["type"] for event in events]
    assert "approval" in kinds
    # 确认条要带着命令原文与"这类都允许"会写下的那行规则
    approval = next(event for event in events if event["type"] == "approval")
    assert approval["tool"] == "run_command"
    assert approval["args"] == "echo hi"
    assert approval["rule"] == "Bash(echo:*)"
    assert approval["label"] == "执行命令"
    assert approval["detail"]
    # **命令真的跑了**，而且这一轮跑到了收尾
    assert calls == [["echo", "hi"]]
    assert kinds[-1] == "done"
    # 结果回到循环里：那一步的结论是"跑完了"，不是"等待确认"
    tool_steps = [e for e in events if e["type"] == "step" and e["label"] == "执行命令"]
    assert [e["status"] for e in tool_steps] == ["running", "done"]
    assert "跑完了" in tool_steps[-1]["detail"]


def test_deny_keeps_the_turn_going_without_running(  # type: ignore[no-untyped-def]
    client: TestClient, monkeypatch, fast_timeout
) -> None:
    """点了「拒绝」：命令不执行，但**这一轮要继续**——模型据此换条路，而不是整轮失败。"""
    calls = _install_runnable(monkeypatch)
    install_fake_chat("那我换个办法", script=[_run_command_call("rm -rf /"), LLMReply()])
    conversation_id = _open_conversation(client)

    services = get_services()
    opened = []
    ready = threading.Event()
    original_open = services.approvals.open

    def spy(**kwargs):  # type: ignore[no-untyped-def]
        request = original_open(**kwargs)
        opened.append(request)
        ready.set()
        return request

    monkeypatch.setattr(services.approvals, "open", spy)
    box: dict[str, object] = {}

    def stream() -> None:
        box["response"] = client.post(
            "/api/v1/chat/stream",
            json={"query": "删掉它", "conversation_id": conversation_id, "kb_ids": []},
        )

    worker = threading.Thread(target=stream, daemon=True)
    worker.start()
    assert ready.wait(10)
    decided = client.post(
        f"/api/v1/chat/approvals/{opened[0].approval_id}", json={"decision": "deny"}
    )
    assert decided.status_code == 200
    worker.join(15)
    assert not worker.is_alive()

    assert calls == [], "拒绝了就不该起进程"
    events = _parse_sse(box["response"].text)  # type: ignore[union-attr]
    assert [event["type"] for event in events][-1] == "done"


def test_a_stale_decision_is_refused_not_acknowledged(client: TestClient, fast_timeout) -> None:  # type: ignore[no-untyped-def]
    """失效的确认**回 409**：绝不能回一句"已记录"——那会让用户以为命令执行了。"""
    response = client.post("/api/v1/chat/approvals/some-stale-id", json={"decision": "allow_once"})
    assert response.status_code == 409
    assert "失效" in response.json()["message"]


def test_a_decision_can_only_be_delivered_once(client: TestClient, fast_timeout) -> None:  # type: ignore[no-untyped-def]
    """同一个 id 只认一次：第二条决定拿回 409（那条确认已经被消费掉了）。"""
    request = get_services().approvals.open(
        tool="run_command", label="执行命令", args="ls", rule="Bash(ls:*)"
    )
    got: list[str] = []
    waiter = threading.Thread(
        target=lambda: got.append(get_services().approvals.wait(request.approval_id))
    )
    waiter.start()
    # 等那一头真的进到 wait 里（否则这条用例测的就只是"set 一个 Event"）
    time.sleep(0.05)

    first = client.post(f"/api/v1/chat/approvals/{request.approval_id}", json={"decision": "deny"})
    second = client.post(
        f"/api/v1/chat/approvals/{request.approval_id}", json={"decision": "allow_once"}
    )
    waiter.join(5)

    assert first.status_code == 200
    assert second.status_code == 409
    assert got == ["deny"], "等在那一头的执行器拿到的必须是**第一条**决定"


def test_only_the_three_decisions_are_accepted(client: TestClient) -> None:
    """请求体只认那三个取值：别的（"yes"、"timeout"）是 422。

    ``timeout`` 尤其重要：它是**执行侧的结论**，能从请求里伪造就等于给了一条
    绕过"等用户点头"的路。
    """
    request = get_services().approvals.open(
        tool="run_command", label="执行命令", args="ls", rule="Bash(ls:*)"
    )
    for bad in ("yes", "timeout", "unavailable", ""):
        response = client.post(
            f"/api/v1/chat/approvals/{request.approval_id}", json={"decision": bad}
        )
        assert response.status_code == 422, f"{bad!r} 不该被接受"
