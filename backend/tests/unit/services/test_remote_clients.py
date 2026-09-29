"""两个**远端实现**的契约与失败分档（Phase B · P2）。

原则：**测试里不打真网络** ✗ —— 全部用 `httpx.MockTransport` 注入假传输 ✓。
覆盖：正常 ✓ / 超时 ✓ / 4xx ✓ / 5xx ✓ / SSE 分片重组 ✓ / "不可用"与"没命中"分开 ✓。

**注册怎么钉**（Lead 用真请求验过 ✓，判据记在这里以免下次误判）：
`POST /api/v1/model-proxy/complete` 空 body → **502**（说明路由**已注册**、handler 真跑了 ✓，
502 是因为没配模型/上游失败 ✗）；**404 才是没注册** ✗。
"""

from __future__ import annotations

import httpx
import pytest

from app.services.knowledge_client import KnowledgeClient
from app.services.llm import ChatMessage, ToolSpec
from app.services.model_client import ModelClient
from app.services.remote_clients import (
    RemoteKnowledgeClient,
    RemoteModelClient,
    RemoteRejectedError,
    RemoteUnavailableError,
)

BASE = "http://kylab.test/api/v1"


def _knowledge(handler) -> RemoteKnowledgeClient:  # type: ignore[no-untyped-def]
    return RemoteKnowledgeClient(BASE, token="t", transport=httpx.MockTransport(handler))


def _model(handler) -> RemoteModelClient:  # type: ignore[no-untyped-def]
    return RemoteModelClient(BASE, token="t", transport=httpx.MockTransport(handler))


# ------------------------------------------------------------------ 契约


def test_both_remote_clients_satisfy_their_protocols() -> None:
    """远端实现**就是协议的一份实现** ✓（换装配点时循环不用改 ✗）。"""
    knowledge = _knowledge(lambda request: httpx.Response(200, json={"hits": []}))
    model = _model(lambda request: httpx.Response(200, json={"text": ""}))

    assert isinstance(knowledge, KnowledgeClient)
    assert isinstance(model, ModelClient)


# ------------------------------------------------------------------ KB


def test_remote_knowledge_maps_hits_to_source_refs() -> None:
    """正常返回 → 与进程内实现**同一形状**的 `SourceRef`（编号 1..N ✓）。"""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/search")
        assert request.headers["authorization"] == "Bearer t"
        return httpx.Response(
            200,
            json={
                "hits": [
                    {
                        "chunk_id": "c1",
                        "document_id": "d1",
                        "document_name": "指南.pdf",
                        "heading_path": "第 3 章",
                        "page": 7,
                        "score": 0.5,
                        "preview": "原文",
                    },
                    {"chunk_id": "c2", "document_id": "d2", "document_name": "年报.pdf"},
                ]
            },
        )

    sources = _knowledge(handler).retrieve_sources(query="储能", kb_ids=["kb_1"], top_k=3)

    assert [source.index for source in sources] == [1, 2]
    assert sources[0].document_name == "指南.pdf"
    assert sources[0].page == 7


def test_remote_knowledge_returns_empty_on_no_hits() -> None:
    """**200 且没有命中 = 空列表** ✓（这才是"没命中"，不是"不可用" ✗）。"""
    client = _knowledge(lambda request: httpx.Response(200, json={"hits": []}))

    assert client.retrieve_sources(query="没有这条", kb_ids=["kb_1"]) == []


def test_remote_knowledge_raises_unavailable_on_timeout() -> None:
    """超时 → **不可用**（抛 ✓）—— 离线要能明示，别退化成空结果 ✗。"""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out")

    with pytest.raises(RemoteUnavailableError) as excinfo:
        _knowledge(handler).retrieve_sources(query="q", kb_ids=["kb"])

    assert "连不上" in str(excinfo.value)


@pytest.mark.parametrize("status", [400, 401, 403])
def test_remote_knowledge_rejects_on_4xx(status: int) -> None:
    """4xx → **请求被拒**（与 5xx 分档 ✗）。"""
    client = _knowledge(lambda request: httpx.Response(status, text="nope"))

    with pytest.raises(RemoteRejectedError) as excinfo:
        client.retrieve_sources(query="q", kb_ids=["kb"])

    assert f"HTTP {status}" in str(excinfo.value)


@pytest.mark.parametrize("status", [500, 503])
def test_remote_knowledge_unavailable_on_5xx(status: int) -> None:
    client = _knowledge(lambda request: httpx.Response(status, text="boom"))

    with pytest.raises(RemoteUnavailableError):
        client.retrieve_sources(query="q", kb_ids=["kb"])


# ------------------------------------------------------------------ 模型


def test_remote_model_complete_posts_wire_messages() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["body"] = request.read().decode()
        return httpx.Response(200, json={"text": "回答"})

    text = _model(handler).complete([ChatMessage(role="user", content="问题")])

    assert text == "回答"
    assert str(seen["path"]).endswith("/model-proxy/complete")
    assert "问题" in str(seen["body"])


def test_remote_model_stream_reassembles_split_sse_chunks() -> None:
    """**SSE 分片重组** ✓：一个事件被 TCP 切成几段也要完整拼回来。"""
    body = (
        'data: {"text": "你"}\n\n'
        'data: {"text": "好", "reasoning": "想"}\n\n'
        'data: [DONE]\n\n'
    ).encode()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    chunks = list(_model(handler).stream([ChatMessage(role="user", content="q")]))
    assert chunks == ["你", "好"]

    deltas = list(
        _model(handler).stream_events(
            [ChatMessage(role="user", content="q")],
            [ToolSpec(name="read_file", description="读文件", parameters={})],
        )
    )
    assert [delta.text for delta in deltas] == ["你", "好"]
    assert deltas[1].reasoning == "想"


def test_remote_model_stream_raises_on_5xx() -> None:
    client = _model(lambda request: httpx.Response(503, text="down"))

    with pytest.raises(RemoteUnavailableError):
        list(client.stream([ChatMessage(role="user", content="q")]))
