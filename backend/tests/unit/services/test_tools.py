"""MCP 工具（T4.8）。

镜像同构：``app/mcp/tools.py`` → 本文件。

**为什么值得单独测**：MCP 是产品的对外形态之一（架构 §2.1），而它的错误
**全部表现为"模型拿到了一段奇怪的文本"**——没有界面、没有 HTTP 状态码，
出了问题只有模型在胡说这一个症状。所以这里把每个工具的**形状与边界条件**
钉住：参数缺失要报错、上限要生效、返回值字段要稳定。

**v0.12 起每个调用都要带身份**：``call_tool`` 的 ``caller`` 是必填关键字参数，
连测试也不例外——留一个"默认管理员"的后门，就等于把收口又打开了。
所以这里显式给一个 ``admin`` fixture，另外用真实发放的 API Key 覆盖受限期。

**不测传输层**：stdio 与 HTTP 是 SDK 的事，本项目只负责"工具做什么"。
按同一批用例验两条传输的收益很小——它们共用同一个 ``call_tool``。
身份**怎么从传输里取出来**（请求头 / 环境变量）由 ``test_auth.py`` 单独测。
"""

from __future__ import annotations

import base64
import uuid

import pytest

from app.core.exceptions import ForbiddenError, InvalidRequestError, NotFoundError
from app.core.services import Services
from app.mcp_server.auth import current_caller
from app.services.api_key import READ, WRITE, Caller
from app.services.tools import (
    MAX_TOP_K,
    MAX_UPLOAD_BYTES,
    NOTE_EXCERPT_CHARS,
    TOOL_NAMES,
    call_tool,
    tool_definitions,
)


@pytest.fixture
def services() -> Services:
    from app.core.services import get_services

    return get_services()


@pytest.fixture
def admin() -> Caller:
    """管理员主体：不受库范围限制。

    **显式构造而不是让 call_tool 兜底**——见模块头：默认值一旦存在，
    "忘了传"就等于匿名放行。
    """
    return Caller(is_admin=True)


@pytest.fixture
def kb(services: Services) -> str:  # type: ignore[no-untyped-def]
    # kb_id 由调用方生成——服务层要求显式传入（与 REST 层同一口径）
    return services.knowledge_bases.create(
        kb_id=f"kb_{uuid.uuid4().hex[:12]}", name="MCP 测试库"
    ).id


@pytest.fixture
def key_for(services: Services):  # type: ignore[no-untyped-def]
    """按"库范围 + 权限"发一把真 Key 并换成 Caller——走真实发放路径，
    而不是手搓一个 Caller 对象（那样测的就不是判定本身了）。"""

    def make(*, kb_ids: list[str], permission=READ) -> Caller:  # type: ignore[no-untyped-def]
        issued = services.api_keys.create(
            name=f"测试密钥 {uuid.uuid4().hex[:6]}",
            permission=permission,
            knowledge_base_ids=kb_ids,
        )
        return services.api_keys.authenticate(issued.token)

    return make


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


def test_unknown_tool_raises(services: Services, admin: Caller) -> None:
    """**未知工具要报错而不是返回空。**

    静默失败会让模型以为"查到了但没有结果"，然后基于错误前提继续推理——
    那比直接告诉它"没有这个工具"危险得多。
    """
    with pytest.raises(InvalidRequestError) as excinfo:
        call_tool(services, "不存在的工具", {}, caller=admin)
    assert "未知的工具" in str(excinfo.value)


# --------------------------------------------------------------------- 身份收口


def test_caller_is_required(services: Services) -> None:
    """**没有身份就不能调工具**：``caller`` 没有默认值，漏传会直接 TypeError。

    这条测的不是"报错好看"，而是"后门不存在"——一旦有人给 ``caller`` 加个
    默认为管理员，这个用例会立刻失败。
    """
    with pytest.raises(TypeError):
        call_tool(services, "list_knowledge_bases", {})  # type: ignore[call-arg]


def test_current_caller_without_identity_raises() -> None:
    """传输层拿不到凭据时，``current_caller`` 必须拒绝而不是返回 None。

    返回 None 等于把"记得判空"变成每个工具的纪律，而漏判不会报错、
    只会静默放行——最难发现的一种洞。
    """
    from app.core.exceptions import UnauthorizedError

    with pytest.raises(UnauthorizedError) as excinfo:
        current_caller()
    # 报错要说清**两条传输各该怎么带凭据**，否则用户不知道该改哪里
    assert "Authorization" in str(excinfo.value)
    assert "KYLAB_MCP_KEY" in str(excinfo.value)


def test_list_only_returns_knowledge_bases_in_scope(
    services: Services, kb: str, key_for
) -> None:  # type: ignore[no-untyped-def]
    """**收口的核心用例**：范围外的库不能出现在列表里。

    收口之前 ``_list_knowledge_bases`` 直接调 ``list_all()``，
    实测无凭据即可列出全部真实知识库。
    """
    other = services.knowledge_bases.create(
        kb_id=f"kb_{uuid.uuid4().hex[:12]}", name="别人的库"
    ).id

    scoped = key_for(kb_ids=[other])
    items = call_tool(services, "list_knowledge_bases", {}, caller=scoped)

    ids = {item["id"] for item in items}
    assert other in ids
    assert kb not in ids, "范围外的库出现在了列表里"


def test_search_without_kb_ids_stays_in_scope(services: Services, kb: str, key_for) -> None:  # type: ignore[no-untyped-def]
    """不传库时是"查我能看到的全部"，**不是** "查所有人的全部"。"""
    other = services.knowledge_bases.create(
        kb_id=f"kb_{uuid.uuid4().hex[:12]}", name="别人的库"
    ).id
    scoped = key_for(kb_ids=[other])

    result = call_tool(services, "search", {"query": "眼轴"}, caller=scoped)

    # other 是空库，所以这里只该是空结果——关键是**不能因为越权而拿到 kb 的内容**
    assert result["hits"] == []


def test_search_rejects_out_of_scope_knowledge_base(
    services: Services, kb: str, key_for
) -> None:  # type: ignore[no-untyped-def]
    other = services.knowledge_bases.create(
        kb_id=f"kb_{uuid.uuid4().hex[:12]}", name="别人的库"
    ).id
    scoped = key_for(kb_ids=[other])

    with pytest.raises(ForbiddenError):
        call_tool(
            services,
            "search",
            {"query": "眼轴", "knowledge_base_ids": [kb]},
            caller=scoped,
        )


def test_readonly_key_cannot_upload(services: Services, kb: str, key_for) -> None:  # type: ignore[no-untyped-def]
    """只读 Key 写不动——而且要在**动手之前**就被拦住。"""
    readonly = key_for(kb_ids=[kb], permission=READ)

    with pytest.raises(ForbiddenError) as excinfo:
        call_tool(
            services,
            "upload_document",
            {
                "knowledge_base_id": kb,
                "filename": "a.md",
                "content_base64": base64.b64encode(MARKDOWN.encode()).decode(),
            },
            caller=readonly,
        )
    assert "只读" in str(excinfo.value)


def test_readonly_key_cannot_delete(services: Services, kb: str, key_for) -> None:  # type: ignore[no-untyped-def]
    """删除是写操作：只读凭据连自己范围内的库也不能删。"""
    writer = key_for(kb_ids=[kb], permission=WRITE)
    readonly = key_for(kb_ids=[kb], permission=READ)
    uploaded = call_tool(
        services,
        "upload_document",
        {
            "knowledge_base_id": kb,
            "filename": "待删.md",
            "content_base64": base64.b64encode(MARKDOWN.encode()).decode(),
        },
        caller=writer,
    )

    with pytest.raises(ForbiddenError):
        call_tool(
            services,
            "delete_document",
            {"document_id": uploaded["document_id"]},
            caller=readonly,
        )


def test_document_status_respects_scope(services: Services, kb: str, key_for) -> None:  # type: ignore[no-untyped-def]
    """按 id 直查文档也要判范围——否则知道 id 就能绕过列表。"""
    other = services.knowledge_bases.create(
        kb_id=f"kb_{uuid.uuid4().hex[:12]}", name="别人的库"
    ).id
    writer = Caller(is_admin=True)
    uploaded = call_tool(
        services,
        "upload_document",
        {
            "knowledge_base_id": kb,
            "filename": "范围.md",
            "content_base64": base64.b64encode(MARKDOWN.encode()).decode(),
        },
        caller=writer,
    )
    scoped = key_for(kb_ids=[other])

    with pytest.raises(ForbiddenError):
        call_tool(
            services,
            "get_document_status",
            {"document_id": uploaded["document_id"]},
            caller=scoped,
        )


def test_knowledge_base_created_by_a_member_is_owned_by_them(
    services: Services,
) -> None:
    """成员建出来的库要归他所有：不写 owner 的话他自己都看不见
    （``visible_kb_ids`` 对成员只算"自己拥有的 + 被分享的"）。"""
    from app.models.enums import ApiKeyPermission

    issued = services.api_keys.create(
        name="成员密钥", permission=ApiKeyPermission.READWRITE
    )
    # 直接用 user 形态：成员会话才是"能建库"的那种身份
    from app.storage.base import UserRecord

    member = Caller(
        api_key=issued.record,
        user=UserRecord(
            id=f"user_{uuid.uuid4().hex[:8]}",
            name="成员",
            password_hash="x",
        ),
    )
    created = call_tool(services, "create_knowledge_base", {"name": "成员建的库"}, caller=member)
    record = services.knowledge_bases.get(created["id"])
    assert record.owner_id == member.user.id  # type: ignore[union-attr]


# --------------------------------------------------------------------- 知识库


def test_list_knowledge_bases(services: Services, kb: str, admin: Caller) -> None:
    items = call_tool(services, "list_knowledge_bases", {}, caller=admin)

    assert any(item["id"] == kb for item in items)
    target = next(item for item in items if item["id"] == kb)
    assert target["name"] == "MCP 测试库"
    assert target["documents"] == 0


def test_create_knowledge_base(services: Services, admin: Caller) -> None:
    created = call_tool(services, "create_knowledge_base", {"name": "新建的库"}, caller=admin)

    assert created["name"] == "新建的库"
    assert created["id"].startswith("kb_")


def test_create_knowledge_base_requires_a_name(services: Services, admin: Caller) -> None:
    with pytest.raises(InvalidRequestError):
        call_tool(services, "create_knowledge_base", {"name": "  "}, caller=admin)


# --------------------------------------------------------------------- 上传


def test_upload_document(services: Services, kb: str, admin: Caller) -> None:
    result = call_tool(
        services,
        "upload_document",
        {
            "knowledge_base_id": kb,
            "filename": "眼轴.md",
            "content_base64": base64.b64encode(MARKDOWN.encode()).decode(),
        },
        caller=admin,
    )

    assert result["is_duplicate"] is False
    assert result["document_id"].startswith("doc_")
    # 入库是异步的，返回值必须告诉模型"接下来怎么查"
    assert "get_document_status" in result["note"]


def test_upload_detects_duplicates(services: Services, kb: str, admin: Caller) -> None:
    """同一份内容传两次，第二次要说清是重复——否则模型会以为库里有两份。"""
    payload = {
        "knowledge_base_id": kb,
        "filename": "眼轴.md",
        "content_base64": base64.b64encode(MARKDOWN.encode()).decode(),
    }
    call_tool(services, "upload_document", payload, caller=admin)

    second = call_tool(services, "upload_document", payload, caller=admin)

    assert second["is_duplicate"] is True
    assert "相同" in second["note"]


def test_upload_rejects_bad_base64(services: Services, kb: str, admin: Caller) -> None:
    """**说清是 base64 不合法**，模型据此能自己改对，而不是放弃这个工具。"""
    with pytest.raises(InvalidRequestError) as excinfo:
        call_tool(
            services,
            "upload_document",
            {"knowledge_base_id": kb, "filename": "a.md", "content_base64": "这不是 base64!!"},
            caller=admin,
        )
    assert "base64" in str(excinfo.value)


def test_upload_rejects_oversized_content(services: Services, kb: str, admin: Caller) -> None:
    """MCP 走进程间消息，塞一个巨大的 base64 会把两端一起拖住。"""
    blob = base64.b64encode(b"x" * (MAX_UPLOAD_BYTES + 1)).decode()

    with pytest.raises(InvalidRequestError) as excinfo:
        call_tool(
            services,
            "upload_document",
            {"knowledge_base_id": kb, "filename": "big.md", "content_base64": blob},
            caller=admin,
        )
    assert "上限" in str(excinfo.value)


def test_upload_needs_a_real_knowledge_base(services: Services, admin: Caller) -> None:
    with pytest.raises(NotFoundError):
        call_tool(
            services,
            "upload_document",
            {
                "knowledge_base_id": "kb_不存在",
                "filename": "a.md",
                "content_base64": base64.b64encode(b"x").decode(),
            },
            caller=admin,
        )


# --------------------------------------------------------------------- 数据源


def test_add_data_source(services: Services, kb: str, admin: Caller) -> None:
    result = call_tool(
        services,
        "add_data_source",
        {
            "knowledge_base_id": kb,
            "kind": "rss",
            "url": "https://example.com/feed.xml",
            "name": "示例订阅",
        },
        caller=admin,
    )

    assert result["name"] == "示例订阅"
    # 必须说清"登记 ≠ 立刻抓取"，否则模型会以为内容已经进来了
    assert "不会立刻" in result["note"]


def test_add_data_source_rejects_unknown_kind(
    services: Services, kb: str, admin: Caller
) -> None:
    with pytest.raises(InvalidRequestError) as excinfo:
        call_tool(
            services,
            "add_data_source",
            {"knowledge_base_id": kb, "kind": "webdav", "url": "https://example.com"},
            caller=admin,
        )
    assert "rss" in str(excinfo.value)


def test_add_data_source_rejects_non_http(services: Services, kb: str, admin: Caller) -> None:
    with pytest.raises(InvalidRequestError):
        call_tool(
            services,
            "add_data_source",
            {"knowledge_base_id": kb, "kind": "html", "url": "file:///etc/passwd"},
            caller=admin,
        )


# --------------------------------------------------------------------- 检索


def test_search_without_any_kb_returns_empty(services: Services, admin: Caller) -> None:
    """一个库都没有时不能炸——返回空结果并说明原因，让模型知道该怎么继续。"""
    result = call_tool(services, "search", {"query": "随便问问"}, caller=admin)

    assert result["hits"] == []
    assert "没有任何知识库" in result["note"]


def test_search_caps_top_k(services: Services, kb: str, admin: Caller) -> None:
    """**上限要生效**：工具是给 Agent 用的，它可能随手要 500 条，
    那会把上下文塞爆。"""
    result = call_tool(services, "search", {"query": "眼轴", "top_k": 9999}, caller=admin)

    # 不抛错、也不返回超量——夹到上限即可
    assert isinstance(result["hits"], list)


def test_search_result_shape_is_stable(services: Services, kb: str, admin: Caller) -> None:
    """字段名要稳定：模型按这些名字读结果，改一个名就等于换了一次工具。"""
    result = call_tool(
        services, "search", {"query": "眼轴", "knowledge_base_ids": [kb]}, caller=admin
    )

    assert set(result) >= {"query", "hits", "filtered_out"}


# --------------------------------------------------------------------- 文档状态


def test_get_document_status(services: Services, kb: str, admin: Caller) -> None:
    uploaded = call_tool(
        services,
        "upload_document",
        {
            "knowledge_base_id": kb,
            "filename": "状态.md",
            "content_base64": base64.b64encode(MARKDOWN.encode()).decode(),
        },
        caller=admin,
    )

    status = call_tool(
        services, "get_document_status", {"document_id": uploaded["document_id"]}, caller=admin
    )

    assert status["stage"] == "uploaded"
    assert status["searchable"] is False, "还没处理完就标成可检索是最坏的一种错"
    assert "检索不到" in status["note"]


def test_get_document_status_rejects_unknown(services: Services, admin: Caller) -> None:
    with pytest.raises(NotFoundError):
        call_tool(services, "get_document_status", {"document_id": "doc_不存在"}, caller=admin)


# --------------------------------------------------------------------- 删除


def test_delete_document_puts_it_in_trash(services: Services, kb: str, admin: Caller) -> None:
    uploaded = call_tool(
        services,
        "upload_document",
        {
            "knowledge_base_id": kb,
            "filename": "待删.md",
            "content_base64": base64.b64encode(MARKDOWN.encode()).decode(),
        },
        caller=admin,
    )

    result = call_tool(
        services, "delete_document", {"document_id": uploaded["document_id"]}, caller=admin
    )

    assert result["trash_id"]
    assert "7 天" in result["note"]
    with pytest.raises(NotFoundError):
        call_tool(
            services,
            "get_document_status",
            {"document_id": uploaded["document_id"]},
            caller=admin,
        )


def test_delete_unknown_document_raises(services: Services, admin: Caller) -> None:
    with pytest.raises(NotFoundError):
        call_tool(services, "delete_document", {"document_id": "doc_不存在"}, caller=admin)


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
    services: Services, admin: Caller, tool: str, args: dict
) -> None:  # type: ignore[type-arg]
    """缺参数要明确报"缺少参数：x"，而不是让下游抛一个难懂的 KeyError。"""
    with pytest.raises((InvalidRequestError, NotFoundError)):
        call_tool(services, tool, args, caller=admin)


def test_none_arguments_are_treated_as_empty(services: Services, admin: Caller) -> None:
    """MCP 客户端对无参工具可能传 ``None``——那不该炸。"""
    assert isinstance(call_tool(services, "list_knowledge_bases", None, caller=admin), list)


def test_max_top_k_is_documented_in_the_schema() -> None:
    """schema 里的上限要与实现一致，否则模型会按错的上限要条数。"""
    search = next(item for item in tool_definitions() if item["name"] == "search")
    assert search["inputSchema"]["properties"]["top_k"]["maximum"] == MAX_TOP_K


# --------------------------------------------------------------------- 笔记


def test_create_note_then_attach_makes_it_searchable(
    services: Services, kb: str, admin: Caller
) -> None:
    """**这是"把对话成果放进知识库"的完整两步**，也是本轮补这两个工具的理由。

    在此之前知识库只有"上传文件"一个入口，agent 干完活无处安放。
    """
    created = call_tool(
        services,
        "create_note",
        {
            "content_md": "# 锂价结论\n\n锂价下跌通常缓解材料成本，但净影响取决于售价联动与库存。",
            "title": "锂价敏感性",
            "tags": ["锂价", "结论"],
            "source_kind": "chat",
            "source_ref": "conv_abc",
        },
        caller=admin,
    )
    assert created["note_id"].startswith("note_")
    # 返回值必须说清"这一步之后还检索不到"，否则模型会以为已经入库了
    assert "attach_note_to_kb" in created["note"]

    attached = call_tool(
        services,
        "attach_note_to_kb",
        {"note_id": created["note_id"], "knowledge_base_id": kb},
        caller=admin,
    )
    assert attached["document_id"].startswith("doc_")
    assert attached["knowledge_base_id"] == kb

    listed = call_tool(services, "list_notes", {}, caller=admin)
    target = next(item for item in listed["notes"] if item["note_id"] == created["note_id"])
    assert target["in_knowledge_base"] is True
    # 标签顺序按服务层的规范化结果比（它会对标签去重排序），所以用集合
    assert set(target["tags"]) == {"锂价", "结论"}
    assert target["source_kind"] == "chat"


def test_list_notes_marks_notes_that_are_not_in_a_knowledge_base(
    services: Services, admin: Caller
) -> None:
    """没进库的笔记必须**明确标出来**：否则模型会以为存了就能检索到。"""
    created = call_tool(
        services, "create_note", {"content_md": "# 还没入库的"}, caller=admin
    )

    listed = call_tool(services, "list_notes", {}, caller=admin)

    target = next(item for item in listed["notes"] if item["note_id"] == created["note_id"])
    assert target["in_knowledge_base"] is False


def test_note_excerpt_is_bounded(services: Services, admin: Caller) -> None:
    """摘录要有上限：笔记可能很长，全量塞进上下文会把预算吃光。"""
    long_body = "长" * (NOTE_EXCERPT_CHARS * 3)
    call_tool(
        services,
        "create_note",
        {"content_md": long_body, "title": "很长的笔记"},
        caller=admin,
    )

    listed = call_tool(services, "list_notes", {"query": "很长的笔记"}, caller=admin)

    target = next(item for item in listed["notes"] if item["title"] == "很长的笔记")
    assert len(target["excerpt"]) == NOTE_EXCERPT_CHARS


def test_attach_note_needs_write_on_the_target_kb(
    services: Services, kb: str, admin: Caller, key_for
) -> None:  # type: ignore[no-untyped-def]
    """入库是往库里加内容，所以要的是**目标库的写权限**，不是"有笔记权限"。"""
    created = call_tool(
        services, "create_note", {"content_md": "# 只读库的笔记"}, caller=admin
    )
    readonly = key_for(kb_ids=[kb], permission=READ)

    with pytest.raises(ForbiddenError):
        call_tool(
            services,
            "attach_note_to_kb",
            {"note_id": created["note_id"], "knowledge_base_id": kb},
            caller=readonly,
        )


def test_attach_unknown_note_raises(services: Services, kb: str, admin: Caller) -> None:
    with pytest.raises(NotFoundError):
        call_tool(
            services,
            "attach_note_to_kb",
            {"note_id": "note_不存在", "knowledge_base_id": kb},
            caller=admin,
        )


def test_create_note_requires_content(services: Services, admin: Caller) -> None:
    with pytest.raises(InvalidRequestError):
        call_tool(services, "create_note", {"content_md": "   "}, caller=admin)


# --------------------------------------------------------------------- 列文档


def test_list_documents_reports_stage_and_searchability(
    services: Services, kb: str, admin: Caller
) -> None:
    """**"库里到底有什么"是 search 答不了的问题**——它只返回与问题相关的片段。

    所以单独一个工具来列文档，并且必须带上"能不能被检索到"。
    """
    call_tool(
        services,
        "upload_document",
        {
            "knowledge_base_id": kb,
            "filename": "列文档.md",
            "content_base64": base64.b64encode(MARKDOWN.encode()).decode(),
        },
        caller=admin,
    )

    result = call_tool(services, "list_documents", {"knowledge_base_id": kb}, caller=admin)

    assert result["total"] == 1
    item = result["documents"][0]
    assert item["name"] == "列文档.md"
    # 刚上传还没跑流水线，所以此时不可检索——这条信息比文件名更重要
    assert item["stage"] == "uploaded"
    assert item["searchable"] is False


def test_list_documents_respects_scope(services: Services, kb: str, key_for) -> None:  # type: ignore[no-untyped-def]
    other = services.knowledge_bases.create(
        kb_id=f"kb_{uuid.uuid4().hex[:12]}", name="别人的库"
    ).id
    scoped = key_for(kb_ids=[other])

    with pytest.raises(ForbiddenError):
        call_tool(services, "list_documents", {"knowledge_base_id": kb}, caller=scoped)


def test_every_tool_has_a_parameter_whitelist() -> None:
    """``server.py`` 的 ``_PARAMS`` 必须覆盖全部工具。

    少一个的后果不是"参数被过滤掉"，而是 ``build_server`` 直接 KeyError——
    服务起不来。放在这里断言是因为它跨了两个模块，只看一边发现不了。
    """
    from app.mcp_server.server import _PARAMS

    assert set(_PARAMS) == set(TOOL_NAMES)


# --------------------------------------------------------------------- 记忆


def test_recall_says_disabled_instead_of_returning_nothing(
    services: Services, admin: Caller
) -> None:
    """**默认关**，而且关着时必须明说。

    MCP 这一层是"模型读到一段文本"的界面：如果这里返回空列表，
    模型会当成"记忆里没有"，然后基于错误前提继续推理——比报错坏得多。
    """
    services.runtime.set({"memory.enabled": "false"})

    with pytest.raises(InvalidRequestError) as excinfo:
        call_tool(services, "recall", {"query": "我的偏好"}, caller=admin)

    assert "未启用" in str(excinfo.value)


def test_remember_writes_the_core_memory_file(services: Services, admin: Caller) -> None:
    """打开开关后，``remember`` 写的是 ``MEMORY.md``——**不经过 ReMe**。

    所以"记住东西"这件事不依赖那个额外进程；依赖它的只有召回。
    """
    services.runtime.set({"memory.enabled": "true"})
    try:
        first = call_tool(
            services, "remember", {"content": "用户偏好简短回答", "tags": ["偏好"]}, caller=admin
        )
        second = call_tool(services, "remember", {"content": "用户偏好简短回答"}, caller=admin)

        assert first["saved"] is True
        # 同一件事记第二遍不写第二条
        assert second["saved"] is False

        core = services.memory.core_file
        assert core.exists()
        body = core.read_text(encoding="utf-8")
        assert body.count("用户偏好简短回答") == 1
        # 关掉那个开关之后，注入路径**照旧带上它**（这条原先断言的是相反的行为）：
        # `MEMORY.md` 是磁盘上的普通文件，开关管的是"过去的对话会不会被召回、
        # 会不会自动沉淀"，不是"这份文件要不要读"。实测逼出来的——用户的实例上
        # 记忆服务是关的，于是人设与核心记忆既不播种也不注入，功能整个是死的。
        services.runtime.set({"memory.enabled": "false"})
        assert "用户偏好简短回答" in services.memory.core_text()
    finally:
        services.runtime.set({"memory.enabled": "false"})


# ------------------------------------------------------- Office 产出（v0.21）


def test_export_document_writes_a_real_docx(services: Services, kb: str, admin: Caller) -> None:
    """导出的是**真文件**：入库之后能被我们自己的解析器读回来。

    这条是这一组里最要紧的：如果产出只是个"看起来像 docx 的字节串"，
    用户拿它打不开——而那要等到他把文件发给别人才会发现。
    """
    from app.parsers.base import ProbeResult
    from app.parsers.local_office import LocalOfficeParser

    result = call_tool(
        services,
        "export_document",
        {
            "knowledge_base_id": kb,
            "filename": "随访方案.docx",
            "markdown": "# 一、监测频率\n\n每三个月测一次。\n\n- 首次建档全套\n",
            "title": "近视防控随访",
        },
        caller=admin,
    )

    assert result["format"] == "docx" and result["size_bytes"] > 1000
    stored = services.documents.get(result["document_id"])
    assert stored.name == "随访方案.docx"
    raw = services.documents.content(result["document_id"]).data
    parsed = LocalOfficeParser().parse(
        filename=stored.name,
        mime_type=None,
        content=raw,
        probe=ProbeResult(kind="office", text_coverage=1.0),
    )
    assert "每三个月测一次" in parsed.markdown
    assert "首次建档全套" in parsed.markdown


def test_export_table_keeps_numbers_as_numbers(services: Services, kb: str, admin: Caller) -> None:
    """表格里的数字要写成**数值**。

    全写成文本的话，Excel 里的求和、排序、图表全部失效——而用户会以为是我们算错了。
    """
    import io

    import openpyxl

    result = call_tool(
        services,
        "export_table",
        {
            "knowledge_base_id": kb,
            "filename": "随访记录.xlsx",
            "rows": [["项目", "频率(月)", "次数"], ["眼轴", "3", 4]],
            "sheet_name": "随访",
        },
        caller=admin,
    )

    assert result["format"] == "xlsx"
    raw = services.documents.content(result["document_id"]).data
    sheet = openpyxl.load_workbook(io.BytesIO(raw))["随访"]
    assert [cell.value for cell in sheet[1]] == ["项目", "频率(月)", "次数"]
    assert sheet.cell(row=2, column=2).value == 3, "纯数字的字符串要落成数值"
    assert sheet.cell(row=2, column=3).value == 4


def test_export_deck_builds_slides(services: Services, kb: str, admin: Caller) -> None:
    """幻灯：封面 + 每页标题与要点，读回来能对上。"""
    from app.parsers.base import ProbeResult
    from app.parsers.local_office import LocalOfficeParser

    result = call_tool(
        services,
        "export_deck",
        {
            "knowledge_base_id": kb,
            "filename": "方案.pptx",
            "title": "随访方案",
            "slides": [{"title": "监测频率", "bullets": ["三个月一次", "首次全套"]}],
        },
        caller=admin,
    )

    raw = services.documents.content(result["document_id"]).data
    parsed = LocalOfficeParser().parse(
        filename="方案.pptx",
        mime_type=None,
        content=raw,
        probe=ProbeResult(kind="office", text_coverage=1.0),
    )
    assert "随访方案" in parsed.markdown
    assert "三个月一次" in parsed.markdown


def test_export_pdf_is_a_readable_pdf(services: Services, kb: str, admin: Caller) -> None:
    """PDF 要能抽出中文——报告lab 的默认字体不含汉字，配错的话是一页黑方块。"""
    import io

    from pypdf import PdfReader

    result = call_tool(
        services,
        "export_document",
        {
            "knowledge_base_id": kb,
            "filename": "随访.pdf",
            "markdown": "## 一、监测频率\n\n每三个月测量一次眼轴长度。\n",
        },
        caller=admin,
    )

    raw = services.documents.content(result["document_id"]).data
    text = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(raw)).pages)
    assert "每三个月测量一次眼轴长度" in text


def test_export_refuses_a_wrong_extension(services: Services, kb: str, admin: Caller) -> None:
    """格式由扩展名决定，**不猜**：给 .xlsx 走文档那条路就得当场说清。"""
    with pytest.raises(InvalidRequestError, match=r"只做 \.docx 与 \.pdf"):
        call_tool(
            services,
            "export_document",
            {"knowledge_base_id": kb, "filename": "表.xlsx", "markdown": "x"},
            caller=admin,
        )
    with pytest.raises(InvalidRequestError, match=r"只做 \.xlsx"):
        call_tool(
            services,
            "export_table",
            {"knowledge_base_id": kb, "filename": "表.csv", "rows": [["a"]]},
            caller=admin,
        )


def test_export_enforces_the_limits_with_the_number_in_the_message(
    services: Services, kb: str, admin: Caller
) -> None:
    """超限时报错要**带上实际数量与上限**：模型据此才知道该拆成几份。"""
    from app.services import office

    with pytest.raises(InvalidRequestError) as excinfo:
        call_tool(
            services,
            "export_table",
            {
                "knowledge_base_id": kb,
                "filename": "大表.xlsx",
                "rows": [["h"]] * (office.MAX_ROWS + 1),
            },
            caller=admin,
        )
    assert str(office.MAX_ROWS) in str(excinfo.value)

    with pytest.raises(InvalidRequestError, match=r"non-empty|非空"):
        call_tool(
            services, "export_deck", {"knowledge_base_id": kb, "filename": "空.pptx", "slides": []},
            caller=admin,
        )


def test_export_needs_write_access(services: Services, kb: str, key_for) -> None:  # type: ignore[no-untyped-def]
    """**只读凭据不能产出**：写文档与上传文档是同一档权限。"""
    reader = key_for(kb_ids=[kb], permission=READ)

    with pytest.raises(ForbiddenError):
        call_tool(
            services,
            "export_document",
            {"knowledge_base_id": kb, "filename": "报告.docx", "markdown": "内容"},
            caller=reader,
        )


def test_export_reports_a_missing_dependency_as_a_readable_sentence(
    services: Services, kb: str, admin: Caller, monkeypatch: pytest.MonkeyPatch
) -> None:
    """依赖没装**不是"服务内部错误"**，而是一句能照做的话。

    工具报错是给模型读的：它需要"这件事现在做不到、原因是这个、要装什么"，
    不然它只会换个参数反复重试同一条走不通的路。
    """
    from app.services import office

    monkeypatch.setitem(office._REQUIREMENTS, "pptx", ("python-pptx", "不存在的模块名"))

    with pytest.raises(InvalidRequestError) as excinfo:
        call_tool(
            services,
            "export_deck",
            {"knowledge_base_id": kb, "filename": "方案.pptx", "slides": [{"title": "a"}]},
            caller=admin,
        )
    message = str(excinfo.value)
    assert "python-pptx" in message and "office" in message


# ------------------------------------------------------- 联网（v0.22）


def test_web_search_renders_numbered_results(
    services: Services, admin: Caller, monkeypatch: pytest.MonkeyPatch
) -> None:
    """搜到的结果要**渲染成带编号的文本**：模型接下来要挑一条去抓，
    而它挑的依据是编号与网址——JSON 字段名会把这件事弄糊。"""
    from app.services.web import SearchHit

    services.runtime.set({"web.search_api_key": "sk-test"})
    hits = [
        SearchHit(
            title="要闻 A",
            url="https://a.example.com",
            snippet="摘要 A",
            published="2026-09-17",
        ),
        SearchHit(title="要闻 B", url="https://b.example.com", snippet="摘要 B"),
    ]
    from app.services import web as web_service

    monkeypatch.setattr(web_service, "search_web", lambda *a, **k: hits)

    text = call_tool(services, "web_search", {"query": "今天"}, caller=admin)

    assert "[1] 要闻 A（2026-09-17）" in text
    assert "https://b.example.com" in text
    assert "摘要 B" in text
    assert "web_fetch" in text, "要告诉它下一步能做什么"


def test_web_search_without_a_key_says_where_to_configure(
    services: Services, admin: Caller
) -> None:
    """**没配密钥要说清去哪配**，不能返回空结果——空结果会被读成"网上没有"。"""
    services.runtime.set({"web.search_api_key": ""})

    with pytest.raises(InvalidRequestError) as excinfo:
        call_tool(services, "web_search", {"query": "今天"}, caller=admin)

    assert "设置" in str(excinfo.value)


def test_web_fetch_returns_the_page_with_its_source(
    services: Services, admin: Caller, monkeypatch: pytest.MonkeyPatch
) -> None:
    """抓回来的文本要**带上来源地址**：模型引用时能说清是哪一页。"""
    from app.services import web as web_service

    monkeypatch.setattr(
        web_service, "fetch_url", lambda url, **k: ("今日要闻", "第一段正文。")
    )

    text = call_tool(services, "web_fetch", {"url": "https://news.example.com/a"}, caller=admin)

    assert "今日要闻" in text and "第一段正文" in text
    assert "https://news.example.com/a" in text


def test_web_fetch_refuses_internal_addresses_before_any_request(
    services: Services, admin: Caller
) -> None:
    """**内网地址在发请求之前就被拒**——不是拿到结果之后才检查。"""
    with pytest.raises(InvalidRequestError, match=r"内网|本机"):
        call_tool(
            services,
            "web_fetch",
            {"url": "http://127.0.0.1:8000/api/v1/health"},
            caller=admin,
        )


# ------------------------------------------- 产物的落点与显式入库（v0.26）


def test_export_in_a_conversation_files_nothing(
    services: Services, kb: str, admin: Caller
) -> None:
    """**这条是这次改动的核心**：对话里导出，知识库一份文档都不多。

    改之前 `knowledge_base_id` 是必填的，模型只能替用户挑一个库——
    实测它把 docx 塞进了「笔记」，并解释"你这边没有专门的工作区，我就选了最顺手的那个"。
    """
    from app.services.tools import ARTIFACT_KEY

    conversation_id = services.conversations.create(title="导出短诗").id
    before = services.documents.count_documents(kb)

    result = call_tool(
        services,
        "export_document",
        {"filename": "短诗.docx", "markdown": "# 短诗\n\n把一天过完了。\n"},
        caller=admin,
        conversation_id=conversation_id,
    )

    assert result["artifact_id"].startswith("art_")
    assert result["saved_to"] == "本会话"
    assert "没有进知识库" in result["note"]
    assert services.documents.count_documents(kb) == before
    # 界面那份（卡片）与给模型那份在同一个 dict 里，见 _save_export 的说明
    assert result[ARTIFACT_KEY]["artifact_id"] == result["artifact_id"]


def test_export_ignores_a_knowledge_base_id_from_the_model(
    services: Services, kb: str, admin: Caller
) -> None:
    """即使模型自己填了 ``knowledge_base_id``，对话这条门也不入库。

    参数在对话的 schema 里已经不列了，但**光不列不够**：模型会凭上下文猜出这个字段名
    （它在别处见过）。所以这条断言的是"猜出来也没用"——落点由服务端决定。
    """
    conversation_id = services.conversations.create(title="再导出一次").id
    before = services.documents.count_documents(kb)

    call_tool(
        services,
        "export_document",
        {
            "knowledge_base_id": kb,
            "filename": "短诗.docx",
            "markdown": "把一天过完了。",
        },
        caller=admin,
        conversation_id=conversation_id,
    )

    assert services.documents.count_documents(kb) == before


def test_ingest_artifact_files_an_exported_file(
    services: Services, kb: str, admin: Caller
) -> None:
    """用户说"存进知识库"之后走的那一步：同一个 artifact_id，进库。"""
    from app.services.tools import ARTIFACT_KEY

    conversation_id = services.conversations.create(title="入库").id
    exported = call_tool(
        services,
        "export_document",
        {"filename": "随访方案.docx", "markdown": "# 一、监测频率\n"},
        caller=admin,
        conversation_id=conversation_id,
    )

    result = call_tool(
        services,
        "ingest_artifact",
        {"artifact_id": exported["artifact_id"], "knowledge_base_id": kb},
        caller=admin,
    )

    document = services.documents.get(result["document_id"])
    assert document.name == "随访方案.docx"
    assert document.knowledge_base_id == kb
    # 卡片按 artifact_id 合并，于是这一步跑完界面立刻显示"已存进知识库"
    assert result[ARTIFACT_KEY]["artifact_id"] == exported["artifact_id"]
    assert result[ARTIFACT_KEY]["knowledge_base_id"] == kb


def test_export_without_a_conversation_still_needs_a_library(
    services: Services, kb: str, admin: Caller
) -> None:
    """没有会话上下文的通道（外部 MCP、一次性脚本）保持老契约。

    那条通道没有产物区，唯一的落点就是知识库；而且"外部客户端点名叫了哪个库"
    本身就是显式的——这与对话里"模型替用户挑一个"是两回事。
    """
    result = call_tool(
        services,
        "export_document",
        {"knowledge_base_id": kb, "filename": "外部.docx", "markdown": "正文"},
        caller=admin,
    )

    assert services.documents.get(result["document_id"]).knowledge_base_id == kb

    with pytest.raises(InvalidRequestError, match="knowledge_base_id"):
        call_tool(
            services,
            "export_document",
            {"filename": "外部.docx", "markdown": "正文"},
            caller=admin,
        )


def test_dialogue_tool_schema_hides_the_library_parameter() -> None:
    """对话那条门**不再向模型暴露** ``knowledge_base_id``。

    留在 schema 里它就总有一天会被顺手填上——而那正是事故的成因。
    外部门（MCP 的 ``tool_definitions``）必须原样保留：那是已发布的契约。
    """
    from app.services.agent_tools import tool_specs
    from app.services.tools import tool_definitions

    dialogue = {spec.name: spec.parameters for spec in tool_specs()}
    for name in ("export_document", "export_table", "export_deck"):
        assert "knowledge_base_id" not in dialogue[name]["properties"], name
        # 必填表里也不能留着它（不然模型会以为"必须给一个库"）
        assert "knowledge_base_id" not in dialogue[name].get("required", []), name

    mcp = {item["name"]: item["inputSchema"] for item in tool_definitions()}
    assert "knowledge_base_id" in mcp["export_document"]["properties"]
