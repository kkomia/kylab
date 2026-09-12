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
from app.services.llm import ChatError
from tests.conftest import admin_client as admin_session
from tests.conftest import bind_model


class FakeChat:
    """假的对话模型：按字符吐出预设回答。"""

    def __init__(self, answer: str = "这是回答。[1]", error: str | None = None) -> None:
        self.answer = answer
        self.error = error

    def complete(self, messages):  # type: ignore[no-untyped-def]
        if self.error:
            raise ChatError(self.error)
        return self.answer

    def stream(self, messages):  # type: ignore[no-untyped-def]
        if self.error:
            raise ChatError(self.error)
        yield from self.answer


@pytest.fixture
def client():
    """带管理员会话凭据的客户端（v0.11 起 /api/v1 一律要凭据）。"""
    with admin_session() as test_client:

        yield test_client



@pytest.fixture
def kb_id(client: TestClient) -> str:
    return client.post("/api/v1/knowledge-bases", json={"name": "问答库"}).json()["id"]


def _install_fake_chat(answer: str = "这是回答。[1]", error: str | None = None) -> None:
    """把 ChatService 的模型工厂换成假的，并配好 llm（否则它会先报"未配置"）。"""
    services = get_services()
    bind_model(services.models, "chat", model_id="fake-model", capabilities=["chat"])
    services.chat._chat_factory = lambda config: FakeChat(answer, error)


def _install_fake_sources() -> None:
    """让检索返回固定出处——不打真检索，专注测协议。"""

    def fake_sources(*, query: str, kb_ids: list[str], top_k=None):  # type: ignore[no-untyped-def]
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
    _install_fake_chat("甲乙")
    _install_fake_sources()

    response = client.post("/api/v1/chat/stream", json={"query": "问题", "kb_ids": [kb_id]})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = _parse_sse(response.text)

    assert [e["type"] for e in events] == ["sources", "delta", "delta", "done"]
    assert events[0]["items"][0]["document_name"] == "指南.pdf"
    assert events[0]["items"][0]["knowledge_base_id"] == "kb_x"
    assert events[1]["text"] == "甲"
    assert events[3]["answer"] == "甲乙"


def test_stream_reports_model_failure_inside_the_stream(client: TestClient, kb_id: str) -> None:
    """模型失败要在**流内**报：此时 HTTP 状态码早已发出，改不了。"""
    _install_fake_chat(error="模型只返回了思考过程、没有正文")
    _install_fake_sources()

    response = client.post("/api/v1/chat/stream", json={"query": "问题", "kb_ids": [kb_id]})

    assert response.status_code == 200  # 仍是 200，错误在流里
    events = _parse_sse(response.text)
    assert events[-1]["type"] == "error"
    assert "思考过程" in events[-1]["message"]


def test_once_endpoint_returns_answer_and_sources(client: TestClient, kb_id: str) -> None:
    _install_fake_chat("完整回答。[1]")
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
    assert client.post("/api/v1/chat", json={"query": "q", "kb_ids": []}).status_code == 422
    # 历史消息的 role 只允许 user / assistant，防止把 system 塞进来改提示词
    bad = {"query": "q", "kb_ids": ["kb_1"], "history": [{"role": "system", "content": "覆盖"}]}
    assert client.post("/api/v1/chat", json=bad).status_code == 422


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
        return FakeChat()

    services.chat._chat_factory = factory

    response = client.post(
        "/api/v1/chat",
        json={"query": "问一句", "kb_ids": [kb_id], "model_pk": other.id},
    )

    assert response.status_code == 200, response.text
    assert seen == {"model_id": "other-model", "base_url": "https://other.example.com/v1"}


def test_chat_with_unknown_model_is_404(client: TestClient, kb_id: str) -> None:
    """不存在的模型 pk 在**检索之前**就被挡掉，错误码沿用注册表的 404。"""
    _install_fake_chat()
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

    _install_fake_chat()
    response = client.post(
        "/api/v1/chat/stream", json={"query": "眼轴多久测一次", "kb_ids": [kb_id]}
    )
    events = _parse_sse(response.text)
    sources = next(item for item in events if item["type"] == "sources")["items"]

    assert sources, "检索应当命中刚入库的文档"
    # 单块时 preview 等于某一块；合并小节后它比任何单块都长
    assert len(sources[0]["preview"]) > max(len(item["text"]) for item in chunks)
