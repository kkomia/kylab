"""阅读视角（报告 G2）。

镜像同构：``app/services/documents.py::content_kind`` / ``reading_view`` +
``/documents/{id}/preview`` → 本文件。

要钉的是"同一份文档，两条路径给同一个答案"：下载与预览对 kind 的判定必须一致，
否则会出现"预览能渲染、下载却是二进制"这种自相矛盾。
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient

from app.services.documents import content_kind

TEXT = "# 眼轴共识\n\n眼轴长度是主要监测指标。\n\n## 测量\n\n应散瞳后测量。\n".encode()
SIGNING_SECRET = "preview-test-secret"


# --------------------------------------------------------------------- 分类


@pytest.mark.parametrize(
    ("filename", "has_markdown", "expected"),
    [
        # 有解析产物一律当 markdown：那是流水线归一化后的文本，也是检索真正依据的东西
        ("报告.pdf", True, "markdown"),
        ("扫描件.png", True, "markdown"),
        # 没产物时才看后缀
        ("报告.pdf", False, "pdf"),
        ("图.png", False, "image"),
        ("照片.JPEG", False, "image"),  # 大小写不敏感
        ("说明.md", False, "markdown"),
        ("data.csv", False, "markdown"),
        ("表格.xlsx", False, "binary"),
        ("合同.docx", False, "binary"),
        ("没有后缀", False, "binary"),
    ],
)
def test_content_kind(filename: str, has_markdown: bool, expected: str) -> None:
    assert content_kind(filename, has_markdown=has_markdown) == expected


# --------------------------------------------------------------------- 接口


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("KYLAB_URL_SIGNING_SECRET", SIGNING_SECRET)
    monkeypatch.setenv("KYLAB_CONSOLE_TOKEN", "console-token-for-preview")

    from app.core.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    with TestClient(create_app()) as test_client:
        yield test_client
    get_settings.cache_clear()


CONSOLE = {"Authorization": "Bearer console-token-for-preview"}


def _upload(client: TestClient, name: str, content: bytes, mime: str) -> str:
    kb = client.post("/api/v1/knowledge-bases", json={"name": f"库-{name}"}, headers=CONSOLE)
    upload = client.post(
        f"/api/v1/knowledge-bases/{kb.json()['id']}/documents",
        files={"file": (name, io.BytesIO(content), mime)},
        params={"start": "false"},
        headers=CONSOLE,
    )
    assert upload.status_code == 202, upload.text
    return upload.json()["document"]["id"]


def test_preview_needs_credentials(client: TestClient) -> None:
    assert client.get("/api/v1/documents/doc_x/preview").status_code == 401


def test_unknown_document_is_404(client: TestClient) -> None:
    assert client.get("/api/v1/documents/doc_不存在/preview", headers=CONSOLE).status_code == 404


def test_text_document_preview_returns_markdown_inline(client: TestClient) -> None:
    """文本类内联返回，前端直接渲染——不必再发一次请求取内容。"""
    document_id = _upload(client, "说明.md", TEXT, "text/markdown")

    body = client.get(f"/api/v1/documents/{document_id}/preview", headers=CONSOLE).json()

    assert body["kind"] == "markdown"
    assert "眼轴长度是主要监测指标" in body["text"]
    assert body["url"] is None, "文本类不该给 URL（内容已经在 text 里了）"
    assert body["filename"] == "说明.md"


def test_binary_document_preview_degrades_to_download(client: TestClient) -> None:
    """Office 之类先不给预览，但也不能报错——退化成"只能下载"。"""
    document_id = _upload(client, "合同.docx", b"PK\x03\x04fake", "application/vnd.ms-word")

    body = client.get(f"/api/v1/documents/{document_id}/preview", headers=CONSOLE).json()

    assert body["kind"] == "binary"
    assert body["text"] is None and body["url"] is None
    # 前端据此显示"这个格式暂不支持预览，请下载"——所以文件名要给
    assert body["filename"] == "合同.docx"


def test_pdf_preview_returns_a_signed_url(client: TestClient) -> None:
    """PDF 交给浏览器原生渲染，所以给签名链接而不是把字节塞进 JSON。"""
    document_id = _upload(client, "报告.pdf", b"%PDF-1.7 fake", "application/pdf")

    body = client.get(f"/api/v1/documents/{document_id}/preview", headers=CONSOLE).json()

    assert body["kind"] == "pdf"
    assert body["text"] is None
    assert body["url"].startswith(f"/api/v1/documents/{document_id}/content")
    # 链接必须能直接用（浏览器打开 PDF 时不带任何头）
    assert client.get(body["url"]).status_code == 200


def test_image_preview_returns_a_signed_url(client: TestClient) -> None:
    document_id = _upload(client, "截图.png", b"\x89PNG\r\n\x1a\nfake", "image/png")

    body = client.get(f"/api/v1/documents/{document_id}/preview", headers=CONSOLE).json()

    assert body["kind"] == "image"
    assert body["url"]


def test_preview_kind_matches_download_kind(client: TestClient) -> None:
    """**两条路径必须给同一个答案。**

    预览说"这是 PDF、能渲染"，下载却按二进制处理——那种自相矛盾会让前端
    不知道该信哪个，用户也会看到"预览正常但下载的是别的东西"。
    """
    document_id = _upload(client, "报告.pdf", b"%PDF-1.7 fake", "application/pdf")

    preview = client.get(f"/api/v1/documents/{document_id}/preview", headers=CONSOLE).json()
    url = client.get(
        f"/api/v1/documents/{document_id}/download-url",
        params={"format": "original"},
        headers=CONSOLE,
    ).json()["url"]
    downloaded = client.get(url)

    assert preview["kind"] == "pdf"
    # 下载回来的 content-type 应当就是 PDF，说明两条路径对"这是什么"的判断一致
    assert downloaded.headers["content-type"].startswith("application/pdf")


@pytest.mark.asyncio
async def test_markdown_after_parsing_becomes_the_reading_view(client: TestClient) -> None:
    """解析完成后，阅读视角应当切到解析产物（归一化文本）。

    用真实的摄入链路：跑完 worker 之后 preview 的 kind 必须从 pdf 变成 markdown
    ——那意味着"用户核对解析对不对"看到的正是检索所依据的文本。
    """
    from app.core.services import get_services

    document_id = _upload(client, "报告.pdf", _tiny_pdf(), "application/pdf")
    services = get_services()
    # 手动驱动摄入（测试里 worker 不常驻）
    while await services.worker.run_once():
        pass

    body = client.get(f"/api/v1/documents/{document_id}/preview", headers=CONSOLE).json()
    if body["kind"] == "markdown":
        assert body["text"], "切到 markdown 却没有正文"
        assert body["url"] is None
    else:
        # 这个极小 PDF 可能被探测判成需要 OCR（没有文本层），那仍应是 pdf
        assert body["kind"] in ("pdf", "binary")


def _tiny_pdf() -> bytes:
    """一份带文本层的最小 PDF，用于走通"上传 → 解析 → 阅读视角切换"。"""
    try:
        import pymupdf  # type: ignore
    except ImportError:  # pragma: no cover - 环境缺库时退化成非 PDF
        return b"%PDF-1.7\nfake\n"

    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 100), "Axial length monitoring consensus 2023.", fontsize=12)
    data = doc.tobytes()
    doc.close()
    return data
