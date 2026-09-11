"""文档列表的筛选（v13 之后）。

镜像同构：``app/api/v1/documents.py`` → 本文件。

服务层/存储层的过滤分支在这里做端到端验证：文件名模糊搜（含通配符转义）、
状态过滤、来源过滤、非法枚举值被挡在 422。目录维度的过滤在
``test_folders_api.py`` 已覆盖，这里只补新加的三个参数。
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient

from tests.conftest import admin_client as admin_session


@pytest.fixture
def client():
    with admin_session() as test_client:
        yield test_client


@pytest.fixture
def kb_id(client: TestClient) -> str:
    response = client.post("/api/v1/knowledge-bases", json={"name": "筛选测试库"})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _upload(client: TestClient, kb_id: str, name: str) -> dict:
    # 内容按文件名区分：同内容会被内容去重挡下，第二次上传拿到的是同一份文档
    content = f"# {name}\n\n正文。\n"
    response = client.post(
        f"/api/v1/knowledge-bases/{kb_id}/documents",
        files={"file": (name, io.BytesIO(content.encode()), "text/markdown")},
        params={"start": "false"},
    )
    assert response.status_code == 202, response.text
    return response.json()["document"]


def _list_names(client: TestClient, kb_id: str, **params: str) -> list[str]:
    response = client.get(f"/api/v1/knowledge-bases/{kb_id}/documents", params=params)
    assert response.status_code == 200, response.text
    return [item["name"] for item in response.json()["items"]]


def test_search_by_name_substring(client: TestClient, kb_id: str) -> None:
    _upload(client, kb_id, "2026 合同 A.md")
    _upload(client, kb_id, "2026 合同 B.md")
    _upload(client, kb_id, "预算表.md")

    assert sorted(_list_names(client, kb_id, q="合同")) == ["2026 合同 A.md", "2026 合同 B.md"]
    assert _list_names(client, kb_id, q="预算") == ["预算表.md"]
    assert _list_names(client, kb_id, q="不存在") == []


def test_search_is_case_insensitive_for_ascii(client: TestClient, kb_id: str) -> None:
    _upload(client, kb_id, "Report.DOCX")

    assert _list_names(client, kb_id, q="report") == ["Report.DOCX"]
    assert _list_names(client, kb_id, q="REPORT") == ["Report.DOCX"]


def test_search_treats_wildcards_literally(client: TestClient, kb_id: str) -> None:
    """搜 "a_b" 不该匹配到 "aXb"——LIKE 通配符必须转义成字面量。"""
    _upload(client, kb_id, "a_b.md")
    _upload(client, kb_id, "aXb.md")
    _upload(client, kb_id, "100%完成.md")

    assert _list_names(client, kb_id, q="a_b") == ["a_b.md"]
    assert _list_names(client, kb_id, q="100%") == ["100%完成.md"]


def test_blank_search_is_no_filter(client: TestClient, kb_id: str) -> None:
    _upload(client, kb_id, "甲.md")
    _upload(client, kb_id, "乙.md")

    assert len(_list_names(client, kb_id, q="   ")) == 2


def test_filter_by_stage(client: TestClient, kb_id: str) -> None:
    _upload(client, kb_id, "待处理.md")

    # 只登记未启动：全部停在 uploaded
    assert _list_names(client, kb_id, stage="uploaded") == ["待处理.md"]
    assert _list_names(client, kb_id, stage="failed") == []


def test_filter_by_source_kind(client: TestClient, kb_id: str) -> None:
    _upload(client, kb_id, "上传的.md")

    assert _list_names(client, kb_id, source_kind="upload") == ["上传的.md"]
    assert _list_names(client, kb_id, source_kind="rss") == []


def test_combined_filters(client: TestClient, kb_id: str) -> None:
    _upload(client, kb_id, "合同 2026.md")
    _upload(client, kb_id, "合同 2025.md")
    _upload(client, kb_id, "预算.md")

    # 文件名 + 状态同时收窄；两者都命中才返回
    assert sorted(_list_names(client, kb_id, q="合同", stage="uploaded")) == [
        "合同 2025.md",
        "合同 2026.md",
    ]
    assert _list_names(client, kb_id, q="合同", stage="failed") == []


def test_unknown_stage_is_422(client: TestClient, kb_id: str) -> None:
    """拼错的枚举值必须报错，而不是静默返回空列表。"""
    response = client.get(
        f"/api/v1/knowledge-bases/{kb_id}/documents", params={"stage": "no_such_stage"}
    )

    assert response.status_code == 422


def test_filter_composes_with_folder(client: TestClient, kb_id: str) -> None:
    folder = client.post(
        f"/api/v1/knowledge-bases/{kb_id}/folders", json={"name": "合同"}
    ).json()
    inside = _upload(client, kb_id, "合同 2026.md")
    _upload(client, kb_id, "合同 2025.md")
    client.patch(f"/api/v1/documents/{inside['id']}/folder", json={"folder_id": folder["id"]})

    assert _list_names(client, kb_id, folder_id=folder["id"], q="2026") == ["合同 2026.md"]
    assert _list_names(client, kb_id, folder_id=folder["id"], q="2025") == []


# --------------------------------------------------------------------- 重命名


def _issue(client: TestClient, permission: str) -> dict:
    response = client.post(
        "/api/v1/api-keys",
        json={"name": f"{permission} 钥匙", "permission": permission, "knowledge_base_ids": []},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_rename_document(client: TestClient, kb_id: str) -> None:
    document = _upload(client, kb_id, "旧名字.md")

    response = client.patch(f"/api/v1/documents/{document['id']}", json={"name": "新名字.md"})

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "新名字.md"
    # 详情与列表都要读到新名字（改名不能只改响应不回库）
    assert client.get(f"/api/v1/documents/{document['id']}").json()["name"] == "新名字.md"
    assert _list_names(client, kb_id) == ["新名字.md"]


def test_rename_trims_and_rejects_blank(client: TestClient, kb_id: str) -> None:
    document = _upload(client, kb_id, "原.md")

    trimmed = client.patch(
        f"/api/v1/documents/{document['id']}", json={"name": "  带空格的名字.md  "}
    )
    assert trimmed.json()["name"] == "带空格的名字.md"

    # 全空白：schema 的 min_length 拦不住，必须由服务层拒
    blank = client.patch(f"/api/v1/documents/{document['id']}", json={"name": "   "})
    assert blank.status_code == 422


def test_rename_missing_document_is_404(client: TestClient, kb_id: str) -> None:
    response = client.patch("/api/v1/documents/doc_nope", json={"name": "x.md"})
    assert response.status_code == 404


def test_readonly_key_cannot_rename_or_cancel(client: TestClient, kb_id: str) -> None:
    document = _upload(client, kb_id, "只读的.md")
    issued = _issue(client, "readonly")
    readonly = {"Authorization": f"Bearer {issued['token']}"}

    assert (
        client.patch(
            f"/api/v1/documents/{document['id']}", json={"name": "改不了.md"}, headers=readonly
        ).status_code
        == 403
    )
    assert (
        client.post(f"/api/v1/documents/{document['id']}/cancel", headers=readonly).status_code
        == 403
    )


# --------------------------------------------------------------------- 取消解析


def test_cancel_marks_document_and_tasks_canceled(client: TestClient, kb_id: str) -> None:
    # start=true 会排一个摄入任务；没有 worker 时它停在 pending，正好用来验证取消把它收掉
    response = client.post(
        f"/api/v1/knowledge-bases/{kb_id}/documents",
        files={"file": ("取消我.md", io.BytesIO(b"# x\n"), "text/markdown")},
        params={"start": "true"},
    )
    document = response.json()["document"]
    task_id = response.json()["task_id"]
    assert task_id

    canceled = client.post(f"/api/v1/documents/{document['id']}/cancel")

    assert canceled.status_code == 200, canceled.text
    assert canceled.json()["stage"] == "canceled"
    task = next(item for item in client.get("/api/v1/tasks").json()["items"] if item["id"] == task_id)
    assert task["state"] == "canceled"


def test_cancel_is_idempotent(client: TestClient, kb_id: str) -> None:
    document = _upload(client, kb_id, "再取消一次.md")

    assert client.post(f"/api/v1/documents/{document['id']}/cancel").status_code == 200
    assert client.post(f"/api/v1/documents/{document['id']}/cancel").status_code == 200


def test_cancel_missing_document_is_404(client: TestClient, kb_id: str) -> None:
    assert client.post("/api/v1/documents/doc_nope/cancel").status_code == 404

