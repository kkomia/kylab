"""工具级单步重试的集成测试（D24，2026-09-28 走查；LLM 与执行器都被替换成假实现）。

镜像同构：``app/api/v1/chat.py`` 的 ``retry_step`` / ``_retry_events`` / ``_retry_steps``
与 ``services/tool_loop.ToolLoop.retry_step`` → 本文件。

这条语义有三段，少一段就不是它（用例按这三段分）：

1. **用同样的入参重跑那一步**——而且**闸一个都不绕过**（这里用"权限=仅查看"钉）；
2. **新结果就地替换那一步**——不是"接到末尾"（顺序是这一步的一部分，用户点的也是
   "重试这一步"，不是"再补一步"）；
3. **从那里接着把这一轮答完**——旧回答被顶替（与续跑同一条：同一句提问下不挂两条回答）。

失败必须**真的发生在执行器里**（``tool_loop._execute`` 的 ``KylabError`` 那条路）：
往库里塞一条手写的 ``outcome="failed"``，验的就只剩"我写的那个替换函数"了。
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.core.exceptions import KylabError
from app.core.security import hash_password
from app.core.services import get_services
from app.models.enums import UserRole
from app.services.chat import SourceRef
from app.services.llm import LLMReply, ToolCall
from app.services.session_events import STEP_KINDS
from app.storage.base import UserRecord
from tests.conftest import (
    admin_client as admin_session,
)
from tests.conftest import (
    install_fake_chat,
    search_tool_call,
)

ADMIN_PASSWORD = "correct horse battery"
MEMBER_PASSWORD = "member pass 123"


@pytest.fixture
def client():
    with admin_session() as test_client:
        yield test_client


def _parse_sse(text: str) -> list[dict]:  # type: ignore[type-arg]
    return [json.loads(line[5:].strip()) for line in text.splitlines() if line.startswith("data:")]


def _steps(message) -> list[dict]:  # type: ignore[no-untyped-def]
    return [dict(item) for item in message.steps]


def _install_fake_sources() -> None:
    """让检索返回固定的一段出处（与 ``test_chat_resume`` 同一套做法）。"""

    def fake_sources(*, query: str, kb_ids: list[str], top_k=None, reader=None):  # type: ignore[no-untyped-def]
        return [
            SourceRef(
                index=1,
                chunk_id="c1",
                document_id="d1",
                document_name="指南.pdf",
                heading_path="3 监测",
                page=4,
                score=0.9,
                preview="眼轴长度是主要参数。",
                knowledge_base_id="kb_x",
            )
        ]

    get_services().chat.retrieve_sources = fake_sources  # type: ignore[method-assign]


def _patch_runner(monkeypatch, *, fail_search_times: int) -> None:
    """把执行器换成"**真的**执行器 + 头 N 次检索先失败一次"。

    只动工具那一层（``build_runner`` 的返回值），所以模式闸 / 权限档 / 审批判定
    仍然在循环里照旧跑——这正是"重跑不绕闸"要验的那条链。
    """
    from app.api.v1 import chat as chat_api

    real_build_runner = chat_api.build_runner
    # **计数器挂在这一层**（不是那个 runner 实例里）：每一轮都新建一个 runner，
    # 计数器放进实例的话，重试那一轮会从 0 重新数——"头一次失败"就变成了每次都失败
    seen = {"search": 0}

    def scripted(services, caller, **kwargs):  # type: ignore[no-untyped-def]
        real = real_build_runner(services, caller, **kwargs)

        def runner(name: str, args: dict, approval: str | None = None):  # type: ignore[type-arg,no-untyped-def]
            if name == "search":
                seen["search"] += 1
                if seen["search"] <= fail_search_times:
                    raise KylabError("检索服务这一次没连上")
            return real(name, args, approval=approval) if approval is not None else real(name, args)

        return runner

    monkeypatch.setattr(chat_api, "build_runner", scripted)


@pytest.fixture
def failed_step(client: TestClient, monkeypatch) -> dict:  # type: ignore[type-arg]
    """一条**真跑过并失败**的会话：两步检索，第一步的检索服务没连上。

    两步而不是一步：只有两步才看得出"就地替换"与"接到末尾"的区别。
    """
    services = get_services()
    kb_id = client.post("/api/v1/knowledge-bases", json={"name": "重试库"}).json()["id"]
    conversation_id = client.post(
        "/api/v1/conversations", json={"title": "重试", "kb_ids": [kb_id]}
    ).json()["id"]
    _patch_runner(monkeypatch, fail_search_times=1)
    install_fake_chat(
        "眼轴是主要参数[1]，每 3 个月测一次。",
        script=[search_tool_call("眼轴", "c1"), search_tool_call("眼轴 监测", "c2")],
    )
    _install_fake_sources()

    response = client.post(
        "/api/v1/chat/stream",
        json={"query": "眼轴怎么监测", "conversation_id": conversation_id, "kb_ids": [kb_id]},
    )
    assert response.status_code == 200
    answer = services.conversations.messages(conversation_id)[-1]
    steps = _steps(answer)
    assert [str(item.get("label")) for item in steps].count("检索知识库") == 2, steps
    assert steps[0].get("outcome") == "failed", "夹具要的正是「第一步真的失败了」"
    assert steps[1].get("outcome", "") == "", "第二步照常成功（否则测不出「只重跑第 0 步」）"
    return {"conversation_id": conversation_id, "message_id": answer.id, "steps": steps}


def _retry(client: TestClient, case: dict, *, step_index: int = 0, body: dict | None = None):  # type: ignore[type-arg,no-untyped-def]
    return client.post(
        f"/api/v1/conversations/{case['conversation_id']}"
        f"/messages/{case['message_id']}/steps/{step_index}/retry",
        json=body if body is not None else {},
    )


# --------------------------------------------------------------- 三段语义


def test_retry_replaces_the_step_in_place_and_finishes_the_turn(
    client: TestClient, failed_step: dict
) -> None:  # type: ignore[type-arg]
    """主场景：旧回答被顶替；**第 0 步就地换成新结果**（顺序不变）；这一轮答案照常给出。"""
    services = get_services()
    conversation_id, message_id = failed_step["conversation_id"], failed_step["message_id"]
    before = services.conversations.messages(conversation_id)
    assert [message.role for message in before] == ["user", "assistant"]
    before_steps = _steps(before[1])

    install_fake_chat("眼轴是主要参数[1]，建议每 3 个月测一次。")
    _install_fake_sources()
    response = _retry(client, failed_step)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = _parse_sse(response.text)
    assert events[-1]["type"] == "done"
    assert events[-1]["answer"].endswith("建议每 3 个月测一次。")
    # 重跑那一步也走**与直播同一套事件**：一条 running + 一条带结果的 done
    retried = [
        event
        for event in events
        if event["type"] == "step" and event.get("tool") == "search"
    ]
    assert [event["status"] for event in retried] == ["running", "done"], retried
    assert retried[-1].get("outcome", "") == "", "重跑成功之后不该还挂着 failed"

    after = services.conversations.messages(conversation_id)
    # 提问原地不动、旧回答被顶替（不是挂两条）
    assert [message.role for message in after] == ["user", "assistant"]
    assert after[0].id == before[0].id
    assert after[1].id != message_id

    steps = _steps(after[1])
    labels = [str(item.get("label")) for item in steps]
    # **就地替换**：第 0 步还是"检索知识库"、结果是新的，而第 1 步原样不动；
    # 重跑那一步**不许**在末尾再多出一条（顺序是这一步的一部分，见 `_retry_steps`）
    assert labels[:3] == ["检索知识库", "检索知识库", "组织回答"], labels
    assert labels.count("检索知识库") == 2, labels
    assert steps[0].get("outcome", "") == "", steps[0]
    assert "没连上" not in str(steps[0].get("detail") or ""), steps[0]
    assert steps[0].get("result"), "重跑那一步要带上新的原文（用户点开能看）"
    assert steps[1].get("detail") == before_steps[1].get("detail")
    assert steps[1].get("result") == before_steps[1].get("result")
    # 出处接得上（上一轮那条指南仍在）
    assert [item["document_name"] for item in after[1].sources] == ["指南.pdf"]

    # 日志里要能看出"这一轮是重试第 1 步"（与续跑的 `resume_reason` 同一个字段），
    # 否则回看时会以为是用户又问了一遍
    log = client.get(f"/api/v1/conversations/{conversation_id}/events").json()["items"]
    starts = [item["payload"] for item in log if item["kind"] == "turn/start"]
    assert len(starts) == 2
    assert starts[-1]["resume"] is True
    assert "重试第 1 步" in starts[-1]["resume_reason"]
    # 重跑那一步的新结果也要进事件日志（工具步骤在日志里的 kind 是 `tool_call`，
    # 见 `session_events.STEP_KINDS`）
    assert any(
        item["kind"] in STEP_KINDS and item["payload"].get("tool") == "search"
        for item in log[len(log) - 6 :]
    ), "重跑那一步的新结果也要进事件日志"


def test_retry_that_fails_again_is_still_failed(client: TestClient, failed_step: dict) -> None:  # type: ignore[type-arg]
    """重跑**还是失败**就照旧标 ``failed``——不许把失败粉饰成成功（D22 那套原样带回来）。"""
    services = get_services()
    conversation_id = failed_step["conversation_id"]
    from app.api.v1 import chat as chat_api

    real_build_runner = chat_api.build_runner

    def always_fails(services_, caller, **kwargs):  # type: ignore[no-untyped-def]
        def runner(name: str, args: dict, approval: str | None = None):  # type: ignore[type-arg,no-untyped-def]
            if name == "search":
                raise KylabError("检索服务还是没连上")
            return real_build_runner(services_, caller, **kwargs)(name, args, approval=approval)

        return runner

    chat_api.build_runner = always_fails  # type: ignore[assignment]
    try:
        install_fake_chat("这次真的没查到，先说清楚。")
        _install_fake_sources()
        response = _retry(client, failed_step)
    finally:
        chat_api.build_runner = real_build_runner  # type: ignore[assignment]

    assert response.status_code == 200
    events = _parse_sse(response.text)
    assert events[-1]["type"] == "done"
    assert events[-1]["answer"], "重跑失败也要把这一轮答完（模型拿到的是失败结果）"

    after = services.conversations.messages(conversation_id)
    steps = _steps(after[-1])
    assert steps[0].get("outcome") == "failed", steps[0]
    assert "没连上" in str(steps[0].get("detail") or ""), steps[0]


def test_retry_does_not_bypass_the_permission_gate(client: TestClient, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**重跑不绕闸**：权限是「仅查看」时，写类调用照样被拦下（不是"从历史里再执行一次"）。"""
    services = get_services()
    services.runtime.set({"chat.permission": "view"})
    kb_id = client.post("/api/v1/knowledge-bases", json={"name": "只读库"}).json()["id"]
    conversation_id = client.post(
        "/api/v1/conversations", json={"title": "只读", "kb_ids": [kb_id]}
    ).json()["id"]
    install_fake_chat(
        "我只读，不改动任何东西。",
        script=[
            LLMReply(
                tool_calls=(
                    ToolCall(
                        id="c1",
                        name="create_note",
                        arguments=json.dumps({"title": "x", "content_md": "y"}),
                    ),
                )
            )
        ],
    )
    _install_fake_sources()

    original = client.post(
        "/api/v1/chat/stream",
        json={"query": "写一条笔记", "conversation_id": conversation_id, "kb_ids": [kb_id]},
    )
    assert original.status_code == 200
    answer = services.conversations.messages(conversation_id)[-1]
    blocked = _steps(answer)
    assert blocked[0].get("outcome") == "blocked", blocked[0]
    assert "没有执行" in str(blocked[0].get("detail") or ""), blocked[0]

    install_fake_chat("好，我不写。")
    case = {"conversation_id": conversation_id, "message_id": answer.id}
    response = _retry(client, case)

    assert response.status_code == 200
    events = _parse_sse(response.text)
    steps = [event for event in events if event["type"] == "step" and event.get("tool")]
    assert steps and steps[-1].get("outcome") == "blocked", steps
    assert "仅查看" in str(steps[-1].get("detail") or ""), steps[-1]


def test_the_handover_note_tells_the_model_not_to_call_it_again(
    client: TestClient, failed_step: dict
) -> None:  # type: ignore[type-arg]
    """交给模型的那句话里有三样：哪一步重跑了、结果已经在下面那条 tool 消息里、别再发一遍。"""
    services = get_services()
    captured: list[str] = []
    real_messages = services.chat.agent_messages

    def spy(**kwargs: object):  # type: ignore[no-untyped-def]
        captured.append(str(kwargs["query"]))
        return real_messages(**kwargs)  # type: ignore[arg-type]

    services.chat.agent_messages = spy  # type: ignore[method-assign]
    try:
        install_fake_chat("眼轴是主要参数[1]。")
        _install_fake_sources()
        assert _retry(client, failed_step).status_code == 200
    finally:
        services.chat.agent_messages = real_messages  # type: ignore[method-assign]

    query = captured[0]
    assert "重跑了一次" in query
    assert "检索知识库（工具 search）" in query
    assert "不要再把同一个调用发一遍" in query
    # 材料编号沿用（账本已经接上了）：说明里说 [1] 是那份指南，账本里也得有第 1 条
    assert "[1] 指南.pdf" in query


def test_retry_budget_is_the_normal_one(client: TestClient, failed_step: dict, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """重试**不抬预算**（与续跑刻意不同）：它是"把一条调用重做一遍再把话说完"。"""
    seen: dict[str, object] = {}
    services = get_services()
    real_loop = services.chat.tool_loop

    def spy(**kwargs: object):  # type: ignore[no-untyped-def]
        seen.update(kwargs)
        return real_loop(**kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(services.chat, "tool_loop", spy)
    install_fake_chat("眼轴是主要参数[1]。")
    _install_fake_sources()
    assert _retry(client, failed_step).status_code == 200

    # 两个预算都是 None = **这一层没给值**（默认档留在 ToolLoop 自己那里，见
    # `services/chat.tool_loop`）——与续跑刻意不同：重试不抬预算
    assert seen["max_steps"] is None
    assert seen["max_seconds"] is None


# --------------------------------------------------------------- 边界（422 / 404）


def test_a_non_tool_step_is_422(client: TestClient, failed_step: dict) -> None:  # type: ignore[type-arg]
    """"组织回答"那一步不是工具调用：没有可重跑的动作。"""
    labels = [str(item.get("label")) for item in failed_step["steps"]]
    answer_index = labels.index("组织回答")
    response = _retry(client, failed_step, step_index=answer_index)
    assert response.status_code == 422
    assert "不是工具调用" in response.json()["message"]


def test_a_succeeded_step_is_422(client: TestClient, failed_step: dict) -> None:  # type: ignore[type-arg]
    """已经成功的那一步没有要重试的东西（入口本来就只长在失败/被拦那一步旁边）。"""
    response = _retry(client, failed_step, step_index=1)
    assert response.status_code == 422
    assert "成功的" in response.json()["message"]


def test_an_unknown_step_index_is_422(client: TestClient, failed_step: dict) -> None:  # type: ignore[type-arg]
    response = _retry(client, failed_step, step_index=99)
    assert response.status_code == 422
    assert "这一步不存在" in response.json()["message"]


def test_a_step_without_args_is_422(
    client: TestClient, failed_step: dict, monkeypatch
) -> None:  # type: ignore[type-arg,no-untyped-def]
    """入参没存下来就没法按原样重跑（拿一副空参数去执行**另一个**调用比拒绝更糟）。"""
    from app.services.conversation import LastTurn

    services = get_services()
    real = services.conversations.last_turn

    def without_args(conversation_id: str):  # type: ignore[no-untyped-def]
        turn = real(conversation_id)
        if turn is None:
            return None
        steps = [dict(item) for item in turn.steps]
        steps[0].pop("args", None)
        return LastTurn(
            question=turn.question,
            answer_id=turn.answer_id,
            answer=turn.answer,
            sources=turn.sources,
            steps=steps,
            thinking=turn.thinking,
        )

    monkeypatch.setattr(services.conversations, "last_turn", without_args)
    response = _retry(client, failed_step)
    assert response.status_code == 422
    assert "入参没有存下来" in response.json()["message"]


def test_a_step_that_is_waiting_for_the_user_is_422(
    client: TestClient, failed_step: dict, monkeypatch
) -> None:  # type: ignore[type-arg,no-untyped-def]
    """还在等确认的那一步不能重试：先回答那条确认（两条路同时进行会互相打架）。"""
    from app.services.conversation import LastTurn

    services = get_services()
    real = services.conversations.last_turn

    def awaiting(conversation_id: str):  # type: ignore[no-untyped-def]
        turn = real(conversation_id)
        if turn is None:
            return None
        steps = [dict(item) for item in turn.steps]
        steps[0]["outcome"] = "awaiting"
        return LastTurn(
            question=turn.question,
            answer_id=turn.answer_id,
            answer=turn.answer,
            sources=turn.sources,
            steps=steps,
            thinking=turn.thinking,
        )

    monkeypatch.setattr(services.conversations, "last_turn", awaiting)
    response = _retry(client, failed_step)
    assert response.status_code == 422
    assert "还在等你的确认" in response.json()["message"]


def test_an_earlier_turn_is_422(client: TestClient) -> None:
    """只能重试**最后一轮**的那一步：重试更早的轮次会把顺序弄乱（后面那轮已经接过去了）。"""
    services = get_services()
    kb_id = client.post("/api/v1/knowledge-bases", json={"name": "两轮库"}).json()["id"]
    conversation_id = client.post(
        "/api/v1/conversations", json={"title": "两轮", "kb_ids": [kb_id]}
    ).json()["id"]
    install_fake_chat("第一轮的回答。[1]")
    _install_fake_sources()
    assert (
        client.post(
            "/api/v1/chat/stream",
            json={"query": "第一问", "conversation_id": conversation_id, "kb_ids": [kb_id]},
        ).status_code
        == 200
    )
    first_answer = services.conversations.messages(conversation_id)[-1]
    assert (
        client.post(
            "/api/v1/chat/stream",
            json={"query": "第二问", "conversation_id": conversation_id, "kb_ids": [kb_id]},
        ).status_code
        == 200
    )

    response = _retry(
        client,
        {"conversation_id": conversation_id, "message_id": first_answer.id},
    )
    assert response.status_code == 422
    assert "只能重试最后一轮" in response.json()["message"]


def test_an_unknown_message_is_404(client: TestClient, failed_step: dict) -> None:  # type: ignore[type-arg]
    response = _retry(
        client,
        {"conversation_id": failed_step["conversation_id"], "message_id": "msg_missing"},
    )
    assert response.status_code == 404


def test_an_unknown_conversation_is_404(client: TestClient) -> None:
    response = client.post(
        "/api/v1/conversations/conv_missing/messages/msg_x/steps/0/retry", json={}
    )
    assert response.status_code == 404


def test_another_members_message_is_404(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """别人的会话 / 别人的消息一律 404（不暴露"它在别处存在"）。"""
    from app.core.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    with TestClient(create_app()) as client:
        admin = client.post(
            "/api/v1/auth/setup", json={"username": "admin", "password": ADMIN_PASSWORD}
        ).json()
        services = get_services()
        services.auth._stores.meta.create_user(
            UserRecord(
                id="user_member",
                name="成员",
                username="member",
                password_hash=hash_password(MEMBER_PASSWORD),
                role=UserRole.MEMBER,
            )
        )
        member = client.post(
            "/api/v1/auth/login", json={"username": "member", "password": MEMBER_PASSWORD}
        ).json()
        admin_headers = {"Authorization": f"Bearer {admin['token']}"}
        member_headers = {"Authorization": f"Bearer {member['token']}"}

        kb_id = client.post(
            "/api/v1/knowledge-bases", json={"name": "别人的库"}, headers=admin_headers
        ).json()["id"]
        conversation_id = client.post(
            "/api/v1/conversations",
            json={"title": "别人的会话", "kb_ids": [kb_id]},
            headers=admin_headers,
        ).json()["id"]
        install_fake_chat("这是回答。[1]")
        _install_fake_sources()
        assert (
            client.post(
                "/api/v1/chat/stream",
                json={"query": "问", "conversation_id": conversation_id, "kb_ids": [kb_id]},
                headers=admin_headers,
            ).status_code
            == 200
        )
        answer = services.conversations.messages(conversation_id)[-1]

        response = client.post(
            f"/api/v1/conversations/{conversation_id}/messages/{answer.id}/steps/0/retry",
            json={},
            headers=member_headers,
        )
        assert response.status_code == 404, "越权不能暴露这条会话/消息的存在"
    get_settings.cache_clear()
