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


def test_upload_keeps_chinese_filename_readable(client: TestClient, kb_id: str) -> None:
    """中文文件名必须原样存下来。

    浏览器把 UTF-8 文件名的**原始字节**塞进只允许 latin-1 的 Content-Disposition 头，
    服务端若照 latin-1 解就会得到乱码。这里手工构造那种报文体，
    确保文件名在"入库"这一步已经被还原成可读中文。
    """
    boundary = "----kylabtest"
    filename_bytes = "架构设计.md".encode()
    body = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="file"; filename="',
            filename_bytes,
            b'"\r\n',
            b"Content-Type: text/markdown\r\n\r\n",
            MARKDOWN.encode(),
            f"\r\n--{boundary}--\r\n".encode(),
        ]
    )

    response = client.post(
        f"/api/v1/knowledge-bases/{kb_id}/documents",
        content=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )

    assert response.status_code == 202
    assert response.json()["document"]["name"] == "架构设计.md"
    listed = client.get(f"/api/v1/knowledge-bases/{kb_id}/documents").json()["items"]
    assert [item["name"] for item in listed] == ["架构设计.md"]


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


def test_chunks_endpoint_returns_ingested_text(client: TestClient, kb_id: str) -> None:
    """文档详情页的正文预览：接口得给出真实切块，而不是让前端编内容。"""
    document_id = _upload(client, kb_id).json()["document"]["id"]
    _drain_worker()

    body = client.get(f"/api/v1/documents/{document_id}/chunks").json()
    assert body["total"] == len(body["items"]) > 0
    assert body["items"][0]["ordinal"] == 0
    # 标题会进 heading_path，正文块里是段落文本
    assert "向量检索" in body["items"][0]["text"]
    assert body["items"][0]["document_id"] == document_id


def test_chunks_endpoint_respects_limit_and_reports_total(client: TestClient,
                                                          kb_id: str) -> None:
    """limit 只截断 items，total 必须仍是全量：否则界面会把预览说成全文。"""
    # 每段都超过半块（512），保证切分器不会把它们并进同一个块
    paragraph = "这一段用来撑出独立的切块。" * 30
    long_markdown = "\n\n".join(f"## 第 {i} 节\n\n{paragraph}" for i in range(12))
    upload = _upload(client, kb_id, name="long.md", content=long_markdown)
    document_id = upload.json()["document"]["id"]
    _drain_worker()

    full = client.get(f"/api/v1/documents/{document_id}/chunks").json()
    limited = client.get(f"/api/v1/documents/{document_id}/chunks?limit=2").json()

    assert full["total"] > 2
    assert len(limited["items"]) == 2
    assert limited["total"] == full["total"]


def test_chunks_endpoint_rejects_bad_limit_and_unknown_document(client: TestClient,
                                                                kb_id: str) -> None:
    document_id = _upload(client, kb_id).json()["document"]["id"]

    assert client.get(f"/api/v1/documents/{document_id}/chunks?limit=0").status_code == 422
    # 文档不存在要给 404，而不是空列表：空列表会让调用方以为"只是还没切块"
    assert client.get("/api/v1/documents/doc_none/chunks").status_code == 404


def test_chunks_endpoint_is_empty_before_ingest(client: TestClient, kb_id: str) -> None:
    document_id = _upload(client, kb_id, name="pending.md").json()["document"]["id"]

    body = client.get(f"/api/v1/documents/{document_id}/chunks").json()
    assert body == {"items": [], "total": 0}


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


def test_create_kb_without_an_embedding_model_is_rejected(monkeypatch) -> None:
    """没配嵌入模型时建库要被**明确拒绝**，而不是退回无语义的哈希实现。

    v0.8 之前这里会静默兜底，界面上还标"开发兜底"——用户会以为检索是有效的。
    现在返回 422 + 一句"去哪儿配"，前端据此在弹窗里就能给出下一步。
    """
    from app.core.config import get_settings
    from app.core.services import reset_services
    from app.main import create_app

    # 关掉测试默认打开的开发兜底：这一条要验的正是"没有兜底会怎样"
    monkeypatch.setenv("KYLAB_DEV_EMBEDDING", "false")
    get_settings.cache_clear()
    reset_services()

    with TestClient(create_app()) as isolated:
        response = isolated.post("/api/v1/knowledge-bases", json={"name": "无模型库"})

    assert response.status_code == 422
    assert "模型注册" in response.json()["message"]


def test_settings_reports_whether_embedding_is_configured(client: TestClient) -> None:
    """设置页要能区分"没配"与"配了"：前端据此决定建库入口能不能点。"""
    body = client.get("/api/v1/settings").json()

    # 测试环境显式开着开发兜底，因此没绑定注册模型 → 未配置
    assert body["embedding_configured"] is False
    assert body["embedding_is_development"] is True
    # 模型身份不在设置页分组里了（v0.8）：那里只剩行为参数
    embedding_group = next(g for g in body["groups"] if g["key"] == "embedding")
    assert [f["key"] for f in embedding_group["fields"]] == ["embedding.batch_size"]
