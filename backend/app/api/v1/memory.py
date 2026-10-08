"""记忆端点（v0.14 三期；v0.57 起后端是 **mem0**，见 ``services/memory.py``）。

四件事：看状态、按条目读写（列表 / 查 / 加 / 改 / 删 / 看历史）、跑一次旧档案迁移、
读一个文件的原文。

**记忆与知识库是两个池子**，这里的一切都只碰记忆那一侧：没有任何一个端点会去读文档、
片段或向量。``GET /memory`` 报的是**这一层的状态**（开没开、库在哪、几条、
向量是不是兜底），不是知识库文档。

**v0.57 删掉的端点**（档案制那一套的遗物）：``/recall`` / ``/remember`` / ``/forget``
（能力被下面的 ``/items`` 一族取代——**一个能力一个入口**，留着三套写入口只会让
"回执从哪儿来"变成三个答案）、``/archive`` / ``/changes`` / ``/restore`` / ``/group``
（分区读数、变更流、还原、项目组改名：这些概念随档案制一起退场）、
``/migrate`` / ``/draft/organize``（机械折叠与"整理初稿"：新库只有
``POST /memory/import-legacy`` 这一条迁移路，它**零模型调用**）。

**``GET /memory/files/{path}`` 保留**：记忆页上那节只读的「人设与旧档案」要展示磁盘上
那份 Markdown（``SOUL.md`` / ``AGENTS.md`` / 旧 ``PROFILE.md``）的原文。

**鉴权档位与 MCP 那份保持一致**（读用 ``ReadDep``、写用 ``WriteDep``）：
MCP 上 ``recall`` / ``remember`` / ``forget`` 对 API Key 是开放的（外部 agent 得能用记忆），
REST 这边如果收紧成管理员专属，同一串 API Key 从两个入口进来就会得到两种答案
——那正是 ``api/auth.py`` 里说的"两处各写一份就不会有测试同时看到"的不一致。

**浏览与编辑走本机存储与目录**，因此 ``memory.enabled`` 关着也能用。
只有**注入与 recall** 看那个开关。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.auth import require_read, require_write
from app.api.v1.schemas import (
    MemoryFileDetailOut,
    MemoryFileOut,
    MemoryHistoryOut,
    MemoryImportOut,
    MemoryItemCreateIn,
    MemoryItemHistoryOut,
    MemoryItemOut,
    MemoryItemPatchIn,
    MemoryItemsOut,
    MemoryOverviewOut,
    MemoryStatusOut,
    MemoryWriteOut,
)
from app.core.caller import Caller
from app.core.services import Services, get_services
from app.services import tools as tools_service
from app.services.memory import MemoryItem, WriteResult

router = APIRouter(prefix="/memory", tags=["memory"])

#: 检索结果里那句提醒，**与工具那份是同一句**（共用同一个常量，不重写一遍）。
#: 写两份的话，模型从 MCP 听到的和人在界面上看到的就是两种说法。
RECALL_NOTE = tools_service.RECALL_NOTE

#: 一次列表 / 检索最多返回几条（界面上一屏消化不了的量没有意义）。
MAX_ITEMS_PAGE = 200


def _scope(caller: Caller) -> str | None:
    """**这个调用者的记忆属于谁**——"一个账号一个 Agent"在记忆层的落点。

    带账号的那一档 → 自己的账号（各自的库在 ``data/memory/<user_id>/mem0/``）；
    本机主人（管理员档）→ ``None``（服务层把它折成字面量 ``local``）。

    与知识库 / 会话 / 笔记的归属口径一致（见 ``api/auth.py``）：
    本机主人要能看到全部，所以不能折成"管理员=自己的账号"。
    """
    if caller.user is not None and not caller.is_admin:
        return caller.user.id
    return None


def _file_out(record) -> MemoryFileOut:  # type: ignore[no-untyped-def]
    """记录 → 响应。不 import 存储层类型（工程规范 §3.3 L1），
    形状由 services 返回的对象保证（与 wiki.py 的 ``_page_out`` 同一套写法）。"""
    return MemoryFileOut(
        path=record.path,
        name=record.name,
        title=record.title,
        kind=record.kind,
        summary=record.summary,
        tags=list(record.tags),
        size_bytes=record.size_bytes,
        modified_at=record.modified_at,
    )


def _status_out(record) -> MemoryStatusOut:  # type: ignore[no-untyped-def]
    """状态 → 响应。**全是服务层数出来的本地数字**（几条、上次改动、向量兜底没有），
    界面只该显示数字：这些数的口径只有服务层知道。
    """
    return MemoryStatusOut(
        enabled=record.enabled,
        workspace=record.workspace,
        items=record.items,
        last_changed_at=record.last_changed_at,
        embedder=record.embedder,
        development=record.development,
        detail=record.detail,
    )


def _item_out(item: MemoryItem) -> MemoryItemOut:
    return MemoryItemOut(
        id=item.id,
        text=item.text,
        section=item.section,
        source=item.source,
        created_at=item.created_at,
        updated_at=item.updated_at,
        score=item.score,
    )


def _write_out(result: WriteResult) -> MemoryWriteOut:
    """一次写入的结果 → 响应（加 / 改 / 删共用）。

    ``action`` 的三种"没写成"（``existing`` / ``rejected``）都**不是错误**：
    一个是"本来就有"，一个是"越线了、回执里给了出路"，所以它们照样 200，
    调用方按 ``action`` 分派。
    """
    return MemoryWriteOut(
        action=result.action,
        receipt=result.receipt,
        text=result.text,
        section=result.section,
        replaced=result.replaced,
        item_id=result.item_id,
    )


@router.get("", response_model=MemoryOverviewOut, summary="记忆状态")
def get_memory(
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> MemoryOverviewOut:
    """记忆页首屏要的状态。

    **状态是纯本地的**（数一遍库与工作区）：没有第二个进程、没有探测，
    所以"打开记忆页"不会变成一次网络等待。
    """
    return MemoryOverviewOut(status=_status_out(services.memory.status(_scope(caller))))


@router.get("/items", response_model=MemoryItemsOut, summary="列记忆条目 / 检索")
def list_memory_items(
    query: str = Query(default="", max_length=2000, description="给了就在库里检索，留空列全部"),
    limit: int = Query(default=0, ge=0, le=MAX_ITEMS_PAGE, description="最多返回几条"),
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> MemoryItemsOut:
    """界面上的条目列表：**给了 ``query`` 就在库里按意思检索，否则列全部**。

    检索与知识库那条路**是两条路、永不合并**（记忆是"对方说的"，文献是有出处的）；
    也不返回空冒充"没有"——库里真没有时才是空列表。

    列全部时按改动时间**倒序**（最近改的在前）：mem0 的 ``get_all`` 不承诺顺序，
    而"最近改的在前"是界面上唯一能预期的顺序。
    """
    items = services.memory.list_items(
        _scope(caller), query=query, limit=limit or None
    )
    return MemoryItemsOut(
        query=query,
        items=[_item_out(item) for item in items],
        total=len(items),
        note=RECALL_NOTE if query.strip() else "",
    )


@router.post("/items", response_model=MemoryWriteOut, summary="记一条（新增或更正）")
def create_memory_item(
    payload: MemoryItemCreateIn,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> MemoryWriteOut:
    """写进记忆库。**不经过任何外部东西**（``infer=False``：零模型调用）。

    三件事与工具那一侧**同源**：

    - **不看 ``memory.enabled``**：记忆关着时照样可写（打开就会被注入）；
    - **``replaces`` 让"更正"一次完成**：填要改掉的那条原文；
    - **返回体带 ``action`` 与 ``receipt``**：``action`` 是
      ``added`` / ``replaced`` / ``existing`` / ``rejected``，``receipt`` 是
      给人看的那一句——**界面与模型用的是同一句**，谁也不该自己另编。
    """
    result = services.memory.remember(
        payload.content,
        section=payload.section,
        replaces=payload.replaces or None,
        user_id=_scope(caller),
    )
    return _write_out(result)


@router.patch("/items/{item_id}", response_model=MemoryWriteOut, summary="改一条")
def update_memory_item(
    item_id: str,
    payload: MemoryItemPatchIn,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> MemoryWriteOut:
    """按 id 改一条（界面上点开来改的那条路）。

    ``content`` 留空 = 只改分区标签。两条与新增同源的检查（长度、敏感信息）
    照样生效：**换了一条路进来，判据不能松**。
    """
    result = services.memory.update_item(
        item_id,
        content=payload.content,
        section=payload.section,
        user_id=_scope(caller),
    )
    return _write_out(result)


@router.delete("/items/{item_id}", response_model=MemoryWriteOut, summary="删一条")
def delete_memory_item(
    item_id: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> MemoryWriteOut:
    """按 id 删一条。旧值留在 mem0 自己的历史里（要回看走 ``/history``）。"""
    return _write_out(services.memory.delete_item(item_id, _scope(caller)))


@router.get(
    "/items/{item_id}/history",
    response_model=MemoryItemHistoryOut,
    summary="一条记忆的历史",
)
def memory_item_history(
    item_id: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> MemoryItemHistoryOut:
    """这条记忆被改过什么（**最旧在前**）——mem0 自己的 ``history.db``。

    **只读**：v0.57 没有"还原"这条路（历史留着是为了让人看清"它以前是什么"）。
    """
    rows = services.memory.item_history(item_id, _scope(caller))
    return MemoryItemHistoryOut(
        id=item_id,
        items=[
            MemoryHistoryOut(
                at=row.at, event=row.event, old=row.old, new=row.new, deleted=row.deleted
            )
            for row in rows
        ],
    )


@router.post("/import-legacy", response_model=MemoryImportOut, summary="导入旧档案（零模型调用）")
def import_legacy_memory(
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> MemoryImportOut:
    """把旧 ``PROFILE.md`` 的四区条目搬进记忆库。

    **只读旧文件、只写新库**：``PROFILE.md`` 一字不动；可重跑、幂等
    （源指纹与水位一致时 ``skipped=true``，净改动为零）。
    **零模型调用**——它不请模型判断哪条该留，原样搬。
    """
    report = services.memory.import_legacy(_scope(caller))
    return MemoryImportOut(
        source=report.source,
        entries=report.entries,
        imported=report.imported,
        existing=report.existing,
        dropped_sensitive=report.dropped_sensitive,
        skipped=report.skipped,
        changed=report.changed,
    )


@router.get("/files/{path:path}", response_model=MemoryFileDetailOut, summary="读一个记忆文件")
def read_memory_file(
    path: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> MemoryFileDetailOut:
    """读原文（含 frontmatter）——人设文件（``SOUL.md`` / ``AGENTS.md``）与旧档案的只读查看。

    路径里的 ``path:path`` 让 ``digest/wiki/xxx.md`` 这种带斜杠的路径能当**一个**
    路径参数传进来，前端不必把斜杠编码成 ``%2F``（有些反代会先解开再匹配，反而更脆）。
    只认 ``.md``（见 ``memory_files.safe_path``）。
    """
    scope = _scope(caller)
    detail = services.memory.file_text(path, scope)
    base = _file_out(services.memory.describe(detail.path, scope))
    return MemoryFileDetailOut(
        **base.model_dump(),
        content=detail.content,
        meta=detail.meta,
        truncated=detail.truncated,
    )
