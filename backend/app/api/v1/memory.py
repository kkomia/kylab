"""记忆端点（v0.14 三期，设计见 ``docs/记忆层设计-v0.1.md``）。

三件事：看状态、用记忆（召回/记住）、改记忆（浏览/编辑文件、看图谱）。

**记忆与知识库是两个池子**（设计文档 §2.1），这里的一切都只碰记忆那一侧：
没有任何一个端点会去读文档、片段或向量。``GET /memory`` 列的是工作区里的
Markdown 文件，不是知识库文档。

**鉴权档位与 MCP 那份保持一致**（读用 ``ReadDep``、写用 ``WriteDep``）：
MCP 上 ``recall`` / ``remember`` 对 API Key 是开放的（外部 agent 得能用记忆），
REST 这边如果收紧成管理员专属，同一串 API Key 从两个入口进来就会得到两种答案
——那正是 ``api/auth.py`` 里说的"两处各写一份就不会有测试同时看到"的不一致。
**记忆目前是整个部署共用的一份**（设计文档 §5 的已知边界），这件事由界面明说，
不在这里用一道假的门禁来暗示它已经被隔离好了。

**浏览与编辑走本地目录**，因此 ``memory.enabled`` 关着也能用（理由见
``services/memory_files.py`` 的模块头）。只有召回、记住、重建索引需要服务活着。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, status

from app.api.auth import require_admin, require_read, require_write
from app.api.v1.schemas import (
    MemoryActionOut,
    MemoryFileDetailOut,
    MemoryFileOut,
    MemoryFileWriteIn,
    MemoryGraphNodeOut,
    MemoryGraphOut,
    MemoryHitOut,
    MemoryLinkOut,
    MemoryOverviewOut,
    MemoryProbeOut,
    MemoryRecallIn,
    MemoryRecallOut,
    MemoryRememberIn,
    MemoryRememberOut,
    MemoryStatusOut,
)
from app.core.services import Services, get_services
from app.services.api_key import Caller

router = APIRouter(prefix="/memory", tags=["memory"])

#: 召回结果里那条提醒，**与 MCP 工具的 ``note`` 同一句**。
#: 写两份的话，模型从 MCP 听到的和人在界面上看到的就是两种说法。
RECALL_NOTE = (
    "这是**记忆**（过去对话里沉淀下来的结论与偏好），不是知识库原文。"
    "需要可引用的原文依据时用知识库检索。"
)


def _scope(caller: Caller) -> str | None:
    """**这个调用者的记忆属于谁**——"一个账号一个 Agent"在记忆层的落点。

    普通成员 → 自己的账号（各自一份 ``data/memory/<user_id>/``）；
    管理员会话与 API Key 通道 → ``None``（共享桶，即 ``data/memory/`` 本身）。

    与知识库 / 会话 / 笔记的归属口径一致（见 ``api/auth.py``）：
    管理员用网页会话要能看到全部，所以不能折成"管理员=自己的账号"。
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
        links=list(record.links),
        retrievable=record.retrievable,
        # "会被注入"是**核心文件**的专属性质（每轮进 system prompt，见 §2.5），
        # 由 kind 推出来而不是让存储层再多记一个字段——两处记同一件事迟早不一致。
        injected=record.is_core,
        consolidated=record.consolidated,
    )


def _status_out(record, files) -> MemoryStatusOut:  # type: ignore[no-untyped-def]
    """状态 + 由文件列表算出的三个计数。

    计数在这里算（而不是让前端 filter）：**"哪些还没被整合"这件事的判据
    在服务层**（``MemoryFile.consolidated`` 怎么来的只有那边知道），
    前端只该显示数字。
    """
    return MemoryStatusOut(
        enabled=record.enabled,
        base_url=record.base_url,
        workspace=record.workspace,
        core_file_exists=record.core_file_exists,
        reachable=record.reachable,
        detail=record.detail,
        file_count=len(files),
        retrievable_count=sum(1 for item in files if item.retrievable),
        unconsolidated_count=sum(
            1 for item in files if item.kind == "daily" and not item.consolidated
        ),
    )


@router.get("", response_model=MemoryOverviewOut, summary="记忆状态与文件列表")
def get_memory(
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> MemoryOverviewOut:
    """一次给全页面首屏要的东西（状态 + 文件列表）。

    **不打远端**（``status`` 而不是 ``probe``）：状态栏每次刷新都调它，
    顺手打一次记忆服务会让"打开记忆页"变成一次网络等待。
    """
    files = services.memory.files(_scope(caller))
    status_out = _status_out(services.memory.status(), files)
    return MemoryOverviewOut(
        status=status_out,
        files=[_file_out(item) for item in files],
        # 服务层的扫描上限（见 memory_files.MAX_LISTED_FILES）
        truncated=len(files) >= services.memory.scan_limit,
    )


@router.get("/files/{path:path}", response_model=MemoryFileDetailOut, summary="读一个记忆文件")
def read_memory_file(
    path: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> MemoryFileDetailOut:
    """读原文（含 frontmatter）。

    路径里的 ``path:path`` 让 ``digest/wiki/xxx.md`` 这种带斜杠的路径能当**一个**
    路径参数传进来，前端不必把斜杠编码成 ``%2F``（有些反代会先解开再匹配，反而更脆）。
    """
    detail = services.memory.file_text(path, _scope(caller))
    base = _file_out(services.memory.describe(detail.path, _scope(caller)))
    return MemoryFileDetailOut(
        # ``consolidated`` 是**跨文件**才知道的事（要看书里有没有 digest 链过来），
        # 而读一个文件不该去扫整个工作区。这里显式给 None = "这次没算"，
        # 而不是留一个恒为 False 的值让界面显示成"未整合"——那是在说假话。
        **{**base.model_dump(), "consolidated": None},
        content=detail.content,
        meta=detail.meta,
        truncated=detail.truncated,
    )


@router.put(
    "/files/{path:path}",
    response_model=MemoryFileDetailOut,
    summary="写入（覆盖）一个记忆文件",
)
def write_memory_file(
    path: str,
    payload: MemoryFileWriteIn,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> MemoryFileDetailOut:
    """整份覆盖。文件不存在就**新建**（要能新建整合笔记，见服务层 ``write_file``）。

    索引不在这里管：ReMe 自己有文件守护会追（实测 5 秒 debounce），
    而它的 ``reindex`` 看不见新文件（"without rescanning workspace files"）。
    """
    services.memory.write_file(path, payload.content, _scope(caller))
    return read_memory_file(path, services=services, caller=caller)


@router.delete(
    "/files/{path:path}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除一个记忆文件",
)
def delete_memory_file(
    path: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> None:
    services.memory.delete_file(path, _scope(caller))


@router.get("/graph", response_model=MemoryGraphOut, summary="记忆的 wikilink 图谱")
def get_memory_graph(
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> MemoryGraphOut:
    """本地从正文里的 ``[[…]]`` 算出来（不调 ReMe 的 ``graph_snapshot``）。

    只画连上边的节点，孤立文件不进图——它们已经在文件列表里了，
    图要回答的是"结构"而不是"清单"（见 ``memory_files.graph_of``）。
    """
    graph = services.memory.graph(_scope(caller))
    return MemoryGraphOut(
        nodes=[
            MemoryGraphNodeOut(
                path=node.path, title=node.title, kind=node.kind, degree=node.degree
            )
            for node in graph.nodes
        ],
        edges=graph.edges,
        dangling=graph.dangling,
    )


@router.post("/recall", response_model=MemoryRecallOut, summary="在记忆里召回")
def recall_memory(
    payload: MemoryRecallIn,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> MemoryRecallOut:
    """与知识库检索**两条路、永不合并**（设计文档 §2.1）。

    记忆服务没起或没启用时**明确报错**，不返回空结果（§2.3）——返回空会让模型
    （和用户）以为"没有相关记忆"，然后基于错误前提继续。
    """
    hits, links = services.memory.recall(
        payload.query, limit=payload.limit, user_id=_scope(caller)
    )
    return MemoryRecallOut(
        query=payload.query,
        hits=[
            MemoryHitOut(
                text=item.text,
                path=item.path,
                start_line=item.start_line,
                end_line=item.end_line,
                score=item.score,
            )
            for item in hits
        ],
        links=[
            MemoryLinkOut(path=item.path, direction=item.direction, name=item.name)
            for item in links
        ],
        note=RECALL_NOTE,
    )


@router.post("/remember", response_model=MemoryRememberOut, summary="记一条长期事实")
def remember(
    payload: MemoryRememberIn,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> MemoryRememberOut:
    """写进 ``MEMORY.md``，**不经过 ReMe**（那条路径没有记忆服务也能工作，见服务层）。

    重复的一条返回 ``saved=false``，不是错误：那是"本来就有"，调用方据此不必再记一遍。
    """
    result = services.memory.remember(
        payload.content, tags=payload.tags, user_id=_scope(caller)
    )
    return MemoryRememberOut(
        saved=bool(result.get("saved")),
        entries=int(result.get("entries") or 0),
        reason=str(result.get("reason") or ""),
    )


@router.post("/reindex", response_model=MemoryActionOut, summary="请记忆服务重建索引")
def reindex(
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> MemoryActionOut:
    """手动兜底，不是保存流程的一环（见 ``MemoryService.write_file`` 的说明）。

    真正要它的时候是这一类：服务当时没起、用户改了一批文件，之后才把服务拉起来。
    """
    return MemoryActionOut(detail=services.memory.reindex(_scope(caller)))


@router.post("/probe", response_model=MemoryProbeOut, summary="测试记忆服务连通性")
def probe(
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_admin),
) -> MemoryProbeOut:
    """设置页的「测试连接」。

    **管理员专属**，与设置页其它"测试连接"同档：它打的是 ``memory.base_url``
    这个可配置地址，而那个地址由管理员填。用普通读权限放行，等于把
    "让服务端按我指定的地址发一个请求"这件事开放给任何成员。
    """
    status_out = services.memory.probe()
    return MemoryProbeOut(reachable=status_out.reachable, detail=status_out.detail)
