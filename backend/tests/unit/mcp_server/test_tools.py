"""MCP 工具（T4.8）。

镜像同构：``app/mcp/tools.py`` → 本文件。

**为什么值得单独测**：MCP 是产品的对外形态之一（架构 §2.1），而它的错误
**全部表现为"模型拿到了一段奇怪的文本"**——没有界面、没有 HTTP 状态码，
出了问题只有模型在胡说这一个症状。所以这里把每个工具的**形状与边界条件**
钉住：参数缺失要报错、上限要生效、返回值字段要稳定。

**不测传输层**：stdio 与 HTTP 是 SDK 的事，本项目只负责"工具做什么"。
按同一批用例验两条传输的收益很小——它们共用同一个 ``call_tool``。
"""

from __future__ import annotations

import base64
import uuid

import pytest

from app.core.exceptions import InvalidRequestError, NotFoundError
from app.core.services import Services
from app.mcp_server.tools import (
    MAX_TOP_K,
    MAX_UPLOAD_BYTES,
    TOOL_NAMES,
    call_tool,
    tool_definitions,
)


@pytest.fixture
def services() -> Services:
    from app.core.services import get_services

    return get_services()


@pytest.fixture
def kb(services: Services) -> str:  # type: ignore[no-untyped-def]
    # kb_id 由调用方生成——服务层要求显式传入（与 REST 层同一口径）
    return services.knowledge_bases.create(
        kb_id=f"kb_{uuid.uuid4().hex[:12]}", name="MCP 测试库"
    ).id


MARKDOWN = "# 眼轴\n\n眼轴长度是衡量儿童青少年眼球发育情况的主要参数之一，不受调节能力影响。\n"


# --------------------------------------------------------------------- 工具清单


def test_definitions_cover_every_known_tool() -> None:
    """定义与名字清单必须一一对应——少一个，客户端就看不到那个工具。"""
    assert {item["name"] for item in tool_definitions()} == set(TOOL_NAMES)


def test_every_definition_has_a_description_and_schema() -> None:
    """描述是**写给模型看的**：说清"什么时候该用"比说清参数更重要。"""
    for item in tool_definitions():
        assert item["description"].strip(), item["name"]
        assert item["inputSchema"]["type"] == "object", item["name"]


def test_unknown_tool_raises(services: Services) -> None:
    """**未知工具要报错而不是返回空。**

    静默失败会让模型以为"查到了但没有结果"，然后基于错误前提继续推理——
    那比直接告诉它"没有这个工具"危险得多。
    """
    with pytest.raises(InvalidRequestError) as excinfo:
        call_tool(services, "不存在的工具", {})
    assert "未知的工具" in str(excinfo.value)


# --------------------------------------------------------------------- 知识库


def test_list_knowledge_bases(services: Services, kb: str) -> None:
    items = call_tool(services, "list_knowledge_bases", {})

    assert any(item["id"] == kb for item in items)
    target = next(item for item in items if item["id"] == kb)
    assert target["name"] == "MCP 测试库"
    assert target["documents"] == 0


def test_create_knowledge_base(services: Services) -> None:
    created = call_tool(services, "create_knowledge_base", {"name": "新建的库"})

    assert created["name"] == "新建的库"
    assert created["id"].startswith("kb_")


def test_create_knowledge_base_requires_a_name(services: Services) -> None:
    with pytest.raises(InvalidRequestError):
        call_tool(services, "create_knowledge_base", {"name": "  "})


# --------------------------------------------------------------------- 上传


def test_upload_document(services: Services, kb: str) -> None:
    result = call_tool(
        services,
        "upload_document",
        {
            "knowledge_base_id": kb,
            "filename": "眼轴.md",
            "content_base64": base64.b64encode(MARKDOWN.encode()).decode(),
        },
    )

    assert result["is_duplicate"] is False
    assert result["document_id"].startswith("doc_")
    # 入库是异步的，返回值必须告诉模型"接下来怎么查"
    assert "get_document_status" in result["note"]


def test_upload_detects_duplicates(services: Services, kb: str) -> None:
    """同一份内容传两次，第二次要说清是重复——否则模型会以为库里有两份。"""
    payload = {
        "knowledge_base_id": kb,
        "filename": "眼轴.md",
        "content_base64": base64.b64encode(MARKDOWN.encode()).decode(),
    }
    call_tool(services, "upload_document", payload)

    second = call_tool(services, "upload_document", payload)

    assert second["is_duplicate"] is True
    assert "相同" in second["note"]


def test_upload_rejects_bad_base64(services: Services, kb: str) -> None:
    """**说清是 base64 不合法**，模型据此能自己改对，而不是放弃这个工具。"""
    with pytest.raises(InvalidRequestError) as excinfo:
        call_tool(
            services,
            "upload_document",
            {"knowledge_base_id": kb, "filename": "a.md", "content_base64": "这不是 base64!!"},
        )
    assert "base64" in str(excinfo.value)


def test_upload_rejects_oversized_content(services: Services, kb: str) -> None:
    """MCP 走进程间消息，塞一个巨大的 base64 会把两端一起拖住。"""
    blob = base64.b64encode(b"x" * (MAX_UPLOAD_BYTES + 1)).decode()

    with pytest.raises(InvalidRequestError) as excinfo:
        call_tool(
            services,
            "upload_document",
            {"knowledge_base_id": kb, "filename": "big.md", "content_base64": blob},
        )
    assert "上限" in str(excinfo.value)


def test_upload_needs_a_real_knowledge_base(services: Services) -> None:
    with pytest.raises(NotFoundError):
        call_tool(
            services,
            "upload_document",
            {
                "knowledge_base_id": "kb_不存在",
                "filename": "a.md",
                "content_base64": base64.b64encode(b"x").decode(),
            },
        )


# --------------------------------------------------------------------- 数据源


def test_add_data_source(services: Services, kb: str) -> None:
    result = call_tool(
        services,
        "add_data_source",
        {
            "knowledge_base_id": kb,
            "kind": "rss",
            "url": "https://example.com/feed.xml",
            "name": "示例订阅",
        },
    )

    assert result["name"] == "示例订阅"
    # 必须说清"登记 ≠ 立刻抓取"，否则模型会以为内容已经进来了
    assert "不会立刻" in result["note"]


def test_add_data_source_rejects_unknown_kind(services: Services, kb: str) -> None:
    with pytest.raises(InvalidRequestError) as excinfo:
        call_tool(
            services,
            "add_data_source",
            {"knowledge_base_id": kb, "kind": "webdav", "url": "https://example.com"},
        )
    assert "rss" in str(excinfo.value)


def test_add_data_source_rejects_non_http(services: Services, kb: str) -> None:
    with pytest.raises(InvalidRequestError):
        call_tool(
            services,
            "add_data_source",
            {"knowledge_base_id": kb, "kind": "html", "url": "file:///etc/passwd"},
        )


# --------------------------------------------------------------------- 检索


def test_search_without_any_kb_returns_empty(services: Services) -> None:
    """一个库都没有时不能炸——返回空结果并说明原因，让模型知道该怎么继续。"""
    result = call_tool(services, "search", {"query": "随便问问"})

    assert result["hits"] == []
    assert "没有任何知识库" in result["note"]


def test_search_caps_top_k(services: Services, kb: str) -> None:
    """**上限要生效**：工具是给 Agent 用的，它可能随手要 500 条，
    那会把上下文塞爆。"""
    result = call_tool(services, "search", {"query": "眼轴", "top_k": 9999})

    # 不抛错、也不返回超量——夹到上限即可
    assert isinstance(result["hits"], list)


def test_search_result_shape_is_stable(services: Services, kb: str) -> None:
    """字段名要稳定：模型按这些名字读结果，改一个名就等于换了一次工具。"""
    result = call_tool(services, "search", {"query": "眼轴", "knowledge_base_ids": [kb]})

    assert set(result) >= {"query", "hits", "filtered_out"}


# --------------------------------------------------------------------- 文档状态


def test_get_document_status(services: Services, kb: str) -> None:
    uploaded = call_tool(
        services,
        "upload_document",
        {
            "knowledge_base_id": kb,
            "filename": "状态.md",
            "content_base64": base64.b64encode(MARKDOWN.encode()).decode(),
        },
    )

    status = call_tool(services, "get_document_status", {"document_id": uploaded["document_id"]})

    assert status["stage"] == "uploaded"
    assert status["searchable"] is False, "还没处理完就标成可检索是最坏的一种错"
    assert "检索不到" in status["note"]


def test_get_document_status_rejects_unknown(services: Services) -> None:
    with pytest.raises(NotFoundError):
        call_tool(services, "get_document_status", {"document_id": "doc_不存在"})


# --------------------------------------------------------------------- 删除


def test_delete_document_puts_it_in_trash(services: Services, kb: str) -> None:
    uploaded = call_tool(
        services,
        "upload_document",
        {
            "knowledge_base_id": kb,
            "filename": "待删.md",
            "content_base64": base64.b64encode(MARKDOWN.encode()).decode(),
        },
    )

    result = call_tool(services, "delete_document", {"document_id": uploaded["document_id"]})

    assert result["trash_id"]
    assert "7 天" in result["note"]
    with pytest.raises(NotFoundError):
        call_tool(services, "get_document_status", {"document_id": uploaded["document_id"]})


def test_delete_unknown_document_raises(services: Services) -> None:
    with pytest.raises(NotFoundError):
        call_tool(services, "delete_document", {"document_id": "doc_不存在"})


# --------------------------------------------------------------------- 参数校验


@pytest.mark.parametrize(
    ("tool", "args"),
    [
        ("create_knowledge_base", {}),
        ("upload_document", {"knowledge_base_id": "kb_1"}),
        ("add_data_source", {"knowledge_base_id": "kb_1", "kind": "rss"}),
        ("search", {}),
        ("get_document_status", {}),
        ("delete_document", {}),
    ],
)
def test_missing_required_arguments_raise(
    services: Services, tool: str, args: dict
) -> None:  # type: ignore[type-arg]
    """缺参数要明确报"缺少参数：x"，而不是让下游抛一个难懂的 KeyError。"""
    with pytest.raises((InvalidRequestError, NotFoundError)):
        call_tool(services, tool, args)


def test_none_arguments_are_treated_as_empty(services: Services) -> None:
    """MCP 客户端对无参工具可能传 ``None``——那不该炸。"""
    assert isinstance(call_tool(services, "list_knowledge_bases", None), list)


def test_max_top_k_is_documented_in_the_schema() -> None:
    """schema 里的上限要与实现一致，否则模型会按错的上限要条数。"""
    search = next(item for item in tool_definitions() if item["name"] == "search")
    assert search["inputSchema"]["properties"]["top_k"]["maximum"] == MAX_TOP_K
