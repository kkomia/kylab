"""笔记端点的集成测试（真实 SQLite，管理员会话）。

镜像同构：``app/api/v1/notes.py`` → ``tests/integration/api/test_notes_api.py``。
"""

import pytest
from fastapi.testclient import TestClient

from tests.conftest import admin_client as admin_session


@pytest.fixture
def client():
    with admin_session() as test_client:
        yield test_client


@pytest.fixture
def kb_id(client: TestClient) -> str:
    return client.post("/api/v1/knowledge-bases", json={"name": "笔记库"}).json()["id"]


def test_notes_crud_roundtrip(client: TestClient) -> None:
    created = client.post(
        "/api/v1/notes",
        json={"title": "眼轴监测", "content_md": "# 眼轴\n每三个月测一次", "tags": ["眼科"]},
    )
    assert created.status_code == 201, created.text
    note = created.json()
    assert note["id"].startswith("note_")
    assert note["title"] == "眼轴监测"
    assert note["tags"] == ["眼科"]

    listed = client.get("/api/v1/notes").json()
    assert listed["total"] == 1
    assert listed["items"][0]["id"] == note["id"]
    # 列表项不带正文，但有预览
    assert listed["items"][0]["content_md"] == ""
    assert "眼轴" in listed["items"][0]["preview"]

    updated = client.patch(
        f"/api/v1/notes/{note['id']}", json={"title": "改名", "pinned": True}
    ).json()
    assert updated["title"] == "改名" and updated["pinned"] is True

    assert client.delete(f"/api/v1/notes/{note['id']}").status_code == 204
    assert client.get(f"/api/v1/notes/{note['id']}").status_code == 404


def test_title_is_derived_when_omitted(client: TestClient) -> None:
    note = client.post("/api/v1/notes", json={"content_md": "## 散瞳验光\n正文"}).json()
    assert note["title"] == "散瞳验光"


def test_list_preview_strips_markdown_markers(client: TestClient) -> None:
    """列表预览不该把 ``##`` / ``- [ ]`` / ``**`` 原样摆出来——那是源码不是摘要。"""
    body = "# 标题\n\n- [ ] 待办\n\n**重点**内容"
    client.post("/api/v1/notes", json={"title": "T", "content_md": body})

    item = client.get("/api/v1/notes").json()["items"][0]

    assert "#" not in item["preview"]
    assert "[ ]" not in item["preview"] and "**" not in item["preview"]
    assert "重点内容" in item["preview"]


def test_unknown_note_is_404(client: TestClient) -> None:
    assert client.get("/api/v1/notes/note_missing").status_code == 404


def test_list_search_and_tags(client: TestClient) -> None:
    client.post(
        "/api/v1/notes", json={"title": "眼轴监测", "content_md": "三个月", "tags": ["眼科"]}
    )
    client.post("/api/v1/notes", json={"title": "无关", "content_md": "其它", "tags": ["杂记"]})

    searched = client.get("/api/v1/notes", params={"q": "眼轴"}).json()
    assert searched["total"] == 1

    by_tag = client.get("/api/v1/notes", params={"tag": "杂记"}).json()
    assert by_tag["total"] == 1 and by_tag["items"][0]["title"] == "无关"

    tags = client.get("/api/v1/notes/tags").json()["items"]
    assert {item["tag"] for item in tags} == {"眼科", "杂记"}


def test_attach_note_to_knowledge_base(client: TestClient, kb_id: str) -> None:
    """加入知识库 = 走现有摄入流水线生成一份 Markdown 文档，并回填 doc_id。"""
    note = client.post(
        "/api/v1/notes", json={"title": "眼轴小结", "content_md": "# 眼轴\n每三个月测一次"}
    ).json()

    response = client.post(f"/api/v1/notes/{note['id']}/attach", json={"kb_id": kb_id})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["kb_id"] == kb_id
    assert body["doc_id"]

    documents = client.get(
        f"/api/v1/knowledge-bases/{kb_id}/documents"
    ).json()["items"]
    assert any(item["id"] == body["doc_id"] for item in documents)
    assert documents[0]["source_kind"] == "upload"


def test_attach_unknown_kb_is_404(client: TestClient) -> None:
    note = client.post("/api/v1/notes", json={"title": "t", "content_md": "正文"}).json()

    assert (
        client.post(f"/api/v1/notes/{note['id']}/attach", json={"kb_id": "kb_missing"}).status_code
        == 404
    )


def test_notes_require_credentials() -> None:
    """没有令牌访问笔记应当 401——笔记是私有内容，不是公开数据。"""
    from fastapi.testclient import TestClient as PlainClient

    from app.main import app

    with PlainClient(app) as anon:
        assert anon.get("/api/v1/notes").status_code == 401
