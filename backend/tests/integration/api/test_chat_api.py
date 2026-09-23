"""对话端点的集成测试（LLM 被替换成假实现）。

镜像同构：``app/api/v1/chat.py`` → ``tests/integration/api/test_chat_api.py``。

重点测**流式协议本身**：事件顺序、SSE 格式、以及"任何失败都在流内报"这一条——
最后一条最容易漏：流一旦开始发送，状态码已经发出去了，改不了。
"""

import io
import itertools
import json
import time

import pytest
from fastapi.testclient import TestClient

from app.core.services import get_services
from app.services.chat import SourceRef
from app.services.session_events import SessionEvent, steps_from_events
from app.services.tool_loop import MARKER_STEP_LABEL
from tests.conftest import (
    FakeChatModel,
    LLMReply,
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


# ------------------------------------------------------- 会话事件日志（P0-2）


def _events(client: TestClient, conversation_id: str, query: str = "") -> list[dict]:
    """读这条会话的事件日志（``?kinds=`` 直接拼在 ``query`` 里）。"""
    response = client.get(f"/api/v1/conversations/{conversation_id}/events{query}")
    assert response.status_code == 200, response.text
    return response.json()["items"]


def _conversation(client: TestClient) -> str:
    return client.post("/api/v1/conversations", json={}).json()["id"]


def test_a_turn_leaves_a_complete_contiguous_event_log(client: TestClient, kb_id: str) -> None:
    """一轮正常问答之后：事件齐全、``seq`` 连续、``turn/start`` 在前、``turn/end`` 在最后。

    这是对"会话 = 只追加事件日志"最直白的一条验收（P0-2 第 6 条）：
    顺序与编号是回放、续跑、压缩全都依赖的东西，错一处就往后再错一片。
    """
    install_fake_chat("甲乙", script=[search_tool_call("问题")])
    _install_fake_sources()
    conversation_id = _conversation(client)

    client.post(
        "/api/v1/chat/stream",
        json={"query": "问题", "kb_ids": [kb_id], "conversation_id": conversation_id},
    )

    events = _events(client, conversation_id)
    kinds = [item["kind"] for item in events]
    assert kinds[0] == "turn/start", "第一件事必须是「这一轮要做什么」"
    assert kinds[-1] == "turn/end", "最后一件事必须是这一轮怎么结束的"
    # 工具调用两条（running 是「开始」、done 带结果）+ 组织回答那一步
    assert kinds.count("tool_call") == 2
    assert kinds.count("step") == 1
    # seq 连续：从 1 开始、逐个加一（P0-2 的"只追加"在编号上的样子）
    assert [item["seq"] for item in events] == list(range(1, len(events) + 1))
    assert events[0]["payload"]["query"] == "问题"
    assert events[-1]["payload"] == {"status": "ok", "answer_chars": 2, "steps": 2}


def test_the_steps_snapshot_is_the_projection_of_the_event_log(
    client: TestClient, kb_id: str
) -> None:
    """**P0-2 的核心验收**：从事件重建的步骤快照 == ``chat_messages.steps``。

    两者不是"应该一致"，而是**同一次投影**：写侧与读侧共用
    ``agent.step_snapshot`` 那一份映射（见 ``services/session_events``）。
    这条用例把它钉在真库上——只跑单元测试的话，"事件真的是按那份形状写进去的"
    仍然只是假设。
    """
    install_fake_chat("甲乙", script=[search_tool_call("问题")])
    _install_fake_sources()
    conversation_id = _conversation(client)

    client.post(
        "/api/v1/chat/stream",
        json={"query": "问题", "kb_ids": [kb_id], "conversation_id": conversation_id},
    )

    detail = client.get(f"/api/v1/conversations/{conversation_id}").json()
    stored_steps = detail["messages"][-1]["steps"]
    assert stored_steps, "这一轮调过工具，快照里必须有内容（否则这条用例测了个空）"

    events = _events(client, conversation_id)
    rebuilt = steps_from_events(
        [
            SessionEvent(
                id=item["id"],
                seq=item["seq"],
                kind=item["kind"],
                payload=item["payload"],
                created_at=None,
            )
            for item in events
        ]
    )
    assert rebuilt == stored_steps


def test_events_can_be_filtered_by_kind(client: TestClient, kb_id: str) -> None:
    """``?kinds=`` 只返回那几种；**拼错的 kind 报 422**（不静默返回空列表）。

    静默返回空会让调用方以为"这条会话没有这类事件"——而真正的原因是自己拼错了，
    这个端点是给人读日志、给脚本筛"只看中断"用的，说清楚比宽容有用。
    """
    install_fake_chat("答案", script=[search_tool_call("问题")])
    _install_fake_sources()
    conversation_id = _conversation(client)
    client.post(
        "/api/v1/chat/stream",
        json={"query": "问题", "kb_ids": [kb_id], "conversation_id": conversation_id},
    )

    only = _events(client, conversation_id, "?kinds=turn/start,turn/end")
    assert [item["kind"] for item in only] == ["turn/start", "turn/end"]
    # 过滤不改变编号：seq 还是它们在整份日志里的位置（首尾两条）
    everything = _events(client, conversation_id)
    assert [item["seq"] for item in only] == [everything[0]["seq"], everything[-1]["seq"]]

    bad = client.get(f"/api/v1/conversations/{conversation_id}/events?kinds=nope")
    assert bad.status_code == 422
    assert "nope" in bad.json()["message"]


def test_stopping_mid_stream_records_what_had_no_result(
    client: TestClient, kb_id: str
) -> None:
    """一轮没跑完就被放弃：补一条 ``interrupted``，并说清**哪些调用没有结果**。

    抄的是 QwenPaw 那条教训（调研报告 §2.1：中断时给未完成的调用补结果，
    否则下一轮消息不成对）。我们不存在 tool 消息配对问题，但"停在了半截的哪一步"
    仍然必须留下来——否则回看时会以为那一轮什么都没做。

    **这条例的是生成器那一层的收尾**：close 掉那个生成器 = "这一轮被放弃"在
    服务端的形状。P2-2 之后带会话的那条路**不再因为客户端断开就 close 它**
    （那一轮跑在后台任务里，断开只是少一个订阅者，见
    ``tests/integration/api/test_chat_live.py``），但这条收尾仍然在：
    不带会话的调用照旧跟着连接走，后台任务遇到意外时也要靠它补上最后一笔。
    """
    from app.api.v1 import chat as chat_api
    from app.api.v1.schemas import ChatRequestIn
    from app.services.api_key import Caller

    install_fake_chat("甲", script=[search_tool_call("问题")])
    _install_fake_sources()
    conversation_id = _conversation(client)

    payload = ChatRequestIn(query="问题", kb_ids=[kb_id], conversation_id=conversation_id)
    stream = chat_api._events(get_services(), payload, None, None, None, Caller(is_admin=True))
    first = next(stream)
    assert first.payload["type"] == "step", "先让流真的开始发（这时工具调用已经发出去了）"
    stream.close()  # 这一轮被放弃（v0.41 之前：客户端断开就是这个形状）

    events = _events(client, conversation_id)
    assert [item["kind"] for item in events] == ["turn/start", "tool_call", "interrupted"]
    interrupted = events[-1]["payload"]
    assert interrupted["unpaired"] == [{"tool": "search", "label": "检索知识库"}]
    # 半截的回答不留消息（与"失败的一轮不留半截记录"同一口径），但日志留下来了
    assert client.get(f"/api/v1/conversations/{conversation_id}").json()["messages"] == []

    # 还能接着问下一轮：编号从上次的 max 继续，不会重号
    install_fake_chat("答案")
    client.post(
        "/api/v1/chat/stream",
        json={"query": "再问", "kb_ids": [kb_id], "conversation_id": conversation_id},
    )
    after = _events(client, conversation_id)
    assert [item["seq"] for item in after] == list(range(1, len(after) + 1))
    assert [item["kind"] for item in after][3:] == ["turn/start", "step", "turn/end"]


def test_events_of_someone_elses_conversation_are_404() -> None:
    """成员的会话守卫与既有的会话端点**同一套**（越主 404，不暴露存在性）。

    单独造一个成员的客户端：这个端点是"按会话读"，漏一次归属判定就等于
    把别人的整段过程（工具参数、原文、思考）摊开。
    """
    from app.core.config import get_settings
    from app.core.security import hash_password
    from app.main import create_app
    from app.models.enums import UserRole
    from app.storage.base import UserRecord
    from tests.conftest import login_admin

    get_settings.cache_clear()
    with TestClient(create_app()) as client:
        # 走产品上真实的那条路（setup/登录），令牌进 client.headers
        login_admin(client)
        client.post("/api/v1/knowledge-bases", json={"name": "库"})
        conversation_id = _conversation(client)
        get_services().auth._stores.meta.create_user(
            UserRecord(
                id="user_member",
                name="成员",
                username="member",
                password_hash=hash_password("member pass 123"),
                role=UserRole.MEMBER,
            )
        )
        member = client.post(
            "/api/v1/auth/login", json={"username": "member", "password": "member pass 123"}
        ).json()

        response = client.get(
            f"/api/v1/conversations/{conversation_id}/events",
            headers={"Authorization": f"Bearer {member['token']}"},
        )
        assert response.status_code == 404
    get_settings.cache_clear()


def test_a_failed_turn_is_recorded_as_error_and_turn_end(client: TestClient, kb_id: str) -> None:
    """流里失败的那一轮：**不留消息，但要留日志**（``error`` + ``turn/end``）。

    按 v0.12 起的取舍，失败的一轮不写半截记录（"问了但没答"的空档最难解释）。
    可"当时为什么没答出来"恰恰是回看时要问的——这句话只有日志答得出来。
    """
    install_fake_chat(error="模型暂时不可用")
    conversation_id = _conversation(client)

    response = client.post(
        "/api/v1/chat/stream",
        json={"query": "问题", "kb_ids": [kb_id], "conversation_id": conversation_id},
    )
    events = _parse_sse(response.text)
    assert events[-1]["type"] == "error", "失败照旧在流内报（状态码已经发出去了）"

    logged = _events(client, conversation_id)
    assert [item["kind"] for item in logged] == ["turn/start", "error", "turn/end"]
    assert logged[1]["payload"]["message"] == "模型暂时不可用"
    assert logged[2]["payload"]["status"] == "error"
    # 没有回答就没有消息（与"不留半截记录"同一口径）
    assert client.get(f"/api/v1/conversations/{conversation_id}").json()["messages"] == []


def test_the_non_streaming_endpoint_records_events_too(client: TestClient, kb_id: str) -> None:
    """``/chat``（一次性）也记日志：两个端点同一条链路，过程不该一个有记录一个没有。

    这条端点的文档写着"逻辑与流式完全相同"，而 v0.43 之前它**连步骤都不落库**
    ——同一句话从两个端点问，会话里的过程面板一个有内容一个空着。
    """
    install_fake_chat("甲乙", script=[search_tool_call("问题")])
    _install_fake_sources()
    conversation_id = _conversation(client)

    assert (
        client.post(
            "/api/v1/chat",
            json={"query": "问题", "kb_ids": [kb_id], "conversation_id": conversation_id},
        ).status_code
        == 200
    )

    logged = _events(client, conversation_id)
    assert [item["kind"] for item in logged] == [
        "turn/start",
        "tool_call",
        "tool_call",
        "step",
        "turn/end",
    ]
    assert [item["seq"] for item in logged] == list(range(1, len(logged) + 1))
    # 消息里的快照也是这一份投影
    steps = client.get(f"/api/v1/conversations/{conversation_id}").json()["messages"][-1]["steps"]
    assert steps_from_events(
        [
            SessionEvent(
                id=item["id"],
                seq=item["seq"],
                kind=item["kind"],
                payload=item["payload"],
                created_at=None,
            )
            for item in logged
        ]
    ) == steps


# ----------------------------------- 正文里的工具调用标记（§12.227）

#: 模型把工具调用写进正文的那种回复（§12.219 实测的形状：正文里混着标记）。
#: 会走到这条路上的情形：收尾那两条路不带工具表（步数 / 时间用尽），
#: 以及"Agent 关掉"那条链路根本没有工具表。
MARKER_ANSWER = (
    "我还想再核一眼 NVIDIA 的文档。\n"
    '<tool_call>\n{"name": "web_search", "arguments": {"query": "NVIDIA 规格"}}\n</tool_call>'
)


def _event(items: list[dict], kind: str) -> dict:
    """流里第一条某类事件（找不到就当场炸在这条用例上，比返回 None 好读）。"""
    return next(item for item in items if item["type"] == kind)


def _ask(client: TestClient, conversation_id: str, kb_id: str, query: str) -> list[dict]:
    return _parse_sse(
        client.post(
            "/api/v1/chat/stream",
            json={"query": query, "kb_ids": [kb_id], "conversation_id": conversation_id},
        ).text
    )


def test_markup_in_the_answer_is_stripped_before_it_is_stored(
    client: TestClient, kb_id: str
) -> None:
    """**不执行、也不当回答**：那段标记既不该进库里，也不该出现在 ``done`` 里。

    这条钉的是 §12.219 §5 那条敞口（收尾那两条路不带工具表，模型只剩"写进正文"
    一条路）。此前那段标记被原样存下来、显示出来，还挂着"复制 / 存为笔记"。
    """
    install_fake_chat(MARKER_ANSWER)
    conversation_id = _conversation(client)

    events = _ask(client, conversation_id, kb_id, "NVIDIA 的规格是什么")

    # 收尾那条带的是**剥干净**的正文（人话留着）
    assert _event(events, "done")["answer"] == "我还想再核一眼 NVIDIA 的文档。"
    # 库里那份与它逐字相同——"屏幕上干净、库里脏"是这一层最要防的偏差
    stored = client.get(f"/api/v1/conversations/{conversation_id}").json()["messages"][-1]
    assert stored["content"] == "我还想再核一眼 NVIDIA 的文档。"
    # 补了一条说明：它想调什么、为什么没调成（界面据此摆出「继续 / 重试」）
    notice = next(
        item
        for item in events
        if item["type"] == "step" and item["label"] == MARKER_STEP_LABEL
    )
    assert notice["degraded"] is True
    assert "web_search" in notice["detail"]
    # 这一轮因此是**降级**的（不是正常收口）：用户得知道这次没跑完
    ends = _events(client, conversation_id, "?kinds=turn/end")
    assert ends and ends[-1]["payload"]["status"] == "degraded"


def test_a_markup_only_answer_still_leaves_a_readable_turn(
    client: TestClient, kb_id: str
) -> None:
    """整条正文都是标记时**不能交空回答**：给一句人话，而且这一轮照旧落库。

    空回答的后果是**整轮消失**（落库那条判据是"``answer`` 非空"），用户回头看会话
    连"我问过、它没答"都看不到——比看到一句"这次没有可读的回答"糟得多。
    """
    install_fake_chat('<tool_call>{"name": "search", "arguments": {}}</tool_call>')
    conversation_id = _conversation(client)

    events = _ask(client, conversation_id, kb_id, "查一下")

    answer = _event(events, "done")["answer"]
    assert "tool_call" not in answer and answer.strip(), "剥空之后要有话说，不是空气泡"
    stored = client.get(f"/api/v1/conversations/{conversation_id}").json()["messages"][-1]
    assert stored["content"] == answer


def test_the_non_streaming_endpoint_strips_it_too(client: TestClient, kb_id: str) -> None:
    """``/chat`` 那条路（脚本、MCP 走它）同样要剥——两个端点的口径必须一致。"""
    install_fake_chat(MARKER_ANSWER)
    conversation_id = _conversation(client)

    body = client.post(
        "/api/v1/chat",
        json={
            "query": "NVIDIA 的规格是什么",
            "kb_ids": [kb_id],
            "conversation_id": conversation_id,
        },
    ).json()

    assert body["answer"] == "我还想再核一眼 NVIDIA 的文档。"
    stored = client.get(f"/api/v1/conversations/{conversation_id}").json()["messages"][-1]
    assert stored["content"] == "我还想再核一眼 NVIDIA 的文档。"
    ends = _events(client, conversation_id, "?kinds=turn/end")
    assert ends[-1]["payload"]["status"] == "degraded"


def test_the_non_agent_path_strips_it_as_well(client: TestClient, kb_id: str) -> None:
    """Agent 关掉那条链路也过这一关：**它根本没有工具表**（§12.219 里"另外两例"）。

    这条链路是"检索 + 生成"，模型一开始就没有工具可调，而提示词/上下文催它去查时
    同样会写标记——所以剥的地方在协议层（两条链路共用），不在工具循环里。
    """
    get_services().runtime.set({"chat.agent_enabled": False})
    install_fake_chat(MARKER_ANSWER)
    conversation_id = _conversation(client)

    events = _ask(client, conversation_id, kb_id, "NVIDIA 的规格是什么")

    assert _event(events, "done")["answer"] == "我还想再核一眼 NVIDIA 的文档。"
    stored = client.get(f"/api/v1/conversations/{conversation_id}").json()["messages"][-1]
    assert stored["content"] == "我还想再核一眼 NVIDIA 的文档。"


# ------------------------------------------------- 流式健壮性：心跳（P2-2）


def test_a_quiet_stream_gets_a_ping_so_the_connection_is_not_dropped(
    client: TestClient, kb_id: str, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    """流里长时间没有事件时要发**心跳**（P2-2）。

    为什么非有不可：这条流经常几十秒没有任何字节（等端点出第一个字、跑一个抓网页的
    工具、派子 Agent），而那在中间层看起来与"连接死了"一模一样——nginx 的
    ``proxy_read_timeout`` 默认 60 秒就把上游读断了。被掐掉时用户看到的是"回答写到
    一半没了"，而模型那边一切正常（见 ``chat.SSE_PING_SECONDS``）。

    心跳间隔在这里被压到 0.05 秒：真等 15 秒的用例没人会跑，而被测的判据是
    "静默期里有没有字节出去"，与那个数字无关。
    """
    from app.api.v1 import chat as chat_api
    from app.services.llm import LLMDelta

    monkeypatch.setattr(chat_api, "SSE_PING_SECONDS", 0.05)
    chat = install_fake_chat("甲乙")

    def quiet_stream(messages, tools=None):  # type: ignore[no-untyped-def]
        # 第一段正文先到，然后**静默 0.3 秒**（真实现里那是模型在想、或者工具在跑）
        yield LLMDelta(text="甲")
        time.sleep(0.3)
        yield LLMDelta(text="乙")

    monkeypatch.setattr(chat, "stream_events", quiet_stream)

    text = client.post("/api/v1/chat/stream", json={"query": "问题", "kb_ids": [kb_id]}).text

    assert "event: ping" in text, "静默期里必须有心跳字节出去"
    # 心跳出现在**那两段正文之间**：说明它真是"空闲时补的"，不是流末尾附送的
    assert text.index("event: ping") < text.index('"text": "乙"')
    # 而且它不打扰正文：回答照旧完整
    events = _parse_sse(text)
    assert [e for e in events if e["type"] == "done"][-1]["answer"] == "甲乙"
    # **心跳对界面不可见**：它连 data 行都没有，所以那条已知事件类型之外不会多出东西
    # （前端把不认识的 data 当成错误，见 chat._ping 的说明）
    assert {e["type"] for e in events} <= {"step", "sources", "delta", "thinking", "done"}


def test_a_disconnect_still_reaches_the_inner_stream() -> None:
    """套上心跳之后，"客户端断开"**仍然要能收尾内层流**（P2-2 的回归点）。

    心跳必须另起一个线程跑内层生成器（见 ``chat._with_pings``：同一根线里等不到
    空闲期），于是断开这件事变成了"消费侧置停止标记、生产侧在两次 next 之间
    自己关掉内层生成器"。这条链路要是断了，表现是**静默的**——不报错，只是
    "用户停在半截"的那条记录（``interrupted``，P0-2 的验收）不再进日志。
    """
    from app.api.v1 import chat as chat_api

    closed: list[str] = []

    def events():  # type: ignore[no-untyped-def]
        try:
            yield 'data: {"type": "step"}\n\n'
            while True:  # 一直有东西可发：模拟"这一轮还在跑"
                time.sleep(0.01)
                yield 'data: {"type": "delta", "text": "字"}\n\n'
        finally:
            # 内层生成器的收尾（真实链路里那是 ``_events`` 补一条 interrupted）
            closed.append("closed")

    stream = chat_api._with_pings(events())
    assert next(stream).startswith("data:"), "流真的开起来了"
    stream.close()  # 客户端断开

    # 收尾发生在**那个线程**里（真实链路里它还要写一次库）：给它一点时间
    deadline = time.monotonic() + 2.0
    while not closed and time.monotonic() < deadline:
        time.sleep(0.01)
    assert closed == ["closed"], "断开必须能传到内层生成器（否则中断记录就丢了）"




# ------------------------------------------- 两级压缩的第一级（P1-3）

def test_the_first_level_of_compression_happens_inside_the_turn(
    client: TestClient, kb_id: str
) -> None:
    """**第一级压缩（剪旧工具结果）在工具循环里就生效**（P1-3）。

    判据是"模型最后那次调用看到的是什么"：较早的工具结果已经换成了占位符，
    最近 ``PRUNE_KEEP_TOOL_RESULTS`` 条仍是原文。抄的是 DSH 的 tool-result-pruner
    与 ZCode 的 microcompact——**免费的那一级先做**，而且从下一步起就生效
    （它就地把循环手里那份 messages 换掉，不是只在某一次请求里生效）。
    """
    from app.services.chat import PRUNE_KEEP_TOOL_RESULTS, TOOL_RESULT_PLACEHOLDER

    steps = 7
    script = [search_tool_call(f"问题{index}", call_id=f"c{index}") for index in range(steps)]
    script.append(LLMReply())  # 最后一次：不调工具，直接作答
    chat = install_fake_chat("答案", script=script)

    # 每次检索都回一段**互不相同**的长原文：相同的 chunk_id 会被来源账本判成
    # "这一批没有新增"，于是回给模型的是一句短话——那就没得剪了（测了个空）
    counter = itertools.count(1)

    def fake_sources(*, query: str, kb_ids: list[str], top_k=None, reader=None):  # type: ignore[no-untyped-def]
        index = next(counter)
        return [
            SourceRef(
                index=1,
                chunk_id=f"c{index}",
                document_id=f"d{index}",
                document_name=f"文档{index}.pdf",
                preview="原文" * 200,
            )
        ]

    get_services().chat.retrieve_sources = fake_sources  # type: ignore[method-assign]
    conversation_id = _conversation(client)

    client.post(
        "/api/v1/chat/stream",
        json={"query": "问题", "kb_ids": [kb_id], "conversation_id": conversation_id},
    )

    seen = [item for item in chat.seen_messages if item.role == "tool"]
    assert len(seen) == steps, "每一步的结果都要回到上下文里"
    cleared = steps - PRUNE_KEEP_TOOL_RESULTS
    assert [item.content for item in seen[:cleared]] == [TOOL_RESULT_PLACEHOLDER] * cleared
    assert all(item.content != TOOL_RESULT_PLACEHOLDER for item in seen[-PRUNE_KEEP_TOOL_RESULTS:])
    # 配对没坏：每条工具结果仍指着它的那次调用（丢了 tool_call_id 端点会 400）
    assert [item.tool_call_id for item in seen] == [f"c{index}" for index in range(steps)]


# ------------------------------------------------- 上下文用量（P1-3 的仪表）

def test_context_usage_breaks_down_by_source_and_adds_up(
    client: TestClient, kb_id: str
) -> None:
    """``GET /chat/context-usage``：按来源分解，**各项之和 == used**（P1-3 的验收⑤）。

    这一条同时钉住"它真的算了"：消息那一项来自这条会话的历史、工具那一项来自
    这一轮真给出去的那张表（不是编一个数字），而六项加起来必须等于 ``used``——
    分解与总数对不上的仪表比没有仪表更糟。
    """
    install_fake_chat("答案", script=[search_tool_call("问题")])
    _install_fake_sources()
    conversation_id = _conversation(client)
    message = client.post(
        "/api/v1/chat/stream",
        json={"query": "问题", "kb_ids": [kb_id], "conversation_id": conversation_id},
    )
    assert message.status_code == 200

    usage = client.get(f"/api/v1/chat/context-usage?conversation_id={conversation_id}").json()

    assert [item["kind"] for item in usage["items"]] == [
        "messages",
        "system_prompt",
        "skills",
        "tools",
        "memory",
        "other",
    ]
    assert sum(item["tokens"] for item in usage["items"]) == usage["used"]
    assert usage["used"] > 0 and usage["total"] > 0 and 0 < usage["ratio"] <= 1
    assert usage["ratio"] == pytest.approx(usage["used"] / usage["total"], abs=1e-4)
    assert usage["compress_at"] > 0
    # **是估算，而且要如实说**（界面上不能把估算画成账单）
    assert usage["estimated"] is True and "估算" in usage["note"]

    by_kind = {item["kind"]: item for item in usage["items"]}
    assert by_kind["messages"]["chars"] >= len("问题"), "历史那一条真的被算进去了"
    assert by_kind["tools"]["tokens"] > 0, "工具表是这一轮真给出去的那一张"
    assert by_kind["system_prompt"]["tokens"] > 0
    for item in usage["items"]:
        assert item["share"] == pytest.approx(item["tokens"] / usage["used"], abs=1e-6)


def test_context_usage_needs_a_known_conversation(client: TestClient) -> None:
    """缺参数 422、会话不存在 404（与既有的按会话读的端点同一套归属判定）。"""
    assert client.get("/api/v1/chat/context-usage").status_code == 422
    assert (
        client.get("/api/v1/chat/context-usage?conversation_id=conv_不存在").status_code == 404
    )
