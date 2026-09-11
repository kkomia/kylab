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
