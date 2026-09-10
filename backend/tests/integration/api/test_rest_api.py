"""REST API 的集成测试（M4 核心端点）。

通过真实 HTTP 打整条链路：建库 → 上传 → 手动驱动 worker 摄入 → 检索 → 查任务。
"""

import io

import pytest
from fastapi.testclient import TestClient

from app.core.services import get_services
from app.models.enums import DocumentStage, TaskState

MARKDOWN = (
    "# 知识库设计\n\n"
    "向量检索与全文检索混合召回，用于验证 REST 链路。\n\n"
    "## 部署\n\n"
    "Docker Compose 一键起，默认端口 8000。\n"
)


@pytest.fixture
def client():
    from app.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


@pytest.fixture
def kb_id(client: TestClient) -> str:
    response = client.post("/api/v1/knowledge-bases", json={"name": "技术库"})
    assert response.status_code == 201
    return response.json()["id"]


def _upload(client: TestClient, kb_id: str, *, name: str = "kb.md", content: str = MARKDOWN):
    return client.post(
        f"/api/v1/knowledge-bases/{kb_id}/documents",
        files={"file": (name, io.BytesIO(content.encode()), "text/markdown")},
    )


def _drain_worker() -> None:
    """手动把队列跑空：测试里关掉了内嵌消费者，时序才可控。"""
    import asyncio

    worker = get_services().worker

    async def drain() -> None:
        while await worker.run_once():
            pass

    asyncio.run(drain())


# --------------------------------------------------------------------- 知识库


def test_create_and_list_knowledge_bases(client: TestClient) -> None:
    created = client.post("/api/v1/knowledge-bases", json={"name": "研究库", "chunk_size": 256})
    assert created.status_code == 201
    body = created.json()
    assert body["name"] == "研究库"
    assert body["chunk_size"] == 256
    assert body["embedding_dim"] > 0

    listed = client.get("/api/v1/knowledge-bases")
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["items"]] == [body["id"]]


def test_get_knowledge_base_detail(client: TestClient, kb_id: str) -> None:
    response = client.get(f"/api/v1/knowledge-bases/{kb_id}")
    assert response.status_code == 200
    assert response.json()["id"] == kb_id


def test_unknown_knowledge_base_returns_error_envelope(client: TestClient) -> None:
    """错误信封格式由前端消费，状态码与 code 都要稳定。"""
    response = client.get("/api/v1/knowledge-bases/kb_none")
    assert response.status_code == 404
    assert response.json()["code"] == "not_found"


def test_create_knowledge_base_validates_input(client: TestClient) -> None:
    assert client.post("/api/v1/knowledge-bases", json={"name": ""}).status_code == 422
    assert client.post(
        "/api/v1/knowledge-bases", json={"name": "x", "chunk_overlap": 99999}
    ).status_code == 422


# --------------------------------------------------------------------- 上传


def test_upload_returns_accepted_with_task(client: TestClient, kb_id: str) -> None:
    response = _upload(client, kb_id)
    assert response.status_code == 202

    body = response.json()
    assert body["is_duplicate"] is False
    assert body["task_id"]
    assert body["document"]["stage"] == "uploaded"


def test_upload_can_skip_ingest(client: TestClient, kb_id: str) -> None:
    response = client.post(
        f"/api/v1/knowledge-bases/{kb_id}/documents?start=false",
        files={"file": ("kb.md", io.BytesIO(MARKDOWN.encode()), "text/markdown")},
    )
    assert response.status_code == 202
    assert response.json()["task_id"] is None


def test_duplicate_upload_is_flagged(client: TestClient, kb_id: str) -> None:
    """架构 §6.3：命中相同 hash 要提醒"检测到相同文件"，且不重复入库。"""
    first = _upload(client, kb_id).json()
    second = _upload(client, kb_id, name="copy.md").json()

    assert second["is_duplicate"] is True
    assert second["document"]["id"] == first["document"]["id"]
    assert second["task_id"] is None


def test_upload_to_unknown_kb_fails(client: TestClient) -> None:
    response = _upload(client, "kb_none")
    assert response.status_code == 404


def test_upload_rejects_oversized_file(client: TestClient, kb_id: str, monkeypatch) -> None:
    """上限在入口挡住，不要等跑到云端解析才失败。"""
    import app.api.v1.documents as documents_api

    monkeypatch.setattr(documents_api, "MAX_UPLOAD_BYTES", 8)
    response = _upload(client, kb_id)
    assert response.status_code == 413


# --------------------------------------------------------------------- 列表与详情


def test_document_list_shows_stage(client: TestClient, kb_id: str) -> None:
    _upload(client, kb_id)

    items = client.get(f"/api/v1/knowledge-bases/{kb_id}/documents").json()["items"]
    assert len(items) == 1
    assert items[0]["name"] == "kb.md"
    assert items[0]["stage"] == DocumentStage.UPLOADED.value
    assert items[0]["size_bytes"] > 0


def test_document_detail_and_missing(client: TestClient, kb_id: str) -> None:
    document_id = _upload(client, kb_id).json()["document"]["id"]

    assert client.get(f"/api/v1/documents/{document_id}").status_code == 200
    assert client.get("/api/v1/documents/doc_none").status_code == 404


def test_parts_endpoint_returns_empty_for_unsplit_document(client: TestClient,
                                                           kb_id: str) -> None:
    document_id = _upload(client, kb_id).json()["document"]["id"]
    response = client.get(f"/api/v1/documents/{document_id}/parts")
    assert response.status_code == 200
    assert response.json()["items"] == []


def test_reprocess_is_accepted(client: TestClient, kb_id: str) -> None:
    document_id = _upload(client, kb_id).json()["document"]["id"]
    response = client.post(f"/api/v1/documents/{document_id}/reprocess")
    assert response.status_code == 202
    assert response.json()["task_id"]


# --------------------------------------------------------------------- 任务


def test_task_list_exposes_retry_metadata(client: TestClient, kb_id: str) -> None:
    """任务中心要靠这些字段显示"重试了几次、为什么卡住"。"""
    _upload(client, kb_id)

    items = client.get("/api/v1/tasks").json()["items"]
    assert len(items) == 1
    assert items[0]["kind"] == "parse"
    assert items[0]["state"] == TaskState.PENDING.value
    assert items[0]["max_attempts"] >= 1


def test_task_list_filters_by_state(client: TestClient, kb_id: str) -> None:
    _upload(client, kb_id)
    assert client.get("/api/v1/tasks?state=running").json()["items"] == []
    assert len(client.get("/api/v1/tasks?state=pending").json()["items"]) == 1


def test_invalid_task_state_is_rejected(client: TestClient) -> None:
    assert client.get("/api/v1/tasks?state=bogus").status_code == 422


# --------------------------------------------------------------------- 检索（含端到端）


def test_search_before_ingest_returns_empty(client: TestClient, kb_id: str) -> None:
    response = client.post(
        "/api/v1/search", json={"query": "向量检索", "kb_ids": [kb_id]}
    )
    assert response.status_code == 200
    assert response.json()["hits"] == []


def test_search_validates_input(client: TestClient) -> None:
    assert client.post("/api/v1/search", json={"query": "", "kb_ids": ["kb_1"]}).status_code == 422
    assert client.post("/api/v1/search", json={"query": "x", "kb_ids": []}).status_code == 422


def test_full_upload_to_search_flow(client: TestClient, kb_id: str) -> None:
    """端到端：上传 → worker 摄入 → 检索命中。这是产品主链路的最小验收。"""
    _upload(client, kb_id)
    _drain_worker()

    document = client.get(f"/api/v1/knowledge-bases/{kb_id}/documents").json()["items"][0]
    assert document["stage"] == DocumentStage.INDEXED.value
    assert document["chunk_count"] > 0

    response = client.post(
        "/api/v1/search",
        json={"query": "混合召回", "kb_ids": [kb_id], "top_k": 5},
    )
    body = response.json()
    assert body["hits"], "摄入完成后应当能检索到内容"
    hit = body["hits"][0]
    assert hit["document_id"] == document["id"]
    assert hit["text"]
    assert hit["channels"]
    assert body["stats"]


def test_search_reports_development_embedding(client: TestClient, kb_id: str) -> None:
    """没配 embedding key 时必须如实告知：界面要提示"检索质量不代表真实效果"。"""
    _upload(client, kb_id)
    _drain_worker()

    body = client.post("/api/v1/search", json={"query": "部署", "kb_ids": [kb_id]}).json()
    assert body["embedding_is_development"] is True


def test_search_modes_and_filters(client: TestClient, kb_id: str) -> None:
    _upload(client, kb_id)
    _drain_worker()

    only_text = client.post(
        "/api/v1/search",
        json={"query": "部署", "kb_ids": [kb_id], "mode": "fulltext"},
    ).json()
    assert [stat["channel"] for stat in only_text["stats"]] == ["fulltext"]

    filtered = client.post(
        "/api/v1/search",
        json={
            "query": "部署",
            "kb_ids": [kb_id],
            "filters": {"document_ids": ["doc_not_exist"]},
        },
    ).json()
    assert filtered["hits"] == []
    assert filtered["filtered_out"] > 0
