"""本机档专属端点（M2 阶段 3、阶段 5；M3 阶段 5）。

这个模块装四样东西，都是"**只在本机档成立**"的那几件：

1. ``GET /local/status``（`router`）——**我的数据在哪**。桌面壳与界面显示"本机运行时"
   那条状态条靠它（阶段 4 接线），排障时第一眼看的也是它：这一档的库文件在哪、
   多大、这一份进程接的是哪个 NAS。**只读、不建档**：打开一次界面不该把库建出来；
   阶段 5 起它还如实报"导入这件事"的两笔账：**没跑完的批次**（R1：可重跑续上）与
   **未随导入的文件引用数**（R4：文件本体留在 NAS 上）；
2. ``/local/import*``（`router`，阶段 5）——旧会话一次性导入与回滚的四条端点；
3. ``GET|PATCH /local/provider``（`router`，M3 阶段 5）——**知识库提供者的判定源**
   （三态状态 + 能力集 + 库清单；改地址与开关）。见下面那一节；
4. **两条薄重声明**（`chat_reads`）——``GET /conversations/{id}/events`` 与
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

## ``/local/provider`` 为什么在本机档（M3 阶段 5）

**浏览器 / NAS 网页端没有这一节**，而且不该有：那一档的知识库**就是它自己**（进程内
检索 + 本机入库 + 本机那几张表），"提供者在不在"是它自己说了算，没有第二个东西可问。
本机档正相反——知识库**在别处**（NAS 上），于是"它现在连不连得上、能力集是什么、
这把钥匙看得见哪些库"必须有一个**本机**的答案：侧栏显不显示知识库那几项、对话里摆不摆
那三个 KB 工具、设置面板显示什么，全都读它（方案 §3.1 的**唯一判定源**）。

两条端点的分工：

- ``GET /local/provider``：三态 + 原因 + 能力集（形状由 ``ProviderStatus.to_payload()``
  给，本模块**不另拼一份**）；``refresh=1`` **强制重探**——窗口重新获得焦点、点
  「测试连接」时用它（方案 §3.2 的三条失效路径之一）。握手结论在客户端里缓存 30s
  （进程内存，不落库），所以不 refresh 时这一条只是把缓存读出来，**不在渲染路径上
  等一次 NAS 往返**（R1）；
- ``PATCH /local/provider``：改**两个运行期键**（落本机库 ``app_settings``，
  ``services.runtime.set`` 写、``services.runtime.get`` 读）。白名单**写死为**
  ``base_url`` / ``enabled`` 两个——**凭据类键一个都不收**（R3：token 只从引导级来，
  不落库、不进日志；``token`` / ``kb_token`` / ``api_key`` 在这里都是"未知键"，
  422 拒掉），未知键一律 422（拼错一个键却"保存成功"是最难查的一类问题）。写完
  **立刻重探一次**并把最新状态整个回给前端：设置面板保存后页面按新状态重渲染，
  靠的就是这一条（方案 §3.4）。

**这两个键不进 ``services/runtime_config.SETTING_GROUPS``**（M3 §4.1）：那份注册表
同时是服务器档 ``GET /settings`` 的渲染来源，把"知识库提供者"塞进去会让 NAS 网页端的
设置页长出一条对它毫无意义的配置。本机档这两条由本模块自己读写。
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, ConfigDict, Field

from app.api.auth import ReadDep, WriteDep
from app.api.v1 import chat
from app.core.config import Settings, get_settings
from app.core.exceptions import InvalidRequestError, NotFoundError
from app.core.services import Services, get_services
from app.core.storage import LOCAL_DB_NAME
from app.services.knowledge_provider import (
    SETTING_BASE_URL,
    SETTING_ENABLED,
    KnowledgeProviderClient,
    ProviderStatus,
)
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


class ProviderStatusOut(BaseModel):
    """知识库提供者的状态（``GET /local/provider``，形状照方案 §3.1）。

    字段与 ``ProviderStatus.to_payload()`` **一一对应**——那一个是这个形状的作者
    （``services/knowledge_provider.py``），本模型只做一次校验与文档化，**不另拼一份**
    （两处各建一份迟早漂：端点多算一个字段、客户端少读一个字段都不会有人发现）。

    ``ready`` 起的那五段（协议版本 / 应用版本 / 能力集 / 调用者 / 库清单）靠
    ``response_model_exclude_unset`` 实现"**没有**"而不是"空"：不 ready 时它们**根本
    不在响应里**（方案 §3.1 那句"ready 时才有"）。回成空对象的话，界面就得去猜
    "是没探到还是真没有"——而这两件事的下一步动作完全不同。
    """

    state: str = Field(description="unconfigured / unavailable / ready（三态，没有第四种）")
    available: bool = Field(description="``state == ready`` 的别名（页面显隐只看它）")
    reason: str = Field(default="", description="两种「不在」各一句人话 + 下一步；ready 时为空")
    checked_at: datetime = Field(description="这个结论是什么时候得到的（ISO 时间）")
    base_url: str = Field(
        default="", description="解析后的实际地址（空 = 没配）。**它不是秘密**，不必脱敏"
    )
    credential: str = Field(
        default="missing", description="configured / missing——凭据只看有没有，永不回显"
    )
    protocol_version: int | None = Field(
        default=None, description="提供者报的协议版本；比本机所知更高即判不可用"
    )
    app_version: str = Field(default="", description="提供者那一侧的版本（排障用）")
    capabilities: dict[str, Any] = Field(default_factory=dict, description="能力集（两侧契约）")
    caller: dict[str, Any] = Field(
        default_factory=dict, description="这把凭据在 NAS 侧被认成谁（页面用会话、边车用钥匙）"
    )
    knowledge_bases: list[dict[str, Any]] = Field(
        default_factory=list, description="这次调用看得见的库（受限 key 只看到范围内的）"
    )


class ProviderPatchIn(BaseModel):
    """``PATCH /local/provider`` 的请求体：**只有两个键**（方案 §4.1 的运行期键）。

    ``extra="forbid"`` 是有意的（与 ``PATCH /settings`` 那条"拒绝未知键"同一道理，
    ``api/v1/settings.py``）：**凭据类键一个都不收**（R3——token 只从引导级来，
    不落库、不进日志），而 ``token`` / ``kb_token`` / ``api_key`` 这些名字在这里
    会以"未知键"被 422 拒掉。白名单只有这一处，不在端点函数里再列一遍。

    ``None`` = **不改这一项**（PATCH 的语义：只动你给的那些键）。
    """

    model_config = ConfigDict(extra="forbid")

    base_url: str | None = Field(
        default=None,
        description="提供者地址；空串 = 清掉覆盖、回继承（壳里那台 NAS）；None = 不改",
    )
    enabled: bool | None = Field(
        default=None,
        description="提供者开关；false = 显式关掉（页面与 KB 工具都不摆）；None = 不改",
    )


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
            "知识库（检索与入库）经**提供者客户端**打 NAS（连没连上看 /local/provider）。"
            "导入过来的产物与附件只留引用（`location` 是 NAS 上的 key），文件本体在本机没有。"
        ),
    )


# ------------------------------------------------------------ 知识库提供者（M3 阶段 5）


def _provider(services: Services) -> KnowledgeProviderClient:
    """取**进程级**那个提供者客户端（组合根建的那一个，M3 阶段 5 收成单实例）。

    服务器档或手工构造的 `Services` 上它是 `None` —— 那种情况下如实报"这一节只有
    本机档有"，与 `_importer` 那条同一个写法（**不装作答得上来** ✗：回一个空的
    `unconfigured` 会让界面以为"这台机器只是还没配"，而真相是"这一档没有这个概念"）。
    """
    provider = services.provider
    if provider is None:
        raise InvalidRequestError(
            "知识库提供者的状态只有本机档才有：服务器档的知识库就是它自己"
            "（没有第二个东西可问，见 api/v1/local.py 模块头那一节）"
        )
    return provider


def _provider_out(status: ProviderStatus) -> ProviderStatusOut:
    """``ProviderStatus`` → 响应模型（**形状由 ``to_payload()`` 给**，这里只校验一次）。

    刻意不逐字段接：接一遍就等于在本模块另写一份形状，而那一份与
    ``services/knowledge_provider.ProviderStatus.to_payload()`` 迟早会分叉
    （少一个字段不会有人发现，界面却会因此少显示一块）。

    ⚠️ 名字里带 ``provider`` 是**必须的**：下面导入那一节另有一个 ``_as_out``
    （报告 / 批次记录 → ``ImportBatchOut``），两个同名函数在模块里是后定义的那个赢
    ——而编排的顺序不该决定哪一条端点回什么形状（这一处踩过一次）。
    """
    return ProviderStatusOut.model_validate(status.to_payload())


@router.get(
    "/provider",
    response_model=ProviderStatusOut,
    # **不 ready 时那五段根本不出现在响应里**（不是 null / 空对象，见模型说明）
    response_model_exclude_unset=True,
    summary="知识库提供者状态（三态 + 原因 + 能力集 + 库清单）",
)
def local_provider(
    services: Annotated[Services, Depends(get_services)],
    caller: ReadDep,
    refresh: bool = False,
) -> ProviderStatusOut:
    """**唯一判定源**：知识库提供者现在是什么状态（方案 §3.1、§3.2）。

    ``refresh=1`` 强制重探（窗口重新获得焦点、点「测试连接」时用）；不带就是读那份
    30s 的进程内缓存（**不落库**——落库是 M4 的元数据缓存）。两件事都不在这里做：

    - **不在启动时挡路**：首次被问到才探（与"模型连通性检查放后台"同一条口径）；
    - **不替前端定轮询节奏**：``state != ready`` 时每 30s 探一次、``ready`` 时不探，
      那是**前端**的节奏（方案 §3.2 的失效三条）；这一条只负责"被问到就给一个真结论"。

    探针**绝不抛**：连不上 / 凭据错 / 版本不认识都是 `unavailable` + 一句原因，
    而不是 500（一次探测的成败不该让状态页本身打不开）。
    """
    return _provider_out(_provider(services).status(refresh=refresh))


@router.patch(
    "/provider",
    response_model=ProviderStatusOut,
    response_model_exclude_unset=True,
    summary="改知识库提供者的地址 / 开关（白名单两键，写完立刻重探）",
)
def update_local_provider(
    payload: ProviderPatchIn,
    services: Annotated[Services, Depends(get_services)],
    caller: WriteDep,
) -> ProviderStatusOut:
    """改两个运行期键，**写完立刻重探并把最新状态整个回给前端**（方案 §3.4）。

    - ``base_url``：空串 = **清掉覆盖、回继承**（那正是面板上的「恢复默认」）；
    - ``enabled``：`false` = 显式关掉（解析成 ``unconfigured`` + 那句"被关掉了"，
      而不是"没填地址"——两句的下一步不同）。
    - 一个键都不给（空 body）= 不改动，**只重探一次**（等价于 ``refresh=1``）。

    **凭据不在这里**（R3）：``token`` 只从引导级来（壳的 ``config.json`` / 环境变量），
    这一条的白名单只有上面两键，凭据类键会被 422 挡在门外（`ProviderPatchIn` 的
    ``extra="forbid"``）——本机库里因此永远不会出现 token。

    **写完不用重启边车**（方案 §4.2）：提供者客户端**每次调用现取目标**
    （``resolve_provider_target`` 是纯函数），这一条的强制重探只是把新结论立刻
    算出来回给前端，好让"保存"这一下同时完成"重渲染"。
    """
    values: dict[str, str] = {}
    if payload.base_url is not None:
        # 空串 = 恢复默认：`runtime.set` 把它原样写进 app_settings，
        # 而 `resolve_provider_target` 见空就往下继承（引导级 → 壳里那台 NAS）
        values[SETTING_BASE_URL] = payload.base_url.strip()
    if payload.enabled is not None:
        values[SETTING_ENABLED] = "1" if payload.enabled else "0"
    if values:
        services.runtime.set(values)
    return _provider_out(_provider(services).status(refresh=True))


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
