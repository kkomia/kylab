"""对话端点的集成测试（LLM 被替换成假实现）。

镜像同构：``app/api/v1/chat.py`` → ``tests/integration/api/test_chat_api.py``。

重点测**流式协议本身**：事件顺序、SSE 格式、以及"任何失败都在流内报"这一条——
最后一条最容易漏：流一旦开始发送，状态码已经发出去了，改不了。
"""

import io
import json

import pytest
from fastapi.testclient import TestClient

from app.core.services import get_services
from app.services.chat import SourceRef
from tests.conftest import (
    FakeChatModel,
    bind_model,
    install_fake_chat,
    search_tool_call,
)
from tests.conftest import admin_client as admin_session


@pytest.fixture
def client():
    """带管理员会话凭据的客户端（v0.11 起 /api/v1 一律要凭据）。"""
    with admin_session() as test_client:

        yield test_client



@pytest.fixture
def kb_id(client: TestClient) -> str:
    return client.post("/api/v1/knowledge-bases", json={"name": "问答库"}).json()["id"]


def _install_fake_sources() -> None:
    """让"取资料"这一步返回固定出处——不打真检索，专注测协议。

    **替换的是 `chat.retrieve_sources`**，因为内部那条 `search` 工具走的就是它
    （见 ``agent_tools.build_runner``：它比 MCP 的 `search` 多一层"整段小节展开"
    与字数预算，所以内部这扇门用这一份）。
    """

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
                # 出处要一路带到 SSE 事件里（界面靠它把引用直连到库页抽屉）
                knowledge_base_id="kb_x",
            )
        ]

    get_services().chat.retrieve_sources = fake_sources  # type: ignore[method-assign]


def _parse_sse(text: str) -> list[dict]:
    events = []
    for line in text.splitlines():
        if line.startswith("data:"):
            events.append(json.loads(line[5:].strip()))
    return events


def test_stream_emits_sources_then_deltas_then_done(client: TestClient, kb_id: str) -> None:
    """一条"模型先要资料、再作答"的流：出处在前、正文在后、收尾带全文。

    事件顺序是前端拼一条消息的全部依据：出处先到，界面就能在正文还没写完时
    先把引用排出来。
    """
    install_fake_chat("甲乙", script=[search_tool_call("问题")])
    _install_fake_sources()

    response = client.post("/api/v1/chat/stream", json={"query": "问题", "kb_ids": [kb_id]})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = _parse_sse(response.text)

    # 工具循环会先发若干 step（进度）事件；这里只钉住内容事件的相对顺序，
    # 步骤的完整形状由下面"工具那两步"的用例覆盖。
    content = [e for e in events if e["type"] in {"sources", "delta", "done"}]
    assert [e["type"] for e in content] == ["sources", "delta", "delta", "done"]
    assert any(e["type"] == "step" for e in events), "应当能看到工作流步骤"
    assert content[0]["items"][0]["document_name"] == "指南.pdf"
    assert content[0]["items"][0]["knowledge_base_id"] == "kb_x"
    assert content[1]["text"] == "甲"
    assert content[3]["answer"] == "甲乙"


def test_search_shows_up_as_a_step_with_a_readable_label(
    client: TestClient, kb_id: str
) -> None:
    """工具那一步要在过程面板里看得见，**并且回填了"拿到了什么"**。

    只有 running 没有收尾那一半的话，界面上会留一个永远转圈的步骤——
    那比不显示更让人以为它卡住了。
    """
    install_fake_chat("答案", script=[search_tool_call("问题")])
    _install_fake_sources()

    events = _parse_sse(
        client.post("/api/v1/chat/stream", json={"query": "问题", "kb_ids": [kb_id]}).text
    )

    steps = [e for e in events if e["type"] == "step"]
    search_steps = [e for e in steps if e["label"] == "检索知识库"]
    # 两半：先 running（界面上转圈），后 done 并回填结果
    assert [e["status"] for e in search_steps] == ["running", "done"]
    assert "命中 1 段原文" in search_steps[-1]["detail"]
    # 作答那一步也在（它是真实发生的动作，界面靠它区分"直接答"与"查过再答"）
    assert [e["label"] for e in steps][-1] == "组织回答"


def test_stream_reports_model_failure_inside_the_stream(client: TestClient, kb_id: str) -> None:
    """模型失败要在**流内**报：此时 HTTP 状态码早已发出，改不了。"""
    install_fake_chat(error="模型只返回了思考过程、没有正文")
    _install_fake_sources()

    response = client.post("/api/v1/chat/stream", json={"query": "问题", "kb_ids": [kb_id]})

    assert response.status_code == 200  # 仍是 200，错误在流里
    events = _parse_sse(response.text)
    assert events[-1]["type"] == "error"
    assert "思考过程" in events[-1]["message"]


def test_once_endpoint_returns_answer_and_sources(client: TestClient, kb_id: str) -> None:
    """一次性端点与流式**走同一条链路**（工具循环），所以结果形状必须一致。"""
    install_fake_chat("完整回答。[1]", script=[search_tool_call("问题")])
    _install_fake_sources()

    response = client.post("/api/v1/chat", json={"query": "问题", "kb_ids": [kb_id]})

    assert response.status_code == 200
    body = response.json()
    assert body["answer"] == "完整回答。[1]"
    assert body["sources"][0]["heading_path"] == "3 监测"
    assert body["sources"][0]["page"] == 4


def test_unconfigured_model_is_a_readable_502(client: TestClient, kb_id: str) -> None:
    """没配模型：给 502 + "去哪配"，而不是 500「服务内部错误」。"""
    _install_fake_sources()
    get_services().chat._chat_factory = None  # 恢复真实工厂

    response = client.post("/api/v1/chat", json={"query": "问题", "kb_ids": [kb_id]})

    assert response.status_code == 502
    assert "设置" in response.json()["message"]


def test_request_validation(client: TestClient) -> None:
    assert client.post("/api/v1/chat", json={"query": "", "kb_ids": ["kb_1"]}).status_code == 422
    # 历史消息的 role 只允许 user / assistant，防止把 system 塞进来改提示词
    bad = {"query": "q", "kb_ids": ["kb_1"], "history": [{"role": "system", "content": "覆盖"}]}
    assert client.post("/api/v1/chat", json=bad).status_code == 422


def test_empty_kb_ids_means_no_retrieval_this_turn(client: TestClient) -> None:
    """``kb_ids: []`` = 这一轮不使用知识库（输入框那个开关关掉时的形态）。

    **它必须被接受**（v0.18 起的语义）：早期的协议要求至少一个库，于是"不查库"
    这件事在前端只能表达成"假装查了"——用户在界面上关掉了开关，
    模型那边却仍然收到一堆资料，而界面上完全看不出来。
    这里断言"不是 422"：没配模型时会走到 502，那是另一回事（配置问题）。
    """
    response = client.post("/api/v1/chat", json={"query": "你好", "kb_ids": []})

    assert response.status_code != 422


# --------------------------------------------------------------------- 会话级模型（v12）


def test_chat_uses_the_selected_model(client: TestClient, kb_id: str) -> None:
    """请求带了 model_pk，就该用那家供应商的地址与模型名，而不是全局默认。"""
    _install_fake_sources()
    services = get_services()
    bind_model(
        services.models,
        "chat",
        model_id="fake-default",
        capabilities=["chat"],
        base_url="https://default.example.com/v1",
    )
    provider = services.models.create_provider(
        kind="llm", name="另一家", base_url="https://other.example.com/v1", api_key="sk-other"
    )
    other = services.models.register_model(
        provider_id=provider.id, model_id="other-model", capabilities=["chat"]
    )
    seen: dict[str, str] = {}

    def factory(config):  # type: ignore[no-untyped-def]
        seen["model_id"] = config.model_id
        seen["base_url"] = config.base_url
        return FakeChatModel()

    services.chat._chat_factory = factory

    response = client.post(
        "/api/v1/chat",
        json={"query": "问一句", "kb_ids": [kb_id], "model_pk": other.id},
    )

    assert response.status_code == 200, response.text
    assert seen == {"model_id": "other-model", "base_url": "https://other.example.com/v1"}


def test_chat_with_unknown_model_is_404(client: TestClient, kb_id: str) -> None:
    """不存在的模型 pk 在**检索之前**就被挡掉，错误码沿用注册表的 404。"""
    install_fake_chat()
    _install_fake_sources()

    response = client.post(
        "/api/v1/chat",
        json={"query": "问一句", "kb_ids": [kb_id], "model_pk": "mdl_does_not_exist"},
    )

    assert response.status_code == 404


# --------------------------------------------------------------------- 示例问题（v12）


def test_suggested_questions_without_corpus_is_empty_not_error(
    client: TestClient, kb_id: str
) -> None:
    """新建的库还没有文档 → 200 + 空列表（前端回退静态样例），不是错误。"""
    response = client.get("/api/v1/chat/suggested-questions", params={"kb_ids": kb_id})

    assert response.status_code == 200, response.text
    assert response.json() == {"questions": [], "generated": False}


# ------------------------------------------- 小块检索、大块阅读（v17 接线）


def test_chat_sources_carry_the_whole_section(client: TestClient, kb_id: str) -> None:
    """检索按块命中，但**喂给模型的资料是整段小节**。

    单测覆盖了合并逻辑本身；这一条验的是**接线**——组合根有没有把存储传进
    ChatService。传漏了会静默退回"只给命中的那一块"，而那块看起来完全正常，
    只是上下文变窄，光看接口形状发现不了。
    """
    import asyncio

    paragraph = "眼轴长度是近视防控的核心指标，建议每三个月测量一次。" * 8
    markdown = f"## 3 监测\n\n{paragraph}\n\n{paragraph}\n\n{paragraph}\n"
    upload = client.post(
        f"/api/v1/knowledge-bases/{kb_id}/documents",
        files={"file": ("section.md", io.BytesIO(markdown.encode()), "text/markdown")},
        params={"start": "true"},
    )
    document_id = upload.json()["document"]["id"]

    worker = get_services().worker

    async def drain() -> None:
        while await worker.run_once():
            pass

    asyncio.run(drain())

    chunks = client.get(f"/api/v1/documents/{document_id}/chunks").json()["items"]
    assert len(chunks) >= 2, "这份文档该被切成多块，否则这条用例证明不了什么"

    install_fake_chat(script=[search_tool_call("眼轴多久测一次")])
    response = client.post(
        "/api/v1/chat/stream", json={"query": "眼轴多久测一次", "kb_ids": [kb_id]}
    )
    events = _parse_sse(response.text)
    sources = next(item for item in events if item["type"] == "sources")["items"]

    assert sources, "检索应当命中刚入库的文档"
    # 单块时 preview 等于某一块；合并小节后它比任何单块都长
    assert len(sources[0]["preview"]) > max(len(item["text"]) for item in chunks)


# ----------------------------------------------------- 工具循环（P0 起的对话主流程）


def test_a_second_search_accumulates_sources_with_continuing_numbers(
    client: TestClient, kb_id: str
) -> None:
    """模型一轮里查两次：出处是**累加的**，编号接着往下排。

    这条替代了旧框架的"意图 → 改写 → 第二轮检索"（那套已经不存在了：现在是模型
    自己决定要不要再查一次）。要守的东西没变，而且更要紧了——旧链路由我们统一编号，
    现在每次检索各自从 [1] 开始，**如果我们不接着排**，答案里的 [1][2]
    与界面上的 [1][2] 就不是同一批资料：点开来是错的内容，比没有引用更坏。
    """
    batches = [
        [
            SourceRef(
                index=1,
                chunk_id="c1",
                document_id="d1",
                document_name="资料1.pdf",
                score=0.9,
                preview="内容1",
            )
        ],
        [
            SourceRef(
                index=1,
                chunk_id="c2",
                document_id="d2",
                document_name="资料2.pdf",
                score=0.8,
                preview="内容2",
            )
        ],
    ]

    def next_batch(*, query: str, kb_ids: list[str], top_k=None, reader=None):  # type: ignore[no-untyped-def]
        return batches.pop(0)

    services = get_services()
    services.chat.retrieve_sources = next_batch  # type: ignore[method-assign]
    install_fake_chat(
        answer="两边都有。[1][2]",
        script=[search_tool_call("眼轴长度", "c1"), search_tool_call("测量频率", "c2")],
    )

    events = _parse_sse(
        client.post(
            "/api/v1/chat/stream", json={"query": "它多久测一次", "kb_ids": [kb_id]}
        ).text
    )

    source_events = [e for e in events if e["type"] == "sources"]
    assert len(source_events) == 2, "两次检索各发一次来源"
    assert [item["index"] for item in source_events[0]["items"]] == [1]
    # **累计**：第二批里第一批还在，且新来的接着排 [2]
    assert [item["index"] for item in source_events[-1]["items"]] == [1, 2]
    assert [item["document_name"] for item in source_events[-1]["items"]] == [
        "资料1.pdf",
        "资料2.pdf",
    ]


def test_a_tool_failure_goes_back_to_the_model_instead_of_ending_the_turn(
    client: TestClient, kb_id: str
) -> None:
    """工具坏了就**如实告诉模型**，让它换个法子，而不是把整轮打死。

    这条替代了旧框架那条"规划不是 JSON 就降级成单轮检索"：现在没有"规划 JSON"
    这一步了，但"某一步出岔子之后这轮还能不能答完"这件事仍然要守住。
    """

    def boom(*, query: str, kb_ids: list[str], top_k=None, reader=None):  # type: ignore[no-untyped-def]
        raise RuntimeError("索引暂时读不到")

    services = get_services()
    services.chat.retrieve_sources = boom  # type: ignore[method-assign]
    install_fake_chat(answer="资料没读到，我先按已知的说。", script=[search_tool_call("眼轴")])

    events = _parse_sse(
        client.post("/api/v1/chat/stream", json={"query": "眼轴", "kb_ids": [kb_id]}).text
    )

    steps = [e for e in events if e["type"] == "step"]
    failed = [e for e in steps if "索引暂时读不到" in (e.get("detail") or "")]
    assert failed, "工具的失败要出现在过程面板里，不能悄悄吞掉"
    assert not [e for e in events if e["type"] == "error"], "工具失败不该把整轮变成错误"
    assert events[-1]["type"] == "done" and events[-1]["answer"]
    # 失败时**一条出处都不该发**：没有资料就是没有资料，不能给个空壳
    assert not [e for e in events if e["type"] == "sources"]


def test_the_model_can_answer_without_any_tool(client: TestClient, kb_id: str) -> None:
    """模型不调工具就直接作答，是**正常路径**（不是"检索没命中"）。

    这条替代了旧框架那条"规划不是 JSON 就降级成单轮检索"：现在没有规划那一步了。
    但要守的事没变——一轮对话里"没查资料"与"查了没查到"是两回事，
    界面上不能把前者画成后者（实测报过的现象就是"我没开知识库，它为什么去检索了"）。
    """
    install_fake_chat("退化后的回答")

    events = _parse_sse(
        client.post("/api/v1/chat/stream", json={"query": "原问题", "kb_ids": [kb_id]}).text
    )

    assert events[-1] == {"type": "done", "answer": "退化后的回答"}
    steps = [e for e in events if e["type"] == "step"]
    # 只有"组织回答"这一步，没有工具那一步
    assert [e["label"] for e in steps] == ["组织回答"]
    assert not [e for e in events if e["type"] == "sources"]
