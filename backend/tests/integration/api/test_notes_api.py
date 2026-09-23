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


def test_list_preview_drops_image_and_its_size_marker(client: TestClient) -> None:
    """配图**连同尺寸后缀**一起丢。

    前端拖拽缩放后，图片在正文里是 ``![图](url){width=460}``（见
    frontend/src/features/notes/noteImage.ts）。只丢图片语法的话，每条缩过图的
    笔记，列表预览末尾都会挂一段 ``{width=460}``——那是给编辑器看的，不是内容。
    """
    body = (
        "看图\n\n"
        "![图](/api/v1/notes/n1/images/a.png?expires=1&signature=x){width=460}\n\n"
        "图后面的正文"
    )
    client.post("/api/v1/notes", json={"title": "T", "content_md": body})

    preview = client.get("/api/v1/notes").json()["items"][0]["preview"]

    assert "{width" not in preview
    assert "images/a.png" not in preview
    assert "看图" in preview and "图后面的正文" in preview


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


# ------------------------------------------------- AI 处理与配图（v20.2）


class _FakeChat:
    """只实现 complete：笔记 AI 走的是 `ask_raw`（不检索、不拼资料）。"""

    def __init__(self, answer: str = "整理后的正文") -> None:
        self.answer = answer

    def complete(self, messages):  # type: ignore[no-untyped-def]
        return self.answer


def _install_fake_chat(answer: str = "整理后的正文") -> None:
    from app.core.services import get_services
    from tests.conftest import bind_model

    services = get_services()
    bind_model(services.models, "chat", model_id="fake-model", capabilities=["chat"])
    services.chat._chat_factory = lambda config: _FakeChat(answer)


def _png() -> bytes:
    return bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
        "1f15c4890000000a49444154789c6360000002000100ffff0300000600"
        "05570a2e0000000049454e44ae426082"
    )


def test_ai_transform_returns_processed_markdown(client: TestClient) -> None:
    _install_fake_chat("## 标题\n\n- 要点一\n- 要点二")
    note = client.post(
        "/api/v1/notes", json={"title": "T", "content_md": "标题 要点一 要点二"}
    ).json()

    response = client.post(f"/api/v1/notes/{note['id']}/ai", json={"action": "format"})

    assert response.status_code == 200, response.text
    assert response.json()["content_md"].startswith("## 标题")
    # 不自动落库：用户先看结果再决定存不存
    assert client.get(f"/api/v1/notes/{note['id']}").json()["content_md"] == "标题 要点一 要点二"


def test_ai_transform_rejects_unknown_action(client: TestClient) -> None:
    note = client.post("/api/v1/notes", json={"title": "T", "content_md": "正文"}).json()

    response = client.post(f"/api/v1/notes/{note['id']}/ai", json={"action": "translate"})

    assert response.status_code == 422  # 字面量校验在协议层挡掉


def test_ai_transform_on_empty_note_is_a_readable_400(client: TestClient) -> None:
    _install_fake_chat()
    note = client.post("/api/v1/notes", json={"title": "空的"}).json()

    response = client.post(f"/api/v1/notes/{note['id']}/ai", json={"action": "polish"})

    # InvalidRequestError 统一映射 422（与全仓口径一致）
    assert response.status_code == 422
    assert "为空" in response.json()["message"]


def test_upload_and_serve_note_image(client: TestClient) -> None:
    note = client.post("/api/v1/notes", json={"title": "带图", "content_md": "正文"}).json()

    upload = client.post(
        f"/api/v1/notes/{note['id']}/images",
        files={"file": ("shot.png", _png(), "image/png")},
    )

    assert upload.status_code == 200, upload.text
    body = upload.json()
    assert body["name"].endswith(".png")
    assert body["url"].startswith(f"/api/v1/notes/{note['id']}/images/")
    assert "signature=" in body["url"]

    served = client.get(body["url"])
    assert served.status_code == 200
    assert served.headers["content-type"].startswith("image/png")
    assert served.content == _png()


def test_note_image_rejects_a_tampered_signature(client: TestClient) -> None:
    note = client.post("/api/v1/notes", json={"title": "带图", "content_md": "正文"}).json()
    url = client.post(
        f"/api/v1/notes/{note['id']}/images",
        files={"file": ("shot.png", _png(), "image/png")},
    ).json()["url"]

    tampered = url.split("signature=")[0] + "signature=deadbeef"
    assert client.get(tampered).status_code == 401


def test_note_image_rejects_svg(client: TestClient) -> None:
    """SVG 能内嵌脚本，而图片是按 URL 直接加载的——不收。"""
    note = client.post("/api/v1/notes", json={"title": "带图", "content_md": "正文"}).json()

    response = client.post(
        f"/api/v1/notes/{note['id']}/images",
        files={"file": ("x.svg", b"<svg onload=alert(1)/>", "image/svg+xml")},
    )

    assert response.status_code == 422
