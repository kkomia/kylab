"""续跑端点的集成测试（LLM 被替换成假实现）。

镜像同构：``app/api/v1/chat.py`` 的 ``resume_turn`` / ``_resume_events`` → 本文件。

要钉住的是**续跑与重发的区别**，也就是这件事为什么值得单独做一条路：

1. 提问**不重复落库**（还在原地），答案**被顶替**（同一个问题底下不会挂两条回答）；
2. 过程快照**接得上**（上一轮那些步骤 + 一条"继续"标记 + 这一轮新的），
   否则回看时用户会以为"它一步都没查就答了"；
3. 上一轮的出处**接进这一轮的账本**，编号与交给模型的交接说明一致；
4. 不能续的时候**报 422 且什么都不动**（契约：要么能续、要么说清）。
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.core.services import get_services
from app.services.chat import SourceRef
from tests.conftest import (
    admin_client as admin_session,
)
from tests.conftest import (
    install_fake_chat,
    search_tool_call,
)


@pytest.fixture
def client():
    with admin_session() as test_client:
        yield test_client


def _parse_sse(text: str) -> list[dict]:  # type: ignore[type-arg]
    return [json.loads(line[5:].strip()) for line in text.splitlines() if line.startswith("data:")]


def _install_fake_sources() -> None:
    """让检索返回固定的一段出处（与 ``test_chat_api`` 同一套做法）。"""

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


@pytest.fixture
def degraded(client: TestClient) -> str:
    """一个**真的降级过**的会话：把工具循环的步数上限压到 1，模型又要工具。

    刻意走真实链路（而不是手写一条带 `degraded` 的消息塞进库）：
    "降级标记会落库"本身也是 v0.32 一起修的（它原来只发给流，
    刷新一次页面提示就没了），用真实链路才顺带把它钉住。
    """
    from app.api.v1 import chat as chat_api

    # **会话要带库范围**：不带的话 `search` 会拒绝（"这一轮没有可查的知识库"），
    # 于是这个夹具就没有出处可接——而"接上出处"正是续跑要做的事之一
    kb_id = client.post("/api/v1/knowledge-bases", json={"name": "续跑库"}).json()["id"]
    conversation_id = client.post(
        "/api/v1/conversations", json={"title": "续跑", "kb_ids": [kb_id]}
    ).json()["id"]
    real_loop = chat_api._agent_loop

    def shoestring(*args: object, **kwargs: object):  # type: ignore[no-untyped-def]
        # **两步**：第一步真的检索（这样上一轮有出处可接），第二步撞上限降级。
        # 一步的话工具压根不会执行，夹具就"没有材料可续"，测不出接出处这件事
        kwargs["max_steps"] = 2
        return real_loop(*args, **kwargs)

    chat_api._agent_loop = shoestring  # type: ignore[assignment]
    try:
        install_fake_chat(
            "眼轴是主要参数[1]",
            script=[search_tool_call("眼轴"), search_tool_call("眼轴 监测")],
        )
        _install_fake_sources()
        response = client.post(
            "/api/v1/chat/stream",
            json={
                "query": "眼轴怎么监测",
                "conversation_id": conversation_id,
                "kb_ids": [kb_id],
            },
        )
        assert response.status_code == 200
        # 先确认它真的降级了（否则下面的用例测的是别的东西）
        assert any(
            event.get("degraded") for event in _parse_sse(response.text) if event["type"] == "step"
        )
    finally:
        chat_api._agent_loop = real_loop  # type: ignore[assignment]
    return conversation_id


def test_degraded_marker_survives_a_reload(client: TestClient, degraded: str) -> None:
    """降级标记要**落库**：刷新页面（重新 GET 会话）之后「继续」还得在。

    这条是 v0.32 修的 bug：标记原来只发给流，回看一条旧回答时"它是在材料不够的
    情况下答的"这件事就查不到了。
    """
    detail = client.get(f"/api/v1/conversations/{degraded}").json()
    steps = [step for message in detail["messages"] for step in message["steps"]]
    assert any(step.get("degraded") for step in steps), steps


def test_resume_continues_the_same_turn(client: TestClient, degraded: str) -> None:
    """续跑：提问还在原地、答案被顶替、过程接得上、出处接上了。"""
    services = get_services()
    before = services.conversations.messages(degraded)
    assert [message.role for message in before] == ["user", "assistant"]

    # 这一轮不调工具，直接收尾（"材料够了就别再查"——正是续跑要鼓励的行为）
    install_fake_chat("眼轴是主要参数[1]，建议每 3 个月测一次。")
    _install_fake_sources()

    response = client.post(f"/api/v1/conversations/{degraded}/resume", json={"skill_names": []})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = _parse_sse(response.text)
    # 正文是按增量吐的（假模型一个字一个 delta）：只钉"最后一个是 done，且它的全文是完整的"
    assert events[-1]["type"] == "done"
    assert all(e["type"] == "delta" for e in events[:-1] if e["type"] in {"delta", "done"})
    assert events[-1]["answer"].endswith("建议每 3 个月测一次。")

    after = services.conversations.messages(degraded)
    # **还是一条提问一条回答**：续跑是接着做，不是再问一次
    assert [message.role for message in after] == ["user", "assistant"]
    assert after[0].id == before[0].id, "提问不该被删掉或重建"
    assert after[1].id != before[1].id, "没做完的那条回答要被顶替"

    labels = [str(step.get("label")) for step in after[1].steps]
    # 上一轮那些步骤还在（回看时才读得通"它查过了，只是上半场"）
    assert "检索知识库" in labels
    assert "继续上一轮" in labels, labels
    # 出处接上了：上一轮那条「指南.pdf」仍在这一轮的回答里
    assert [item["document_name"] for item in after[1].sources] == ["指南.pdf"]


def test_resume_prompt_carries_the_handover_note(client: TestClient, degraded: str) -> None:
    """交给模型的那句话里有交接说明：问的是什么、别再重复查、材料编号沿用。"""
    captured: list[str] = []
    services = get_services()
    real_messages = services.chat.agent_messages

    def spy(**kwargs: object):  # type: ignore[no-untyped-def]
        captured.append(str(kwargs["query"]))
        return real_messages(**kwargs)  # type: ignore[arg-type]

    services.chat.agent_messages = spy  # type: ignore[method-assign]
    try:
        install_fake_chat("答")
        _install_fake_sources()
        response = client.post(f"/api/v1/conversations/{degraded}/resume", json={})
        assert response.status_code == 200
    finally:
        services.chat.agent_messages = real_messages  # type: ignore[method-assign]

    query = captured[0]
    assert "眼轴怎么监测" in query, "原来的提问要带上"
    assert "接着上一次继续做" in query
    assert "不要重复做" in query
    # 上一轮那句半截回答也一并交给它（否则它会从头再写一遍）
    assert "眼轴是主要参数[1]" in query
    # 材料带着编号（账本已经把那些出处接上了，两边必须是同一套号）
    assert "[1] 指南.pdf" in query


def test_resume_budget_is_raised(client: TestClient, degraded: str) -> None:
    """续跑要**多给一点预算**：不多给，它一进去就又撞上限（那就白点了）。

    "多给多少"由 `services/resume.py` 的常量定（那三个数各有理由，见那里的说明）；
    这里只钉"确实抬高了"。
    """
    from app.services.resume import RESUME_EXTRA_SECONDS, RESUME_EXTRA_STEPS
    from app.services.tool_loop import DEFAULT_MAX_SECONDS, DEFAULT_MAX_STEPS

    seen: dict[str, object] = {}
    services = get_services()
    real_loop = services.chat.tool_loop

    def spy(**kwargs: object):  # type: ignore[no-untyped-def]
        seen.update(kwargs)
        return real_loop(**kwargs)  # type: ignore[arg-type]

    services.chat.tool_loop = spy  # type: ignore[method-assign]
    try:
        install_fake_chat("答")
        _install_fake_sources()
        assert client.post(f"/api/v1/conversations/{degraded}/resume", json={}).status_code == 200
    finally:
        services.chat.tool_loop = real_loop  # type: ignore[method-assign]

    assert seen["max_steps"] == DEFAULT_MAX_STEPS + RESUME_EXTRA_STEPS
    assert seen["max_seconds"] == DEFAULT_MAX_SECONDS + RESUME_EXTRA_SECONDS


def test_resume_on_a_finished_turn_is_422_and_changes_nothing(client: TestClient) -> None:
    """正常跑完的一轮**不能续**：报 422，而且什么都不动（不能把好答案删了）。"""
    conversation_id = client.post("/api/v1/conversations", json={"title": "正常"}).json()["id"]
    install_fake_chat("这是回答。")
    _install_fake_sources()
    assert (
        client.post(
            "/api/v1/chat/stream",
            json={"query": "问题", "conversation_id": conversation_id},
        ).status_code
        == 200
    )
    services = get_services()
    before = services.conversations.messages(conversation_id)
    assert len(before) == 2

    response = client.post(f"/api/v1/conversations/{conversation_id}/resume", json={})

    assert response.status_code == 422
    assert "没有可续的地方" in response.json()["message"]
    assert [message.id for message in services.conversations.messages(conversation_id)] == [
        message.id for message in before
    ], "报错时不许动库"


def test_resume_without_any_turn_is_422(client: TestClient) -> None:
    """空会话：同样是 422（契约只有两条：能续，或说清为什么不能）。"""
    conversation_id = client.post("/api/v1/conversations", json={"title": "空"}).json()["id"]
    response = client.post(f"/api/v1/conversations/{conversation_id}/resume", json={})
    assert response.status_code == 422
    assert "没有可续的回答" in response.json()["message"]


def test_resume_of_an_unknown_conversation_is_404(client: TestClient) -> None:
    response = client.post("/api/v1/conversations/conv_missing/resume", json={})
    assert response.status_code == 404
