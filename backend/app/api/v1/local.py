"""本机档专属端点（M2 阶段 3、阶段 5）。

这个模块装三样东西，都是"**只在本机档成立**"的那几件：

1. ``GET /local/status``（`router`）——**我的数据在哪**。桌面壳与界面显示"本机运行时"
   那条状态条靠它（阶段 4 接线），排障时第一眼看的也是它：这一档的库文件在哪、
   多大、这一份进程接的是哪个 NAS。**只读、不建档**：打开一次界面不该把库建出来；
   阶段 5 起它还如实报"导入这件事"的两笔账：**没跑完的批次**（R1：可重跑续上）与
   **未随导入的文件引用数**（R4：文件本体留在 NAS 上）；
2. ``/local/import*``（`router`，阶段 5）——旧会话一次性导入与回滚的四条端点；
3. **两条薄重声明**（`chat_reads`）——``GET /conversations/{id}/events`` 与
   ``GET /chat/context-usage``。

## 为什么要"薄重声明"而不是整 include `chat.router`（M2 §4.2 照抄）

那两条**只读本机数据**（会话事件日志落在本机库的 `session_events` 表里，上下文用量按
会话历史与提示词现算），本机档完全服务得了；但它们住在 `api/v1/chat.py` 那个 router 里，
而同一个 router 还有**服务器专属**的 `/chat/stream`（它要检索、要模型代理、要会话事件
那一条完整链路）——整 include 就是**摆一条注定失败的路出来**（用户点得到、点下去 500），
而"摆出来的东西应当是能用的"是这个项目一以贯之的规矩（见 `sidecar.py` 的
`SIDECAR_TOOL_NAMES` 与 `agent_tools._KB_TOOLS`）。

所以这两条**按原路径重声明**：函数体一个字不重写 ✗（直接把 `chat.py` 里那两个端点函数
挂上来——同一份实现、同一套鉴权依赖、同一套归属判定），只是换一个 router 注册 ✓。

## ``/local/import*`` 的四条（阶段 5）

- ``POST /local/import``：开一个批次（``dry_run=true`` 时只看不写，返回"会怎么处理"）；
- ``GET /local/import/{batch_id}``：轮询进度（``imports.state`` + ``counts_json``；
  CLI 那侧开的批次一样查得到——账写在库里）；
- ``POST /local/import/{batch_id}/rollback``：按台账回滚（删新建的 / 快照恢复被替换的 /
  本机改过的保留）。

导入本身**跑在后台线程**里（几百条会话、要走网络，不能按在请求上），端点立刻返回批次 id；
回滚**跑完才返回**（它通常是秒级，而"撤销"这个动作用户要的是结果）。两条都把账写进
``imports`` / ``import_items``，所以 CLI 那侧开的批次在界面上一样看得到进度——
**两处的进度只有一个来源**（库里的那张表）。
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field

from app.api.auth import ReadDep, WriteDep
from app.api.v1 import chat
from app.core.config import Settings, get_settings
from app.core.exceptions import InvalidRequestError, NotFoundError
from app.core.services import Services, get_services
from app.core.storage import LOCAL_DB_NAME
from app.services.legacy_import import UNFINISHED_STATES, LegacyImporter

__all__ = ["chat_reads", "router"]

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/local", tags=["local"])

#: 两条薄重声明的落点。**没有前缀**：它们就在原来的路径上（理由见模块头）。
chat_reads = APIRouter(tags=["local"])


class ImportBatchBriefOut(BaseModel):
    """一个批次的摘要（``/local/status`` 里那几行）。"""

    batch_id: str
    state: str
    source: str = ""
    counts: dict[str, Any] = Field(default_factory=dict)
    error: str = ""
    updated_at: datetime | None = None


class LocalStatusOut(BaseModel):
    """本机档的运行态（只读）。"""

    deployment: str = Field(description="部署档：local = 会话落本机；server = NAS 上的服务器档")
    data_dir: str = Field(description="本机数据目录（沙箱、记忆、对象存储都在它下面）")
    database: str = Field(description="本机库文件（SQLite；-wal / -shm 与它同目录）")
    database_exists: bool = Field(description="库文件是否已经建出来（还没落过东西时为假）")
    database_bytes: int = Field(default=0, description="库文件字节数（0 = 还没建出来）")
    database_wal_bytes: int = Field(
        default=0,
        description="WAL 文件的字节数（它是流动的：检查点之后归零，别拿它当「库有多大」）",
    )
    server_url: str | None = Field(
        default=None, description="知识库/模型远端的基址；空 = 这一档没有接 NAS"
    )
    imports: list[ImportBatchBriefOut] = Field(
        default_factory=list, description="最近几个导入批次（新的在前）"
    )
    unfinished_imports: int = Field(
        default=0, description="没跑完的导入批次数（planned/running）：重跑同一来源即可续上"
    )
    unimported_file_references: int = Field(
        default=0,
        description="最近一次导入里**没有随导入过来**的文件引用数（产物 + 消息附件）",
    )
    note: str = Field(default="", description="这一档的能力边界（如实写）")


def _size_of(path: Path) -> int:
    """文件字节数；没有/读不到都当 0。

    刻意**不查库**：这是排障第一眼要看的那一页，而"库打不开"恰恰是最需要它的时刻——
    那时它更该答得上来（文件在不在、多大、WAL 积了多少），而不是跟着一起 500。
    """
    try:
        return path.stat().st_size
    except OSError:
        return 0


@router.get("/status", response_model=LocalStatusOut, summary="本机档状态（库在哪、接的是谁）")
def local_status(
    services: Annotated[Services, Depends(get_services)],
    settings: Annotated[Settings, Depends(get_settings)],
    caller: ReadDep,
) -> LocalStatusOut:
    """**我的数据在哪**：库文件、数据目录、远端两头，外加导入那两笔账。

    库路径与 ``core/storage.py`` 用的是**同一个字面量**（`LOCAL_DB_NAME`）与同一套优先级
    （``KYLAB_LOCAL_DB`` > ``<data_dir>/kylab.db``）：两处各写一份文件名，迟早会出现
    "状态页说 A、实际写 B"。

    导入那两笔账都是**如实报**（阶段 5）：

    - ``unfinished_imports``：库里还有 ``planned``/``running`` 的批次 = 上次导入没跑完
      （被杀、断电、网络断）。它们**可重跑续上**（会话级幂等），所以这里只说"有几笔账
      没结"，不去替用户重试；
    - ``unimported_file_references``：最近一次导入的报告里那个数（产物 + 消息附件）。
      它们指向 NAS 上的 key，**本体没有随导入过来**（R4 的取舍）——不说这个数，
      用户会以为文件也搬过来了。
    """
    data_dir = Path(settings.data_dir)
    database = Path(settings.local_db) if settings.local_db else data_dir / LOCAL_DB_NAME
    importer: LegacyImporter | None = services.legacy_import
    batches = importer.recent_batches(limit=5) if importer is not None else []
    briefs = [
        ImportBatchBriefOut(
            batch_id=item.id,
            state=item.state,
            source=item.source,
            counts=dict(item.counts),
            error=item.error,
            updated_at=item.updated_at,
        )
        for item in batches
    ]
    unfinished = sum(1 for item in briefs if item.state in UNFINISHED_STATES)
    references = int(briefs[0].counts.get("file_references") or 0) if briefs else 0
    return LocalStatusOut(
        deployment=settings.deployment,
        data_dir=str(data_dir),
        database=str(database),
        database_exists=database.exists(),
        database_bytes=_size_of(database),
        database_wal_bytes=_size_of(database.with_name(database.name + "-wal")),
        server_url=settings.server_url or None,
        imports=briefs,
        unfinished_imports=unfinished,
        unimported_file_references=references,
        note=(
            "会话 / 消息 / 事件 / 产物 / 笔记 / 设置 / 工作区落本机 SQLite；"
            "知识库（检索与入库）在 NAS 上，M3 接提供者。"
            "导入过来的产物与附件只留引用（`location` 是 NAS 上的 key），文件本体在本机没有。"
        ),
    )


# ---------------------------------------------------------------- 旧会话导入（阶段 5）


class ImportRequestIn(BaseModel):
    """导入请求。

    **来源与令牌不在这里**：它们从这一档的引导配置来（``KYLAB_SERVER_URL`` /
    ``KYLAB_TOKEN``，壳起边车时传的就是它们）。令牌再走一遍请求体只会多一条
    让它出现在日志里、或落进库里的路（R6 明写它不落库）。
    """

    since: datetime | None = Field(
        default=None, description="只导**严格晚于**这个时刻更新过的会话（增量）"
    )
    dry_run: bool = Field(default=False, description="true = 只报会怎么处理，一个字节都不写")


class ImportBatchOut(BaseModel):
    """批次的状态与计数（``dry_run`` 时带着"会怎么处理"，没有批次 id）。"""

    batch_id: str = ""
    state: str = ""
    source: str = ""
    dry_run: bool = False
    counts: dict[str, Any] = Field(default_factory=dict)
    error: str = ""
    updated_at: datetime | None = None


def _importer(services: Services) -> LegacyImporter:
    """取本机档的导入器；服务器档或没配来源时**如实报**，不装作能导。"""
    importer = services.legacy_import
    if importer is None:
        raise InvalidRequestError(
            "只有本机档能导入旧会话（服务器档的会话就是权威，没有「从别的部署导进来」这条动作）"
        )
    if not importer.source:
        raise InvalidRequestError(
            "本机档没有配 KYLAB_SERVER_URL：不知道从哪里导。请先在启动参数里给出 NAS 地址"
        )
    return importer


def _as_out(report: Any, *, dry_run: bool = False) -> ImportBatchOut:
    """报告 / 批次记录 → 响应模型（两种输入同名同形，所以只写一份映射）。

    ``report`` 允许是 ``ImportReport`` 或 ``ImportBatchRecord``：它们都带
    ``batch_id``/``state``/``counts``/``error`` 这几个字段——但类型住存储层
    （``app.storage.base``），而协议层不许 import 它（工程规范 §3.3 的 L1），
    所以这里按属性读，不写死类型。
    """
    return ImportBatchOut(
        batch_id=getattr(report, "batch_id", None) or getattr(report, "id", "") or "",
        state=str(getattr(report, "state", "") or ""),
        source=str(getattr(report, "source", "") or ""),
        dry_run=dry_run,
        counts=dict(getattr(report, "counts", {}) or {}),
        error=str(getattr(report, "error", "") or ""),
        updated_at=getattr(report, "updated_at", None),
    )


@router.post(
    "/import",
    response_model=ImportBatchOut,
    status_code=status.HTTP_202_ACCEPTED,
    summary="导入 NAS 上的旧会话（后台跑，返回批次 id 供轮询）",
)
def start_import(
    payload: ImportRequestIn,
    services: Annotated[Services, Depends(get_services)],
    caller: WriteDep,
) -> ImportBatchOut:
    """开一个导入批次。

    - ``dry_run=true``：**同步**算一遍"会新建/替换/跳过哪些"（要读完整条源端流，
      所以不写在库里，也不产批次 id）；
    - 否则**后台线程**里跑，这里立刻返回批次 id——几百条会话要走网络慢慢来，
      按在请求上只会撞超时，而进度本来就写在库里（``GET /local/import/{id}`` 轮询，
      CLI 那侧开的批次也一样查得到）。

    线程是 ``daemon``：边车退出时不该被一次导入吊住（未写完的会话没有台账，
    下次重跑就是接着导——R1 那条缓解）。
    """
    importer = _importer(services)
    if payload.dry_run:
        plan = importer.plan()
        return ImportBatchOut(
            state="planned",
            source=plan.source,
            dry_run=True,
            counts=plan.counts(),
        )
    # **先同步把批次行写进库**（`begin`）：客户端拿到 id 之后立刻来查必须查得到——
    # 查不到只会得到 404，而那句话的意思是"这个 id 不存在"，不是"还没开始"。
    batch_id = importer.begin(batch_id=importer.new_batch_id(), since=payload.since)
    worker = threading.Thread(
        target=_run_batch,
        args=(importer, batch_id, payload.since),
        name=f"legacy-import-{batch_id}",
        daemon=True,
    )
    worker.start()
    return ImportBatchOut(batch_id=batch_id, state="planned", source=importer.source)


def _run_batch(importer: LegacyImporter, batch_id: str, since: datetime | None) -> None:
    """后台线程的入口：**失败也不往外抛**（异常只留在那个线程的栈里，没人看得见）。

    ``run`` 自己会把失败写进台账（``state=failed`` + ``error``）并返回报告，
    所以这里连报告都不用接——进度与结论都从库里读。
    """
    try:
        importer.run(batch_id=batch_id, since=since)
    except Exception:  # pragma: no cover - run 已吞掉可预期失败，这里是最后的兜底
        logger.exception("旧会话导入线程异常退出：%s", batch_id)


@router.get(
    "/import/{batch_id}",
    response_model=ImportBatchOut,
    summary="导入进度（轮询）",
)
def import_status(
    batch_id: str,
    services: Annotated[Services, Depends(get_services)],
    caller: ReadDep,
) -> ImportBatchOut:
    """查一个批次到哪一步了（``imports.state`` + ``counts_json``）。

    不选 SSE：这条进度是"几十秒一次的粗粒度数字"，断线无所谓，也没必要多一条流式形状
    （方案 §3.1 的选择）。CLI 在另一个进程里开的批次同样查得到——**账写在库里**。
    """
    importer = _importer(services)
    batch = importer.batch(batch_id)
    if batch is None:
        raise NotFoundError(f"导入批次不存在：{batch_id}")
    return _as_out(batch)


@router.post(
    "/import/{batch_id}/rollback",
    response_model=ImportBatchOut,
    summary="回滚一个导入批次（删新建的 / 用快照恢复被替换的 / 本机改过的保留）",
)
def rollback_import(
    batch_id: str,
    services: Annotated[Services, Depends(get_services)],
    caller: WriteDep,
) -> ImportBatchOut:
    """撤销一个批次——**两条规则逐条按台账办**（方案 §3.1）：

    - ``created`` 且本机这条没再动过 → 删；
    - ``replaced`` 且本机这条没再动过 → 用导入前的快照恢复；
    - **本机改过的一律保留**并如实报数（回滚不是"把用户在本机说过的话一起抹掉"）。

    **同步返回**（不像导入那样后台跑）：它通常是秒级的，而"撤销"这个动作用户要的就是
    结果本身。返回的 ``counts`` 里逐条说着"删了几条 / 恢复几条 / 保留哪几条、为什么"。
    """
    importer = _importer(services)
    report = importer.rollback(batch_id)
    return _as_out(report)


# ---------------------------------------------------------------- 薄重声明两条

chat_reads.add_api_route(
    "/conversations/{conversation_id}/events",
    chat.conversation_events,
    methods=["GET"],
    summary="会话事件日志（只追加，按 seq 正序）",
    tags=["local"],
)
chat_reads.add_api_route(
    "/chat/context-usage",
    chat.context_usage,
    methods=["GET"],
    summary="上下文用量（按来源分解，估算）",
    tags=["local"],
)
