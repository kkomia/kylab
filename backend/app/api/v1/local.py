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
4. ``/local/kb-cache/*``（`router`，M4 阶段 4/6）——**知识库元数据快照族的只读面**
   （页面"先画一帧"用的那几条读 + 一条用量读数 + 一条主动再验证 + 一条清理）。见下面那一节；
5. **两条薄重声明**（`chat_reads`）——``GET /conversations/{id}/events`` 与
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

## ``/local/kb-cache/*`` 为什么在本机档、为什么只有这几条（M4 阶段 4）

快照**只落在本机**（``kb_meta_cache`` 表；写者只有本机后端一个，页面是纯读者，
方案 §2.3），所以读它的端点也只该有本机这一份。页面读它是为了"**先画一帧**"：
本机回环、个位数毫秒，内容一旦有了就不再是骨架屏。页面自己那条**实时读一字不改**
（会话身份直连 NAS）——而这份快照是**边车钥匙**看到的，所以进快照前就把
``can_write`` / ``can_manage`` 剥掉了（D-B）：权限入口晚一步出现，好过点下去 403。

四条口径在这里写死（都是"如实"那条价值的具体形态）：

- **两个时间戳不许混**：``checked_at`` 是"上次确认"，``fetched_at`` 是"上次看到的内容"
  ——界面上是两句话，用例逐字钉；
- **``available:false`` 是要明确回给前端的语义**（"这台还没看过它"），所以这一族
  **不用** ``response_model_exclude_unset``：形状恒定，理由在 ``reason`` 里；
- **带筛选的文档列表如实说"没有"**（``q`` / ``stage`` / ``source_kind``）：决策 D-D，
  这个筛选条件下的内容**不留副本**——所以它不是"没取到"，而是"这一档就是没有"
  （HTTP 200 + ``available:false``，**不报错**）；
- **再验证失败也不报错**：快照照旧可读（``stale`` + ``last_error``），页面顶上那句
  "现在连不上，这是上次看到的内容（X）"就是这么来的（§4.5）。

**页面不只读快照，还会主动要一次再验证**（``POST /local/kb-cache/revalidate``）：
窗口重新获得焦点、或设置里点「立即刷新」时用它（§4.4）。它**只读远端**——
写的是本机那张表，所以走 ``ReadDep`` 而不是 ``WriteDep``（见那个端点的 docstring）。
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, ConfigDict, Field

from app.api.auth import ReadDep, WriteDep
from app.api.v1 import chat
from app.core.config import Settings, get_settings
from app.core.exceptions import InvalidRequestError, NotFoundError
from app.core.services import Services, get_services
from app.core.storage import LOCAL_DB_NAME
from app.services.kb_cache import (
    CACHEABLE_RESOURCES,
    DOC_LIST,
    DOCUMENT,
    FOLDERS,
    KB_DETAIL,
    KB_LIST,
    KbMetaCacheService,
    KbMetaSnapshot,
    doc_list_scope_key,
)
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


# -------------------------------------------------- 知识库元数据快照（M4 阶段 4）


FILTERED_VIEW_REASON = "这个筛选条件下的内容不留副本"
"""带筛选参数的那一次文档列表读**如实说"没有"**时那句人话（决策 D-D / §1.1）。

**不是错误**：4xx 会让页面以为"这个请求写错了"，而真相是"这一档本来就不留副本"
（搜索结果是"这一问的答案"，过期即误导）。所以它是 ``available:false`` + 这句话。"""

KB_SCOPED_RESOURCES: tuple[str, ...] = (DOC_LIST, KB_DETAIL, FOLDERS)
"""「按库清」认的那三族：``scope_key`` 就是 ``kb_id`` 的那三个（§3.4-4 的第三档）。

``document`` 一族**刻意不在里面**：它的键是 ``document_id``，认不出属于哪个库——
要清它得按 id 清，或者全清 / 按地址清。这条差异写在这里，免得后来者以为是漏了。"""


class KbCacheSnapshotOut(BaseModel):
    """一份知识库元数据快照（``/local/kb-cache/*`` 那几条读共用这一个形状）。

    形状**恒定**（可用与不可用都是这几个键）：``available:false`` 是明确回给前端的语义
    （"这台还没看过它"），所以这里**不用** ``response_model_exclude_unset``——
    回一个"键都不在"的对象只会让页面去猜，而它要做的动作就是一目了然的骨架屏。

    ``items`` 是列表型资源（``kb_list`` / ``doc_list`` / ``folders``）的行，``payload``
    是这一份内容的**原样**（列表型的 ``total`` / ``limit`` / ``offset``、单个对象型的
    那个对象）。**两份不是两份形状**：``items`` 就是 ``payload["items"]``，
    前端画表画它、要更多细节时看 ``payload``。

    ``fetched_at`` 与 ``checked_at`` 是**两句话**（§3.1 / §5）：前者是"这份内容是什么时候
    看到的"（界面那句"上次更新于 X"），后者是"最近一次确认过"（含"确认过没变"）。
    """

    available: bool = Field(description="本机有没有这份内容的副本（false 时看 reason）")
    resource: str = Field(description="kb_list / kb_detail / doc_list / document / folders")
    scope_key: str = Field(
        default="", description="资源内的键（库 id / 文档 id / 视图指纹）；带筛选的那一档没有键"
    )
    reason: str = Field(default="", description="available=false 时为什么（一句人话）")
    items: list[dict[str, Any]] = Field(
        default_factory=list, description="列表型资源的行（别的资源是空表）"
    )
    payload: dict[str, Any] | None = Field(
        default=None, description="这份内容的原样（NAS 那边的形状）；没有副本时是 null"
    )
    version: str = Field(default="", description="内容哈希（sha256:…）——变没变看它")
    source: str = Field(default="", description="reader / revalidate：这行是怎么来的（只作排障）")
    fetched_at: datetime | None = Field(default=None, description="这份**内容**是什么时候看到的")
    checked_at: datetime | None = Field(
        default=None, description="最近一次**确认**（含「确认过没变」）"
    )
    stale: bool = Field(default=False, description="上次再验证失败了：内容照旧可读，但没被确认")
    last_error: str = Field(default="", description="那次失败的原因（stale 时才非空）")
    revalidating: bool = Field(default=False, description="刚刚顺带排了一次后台再验证")


class KbCacheRevalidateIn(BaseModel):
    """``POST /local/kb-cache/revalidate`` 的请求体：只说要再确认**哪一份**快照。

    ``extra="forbid"``（与 ``ProviderPatchIn`` 同一条纪律）：**筛选参数在这里没有位置**
    ——``q`` / ``stage`` / ``source_kind`` 换不出缓存键（D-D），也就没有"这一份"可以再确认，
    给了就是 422（"顺手缓存一下搜索结果"这条路在那一步撞墙）。
    """

    model_config = ConfigDict(extra="forbid")

    resource: str = Field(description="kb_list / kb_detail / doc_list / document / folders")
    kb_id: str = Field(default="", description="按库的那几族要给（kb_detail / doc_list / folders）")
    document_id: str = Field(default="", description="document 那一族要给")
    folder: str = Field(default="", description="doc_list：只看这个目录（空 = 整个库）")
    root: bool = Field(default=False, description="doc_list：只看未归档的（与 folder 互斥）")
    page: int = Field(default=1, ge=1, description="doc_list：第几页（与 size 一起换算 offset）")
    size: int = Field(default=50, ge=1, le=200, description="doc_list：一页几篇")


class KbCachePurgeOut(BaseModel):
    """清理结果：清掉了几行（0 = 本来就没有，不是错误）。"""

    removed: int = Field(default=0, description="删掉的快照行数")


class KbCacheStatsOut(BaseModel):
    """本机留的那一份的**用量读数**（设置面板「本机留了一份」那一块的数据源）。

    形状对着 ``storage.base.KbMetaCacheStats``（那个 dataclass 是这四个数的作者），
    这里只做一次校验与文档化——**不另拼一份**，那个类型的字段名就是这里的字段名。

    ``newest_fetched_at`` 是界面上「最近更新」那一行（**内容**上次是什么时候看到的）；
    ``oldest_fetched_at`` 只作排障（回答"这一份是不是很久以前留的"）。
    """

    rows: int = Field(
        default=0, description="留着几项（库列表 / 每库详情 / 每个文档清单视图各一项）"
    )
    payload_bytes: int = Field(
        default=0, description="这些内容合计多少字节（与淘汰时用的那把尺子逐字一致）"
    )
    oldest_fetched_at: datetime | None = Field(
        default=None, description="最旧那一项是什么时候看到的（没行就是 null）"
    )
    newest_fetched_at: datetime | None = Field(
        default=None, description="最新那一项是什么时候看到的（界面上的「最近更新」就是它）"
    )


def _kb_cache(services: Services) -> KbMetaCacheService:
    """取**进程级**那个快照服务（组合根建的那一个，M4 阶段 3）。

    服务器档或手工构造的 ``Services`` 上它是 ``None`` —— 那种情况如实报"这一族只有本机档
    有"（与 `_provider` / `_importer` 同一个写法：**不装作答得上来**）。
    """
    service = services.kb_cache
    if service is None:
        raise InvalidRequestError(
            "知识库元数据快照只有本机档才有：服务器档的知识库就是它自己，"
            "页面读到的已经是权威数据（见 api/v1/local.py 模块头那一节）"
        )
    return service


def _require_resource(resource: str) -> str:
    """只认正向清单里的资源——**那份清单只有一份**（``services/kb_cache.CACHEABLE_RESOURCES``）。

    这里再查一遍不是为了防谁，而是因为**键与取数都要看着资源名才能定**（快照服务里那道
    ``_require`` 是最后一道闸，不是第一道）。
    """
    if resource not in CACHEABLE_RESOURCES:
        raise _unknown_resource(resource)
    return resource


def _unknown_resource(resource: str) -> Exception:
    """清单外的资源名那句人话（**唯一一份**：两处调用共用它，返回异常实例由调用处 ``raise``）。"""
    return InvalidRequestError(
        f"这个资源不进知识库元数据快照：{resource!r}；"
        f"能进的是 {sorted(CACHEABLE_RESOURCES)}"
        "（理由见 services/kb_cache.py 的 NEVER_CACHED）"
    )


def _doc_list_key(kb_id: str, *, folder: str, root: bool, page: int, size: int) -> str:
    """文档列表的**视图指纹**。

    "``folder`` 与 ``root`` 互斥""``page`` 从 1 起"这类规矩**只有** ``doc_list_scope_key``
    说了算（唯一一份，阶段 5 的前端必须给出同一个串）——这里只把它抛的 ``ValueError``
    折成"请求里有东西说错了"那一档，不另写一遍判断。
    """
    try:
        return doc_list_scope_key(kb_id, folder=folder or None, root=root, page=page, size=size)
    except ValueError as exc:
        raise InvalidRequestError(str(exc)) from exc


def _snapshot_fetch(
    provider: KnowledgeProviderClient,
    resource: str,
    *,
    kb_id: str = "",
    document_id: str = "",
    folder: str = "",
    root: bool = False,
    page: int = 1,
    size: int = 50,
) -> Callable[[], Any]:
    """这个资源的一次**原始读**（§4.2 流程图上那两条"整取"）：GET 一次、404 → None、其余抛。

    它就是 ``snapshot`` / ``refresh`` 要的那个闭包，**由端点给**——快照那一层不认识 HTTP
    （``services/kb_cache.KbMetaFetcher`` 的三条口径）。三条纪律逐条落在下面：

    - **一次调用一个请求**：没有重试、没有条件请求（NAS 那几个读端点没有 ETag，§4.1 实测），
      "变没变"由内容哈希判；
    - **``None`` 是有话说的**：远端说"没有这个东西"时回 ``None``（快照据此删行），
      它与"取不到"（抛）是两件事；
    - **筛选项换不出闭包**：``doc_list`` 只有规范视图那几个量（目录 / 第几页 / 几篇），
      带 ``q`` / ``stage`` / ``source_kind`` 的请求在端点门口就转成 ``available:false`` 了。

    三个资源走 ``provider.page_meta()``，另外两个走 ``provider.knowledge_meta()``
    （reader 面那两个方法），**同一把钥匙、同一套错误口径**：本机打 NAS 的出口只有
    ``KnowledgeProviderClient`` 一个（见那个模块的模块头），这里不另开一条。
    """
    _require_resource(resource)
    if resource == KB_LIST:
        reader = provider.knowledge_meta()
        return lambda: {"items": reader.list_knowledge_bases()}
    if resource == KB_DETAIL:
        reader = provider.knowledge_meta()
        return lambda: reader.get_knowledge_base(kb_id)
    page_reader = provider.page_meta()
    if resource == DOC_LIST:
        return lambda: page_reader.list_documents(
            kb_id,
            # `folder` 与 `root` 互斥由键那一处判（`_doc_list_key`）：到得了这里的组合
            # 必然是"只要目录"或"只要未归档"里的一个，或者两个都没给（整个库）。
            folder_id=folder or None,
            root=root,
            limit=size,
            offset=(page - 1) * size,
        )
    if resource == DOCUMENT:
        return lambda: page_reader.document(document_id)
    if resource == FOLDERS:
        return lambda: page_reader.folders(kb_id)
    # 到不了这里：五种资源上面各有分支，`_require_resource` 已经拦掉了别的一切
    raise _unknown_resource(resource)  # pragma: no cover


def _snapshot_out(snapshot: KbMetaSnapshot) -> KbCacheSnapshotOut:
    """一份快照 → 响应模型（见 ``KbCacheSnapshotOut`` 的说明：形状恒定、`items` 是视图）。"""
    payload = snapshot.payload if isinstance(snapshot.payload, dict) else None
    items = payload.get("items") if payload is not None else None
    return KbCacheSnapshotOut(
        available=snapshot.available,
        resource=snapshot.resource,
        scope_key=snapshot.scope_key,
        reason=snapshot.reason,
        items=items if isinstance(items, list) else [],
        payload=payload,
        version=snapshot.version,
        source=snapshot.source,
        fetched_at=snapshot.fetched_at,
        checked_at=snapshot.checked_at,
        stale=snapshot.stale,
        last_error=snapshot.last_error,
        revalidating=snapshot.revalidating,
    )


def _read_snapshot(
    services: Services, resource: str, scope_key: str, **fetch_args: Any
) -> KbCacheSnapshotOut:
    """页面面的那一读（§2.3 的 ①③）：**零网络**取快照 + 命中且过期就把再验证排到后台。

    这里读了**两次** ``snapshot()`` 是刻意的，不是笔误：那个方法把两个读面压在一个签名里
    ——给 ``fetch`` 是 reader 面（未命中会**同步**取一次，它必须现在给答案），不给是页面面
    （未命中只如实说没有）。页面面要的恰好是这两条**各一半**：

    - **命中** → 走带 ``fetch`` 的那一读（图的是"该再确认就排一次"，§4.4 那张表的第三行）；
      命中路上那条路**不会被同步调用**，所以这一读仍然零网络；
    - **未命中** → 走不带 ``fetch`` 的那一读：**一个请求都不发**，页面照旧骨架屏，
      它自己那条实时读会赢回来（§4.2 的流程图）。

    所以先读一次拿到事实，再按事实走对应那一半。用例里那条"未命中零请求"钉着它
    （谁把它合并成"一次调用都带 fetch"，那条当场红——那会让"先画一帧"变成一次 NAS 往返）。
    """
    service = _kb_cache(services)
    snapshot = service.snapshot(resource, scope_key)
    if snapshot.available:
        fetch = _snapshot_fetch(_provider(services), resource, **fetch_args)
        snapshot = service.snapshot(resource, scope_key, fetch=fetch)
    return _snapshot_out(snapshot)


@router.get(
    "/kb-cache/knowledge-bases",
    response_model=KbCacheSnapshotOut,
    summary="快照：库列表（页面先画一帧用）",
)
def kb_cache_knowledge_bases(
    services: Annotated[Services, Depends(get_services)],
    caller: ReadDep,
) -> KbCacheSnapshotOut:
    """本机留的那份**库列表**快照（与 reader 面共用同一份内容：一个服务、一张表）。

    ``items`` 里**没有** ``can_write`` / ``can_manage``（D-B）：那是按调用者身份算的，
    而这份快照是**边车钥匙**看到的——落进快照就等于"把某一刻某个身份看到的东西当成这个库
    的属性"（受限成员会看到全部库、管理员会丢掉管理入口）。页面画快照时那两个入口晚一步
    出现，实时读一落地就亮，这正是"不许装成实时"的具体形态。

    没有副本（还没看过 / 超龄被丢 / 换过地址）→ ``available:false`` + 一句原因，
    **一个请求都不发**（§2.3：这一条是本机回环，不是一次 NAS 往返）。
    """
    return _read_snapshot(services, KB_LIST, "")


@router.get(
    "/kb-cache/knowledge-bases/{kb_id}",
    response_model=KbCacheSnapshotOut,
    summary="快照：库详情",
)
def kb_cache_knowledge_base(
    kb_id: str,
    services: Annotated[Services, Depends(get_services)],
    caller: ReadDep,
) -> KbCacheSnapshotOut:
    """本机留的那份**库详情**快照（``response_model`` 那张表里"库详情"那一行）。

    内容与 ``items`` 里的那一项同源：``kb_list`` 每确认一次就顺带把每库的 ``kb_detail``
    行按**同一份 payload 拆开写**（§3.1）——两处内容因此不会各自过期，reader 面每轮每库
    那一次读也才真能零网络。
    """
    return _read_snapshot(services, KB_DETAIL, kb_id, kb_id=kb_id)


@router.get(
    "/kb-cache/knowledge-bases/{kb_id}/documents",
    response_model=KbCacheSnapshotOut,
    summary="快照：文档列表（只认规范视图）",
)
def kb_cache_documents(
    kb_id: str,
    services: Annotated[Services, Depends(get_services)],
    caller: ReadDep,
    folder: str = Query(default="", description="只看这个目录（NAS 那边的 folder_id）"),
    root: bool = Query(default=False, description="只看未归档的（与 folder 互斥）"),
    page: int = Query(default=1, ge=1, description="第几页（与 size 一起换算 offset/limit）"),
    size: int = Query(default=50, ge=1, le=200, description="一页几篇"),
    q: str = Query(default="", description="按文件名搜——**这一档不留副本**（D-D）"),
    stage: str = Query(default="", description="只看某个流水线阶段——同上"),
    source_kind: str = Query(default="", description="只看某个来源类型——同上"),
) -> KbCacheSnapshotOut:
    """本机留的那份**文档列表**快照（页面挂载那 3–4 次往返里最重的一次）。

    **只认规范视图**：``q`` / ``stage`` / ``source_kind`` 任一给出来就如实回
    ``available:false`` + 一句原因（决策 D-D），而且**不报错**——页面据此照旧骨架屏 +
    自己那条实时读；报 4xx 会把"这一档就是没有"说成"这个请求有问题"。

    快照面按 ``page`` / ``size`` 说，实时读那边按 ``offset`` / ``limit`` 说
    （``offset = (page - 1) * size``）：同一个视图的两种说法，键只由
    ``doc_list_scope_key`` 拼（阶段 5 的 ``docListViewKey()`` 必须给出同一个串）。
    """
    if q.strip() or stage.strip() or source_kind.strip():
        # 带筛选的这一读**没有键**：它不给副本（scope_key 因此是空的）
        return _snapshot_out(
            KbMetaSnapshot(
                available=False, resource=DOC_LIST, scope_key="", reason=FILTERED_VIEW_REASON
            )
        )
    scope_key = _doc_list_key(kb_id, folder=folder, root=root, page=page, size=size)
    return _read_snapshot(
        services,
        DOC_LIST,
        scope_key,
        kb_id=kb_id,
        folder=folder,
        root=root,
        page=page,
        size=size,
    )


@router.get(
    "/kb-cache/knowledge-bases/{kb_id}/folders",
    response_model=KbCacheSnapshotOut,
    summary="快照：库内目录",
)
def kb_cache_folders(
    kb_id: str,
    services: Annotated[Services, Depends(get_services)],
    caller: ReadDep,
) -> KbCacheSnapshotOut:
    """本机留的那份**目录树**快照——与文档列表**同屏**，所以不做就成了"半屏缓存"（§1.1）。"""
    return _read_snapshot(services, FOLDERS, kb_id, kb_id=kb_id)


@router.get(
    "/kb-cache/documents/{document_id}",
    response_model=KbCacheSnapshotOut,
    summary="快照：文档条目",
)
def kb_cache_document(
    document_id: str,
    services: Annotated[Services, Depends(get_services)],
    caller: ReadDep,
) -> KbCacheSnapshotOut:
    """本机留的那份**文档条目**快照（详情页 / 抽屉的入口帧）。

    ``progress`` 在进快照前就被剥掉了（§1.1）：冻结的进度条是最糟的假象——进度与时间线
    只从实时读来，绝不来自这一档。
    """
    return _read_snapshot(services, DOCUMENT, document_id, document_id=document_id)


@router.post(
    "/kb-cache/revalidate",
    response_model=KbCacheSnapshotOut,
    summary="再确认一份快照（焦点回来 / 「立即刷新」）",
)
def revalidate_kb_cache(
    payload: KbCacheRevalidateIn,
    services: Annotated[Services, Depends(get_services)],
    caller: ReadDep,
) -> KbCacheSnapshotOut:
    """**主动再验证**：整取一次远端 → 比内容哈希 → 相同只推 ``checked_at``、不同换新（§4.1）。

    **为什么是 ``ReadDep`` 而不是 ``WriteDep``**：它**不写远端**——一个字节都不发过去，
    发的是一次 GET；它写的是**本机那张快照表**，而快照是严格可弃的（删了只丢速度，
    不丢数据，v0.3 §5.3）。按 ``WriteDep`` 挡的话，"焦点回来顺手确认一下"就得先要一个
    写权限，而它对 NAS 是纯读、对本机也是可弃的。真正会改数据的只有下面的 ``DELETE``，
    它才是 ``WriteDep``。

    **失败不回错**（§4.5）：远端连不上时回的是"那份快照还在，但它现在没被确认"
    （``available:true`` + ``stale:true`` + ``last_error``）；连快照都没有时才是
    ``available:false`` + 那句原因。两种情况都是 HTTP 200——页面顶上那句"现在连不上，
    这是上次看到的内容（X）"就是这么来的。

    与后台那次再验证共用同一套排程（单飞 / 15s 最短间隔 / 60s 退避都在服务里）：
    这一条是**用户/页面明确要的一次**，所以它不等那 15 秒（§4.4 的"焦点"那一行）。
    """
    resource = _require_resource(payload.resource)
    scope_key = ""
    fetch_args: dict[str, Any] = {}
    if resource == DOC_LIST:
        _require_key(payload.kb_id, "kb_id", "文档列表")
        scope_key = _doc_list_key(
            payload.kb_id,
            folder=payload.folder,
            root=payload.root,
            page=payload.page,
            size=payload.size,
        )
        fetch_args = {
            "kb_id": payload.kb_id,
            "folder": payload.folder,
            "root": payload.root,
            "page": payload.page,
            "size": payload.size,
        }
    elif resource in (KB_DETAIL, FOLDERS):
        _require_key(payload.kb_id, "kb_id", "库详情" if resource == KB_DETAIL else "库内目录")
        scope_key, fetch_args = payload.kb_id, {"kb_id": payload.kb_id}
    elif resource == DOCUMENT:
        _require_key(payload.document_id, "document_id", "文档条目")
        scope_key, fetch_args = payload.document_id, {"document_id": payload.document_id}
    # kb_list：一个地址一行（scope_key 就是空的），不需要任何 id
    service = _kb_cache(services)
    fetch = _snapshot_fetch(_provider(services), resource, **fetch_args)
    return _snapshot_out(service.refresh(resource, scope_key, fetch=fetch))


@router.get(
    "/kb-cache/stats",
    response_model=KbCacheStatsOut,
    summary="本机留的那一份有多大 / 最近更新（设置面板读它）",
)
def kb_cache_stats(
    services: Annotated[Services, Depends(get_services)],
    caller: ReadDep,
) -> KbCacheStatsOut:
    """**只读**报数（M4 阶段 6）：几项、合计多少字节、最旧/最新那份是什么时候看到的。

    设置面板那一块（「本机留了一份」+ 行数 + 最近更新 + 「立即刷新」/「清除」）读的就是它，
    而它和下面那条 ``DELETE`` 是一对：**说出来有多少，才谈得上清不清**。

    三个口径写在这里：

    - **零网络**：只读本机那张表（``KbMetaCacheService.stats``），一个字节都不打 NAS；
    - **只算当前地址**（与 ``DELETE`` 不带参数时那一档不同）：换过地址之后旧地址的行还在
      库里（§5：按地址隔离、不清旧行），但它们不是"这台机器现在连的那台 NAS"留的——
      报数只报现在连的这一片，界面上那句「最近更新」才对得上刚看到的内容；
    - **只读**：这一条一次写入都不做（库本身在启动时就已经准备好了，见
      ``core/storage.py`` 的 ``prepare_sqlite_schema``）。

    ``rows == 0`` 是合法状态（"这一台还没看过它"），不是错误。
    """
    stats = _kb_cache(services).stats()
    return KbCacheStatsOut(
        rows=stats.rows,
        payload_bytes=stats.payload_bytes,
        oldest_fetched_at=stats.oldest_fetched_at,
        newest_fetched_at=stats.newest_fetched_at,
    )


@router.delete(
    "/kb-cache",
    response_model=KbCachePurgeOut,
    summary="清掉本机留的快照（全清 / 按地址 / 按库）",
)
def purge_kb_cache(
    services: Annotated[Services, Depends(get_services)],
    caller: WriteDep,
    provider: str = Query(default="", description="只清这个地址留下的（空 = 所有地址）"),
    resource: str = Query(
        default="", description="与 kb_id 搭配：只清这一族（doc_list / kb_detail / folders）"
    ),
    kb_id: str = Query(default="", description="只清这个库（当前地址上的那三族）"),
) -> KbCachePurgeOut:
    """**清理粒度三档**（§3.4-4）：

    - **什么参数都不给**：全清（所有地址、所有资源）——设置面板那颗「清除」；
    - ``?provider=``：只清这一个地址留下的（§5：按地址隔离、不清旧行，所以清理得指得准）；
    - ``?kb_id=``：按库清，清的是**当前地址**上的那三族；再给 ``?resource=`` 就只清那一族
      （写类动作成功之后页面就地点一下失效，§3.4-1）。

    按库清的映射照阶段 0+1 的口径：``doc_list`` **一次前缀清**（``<kb_id>|``，一个库的视图
    有几十个，逐个删不是调用方该做的事）+ ``kb_detail`` / ``folders`` **两次精确清**
    （一个键就是它自己）。``document`` 那一族不清——它的键是 ``document_id``，
    认不出属于哪个库（要清它得按 id 清，或全清 / 按地址清）。

    返回清掉的行数：0 是"本来就没有"，不是错误（快照严格可弃，重复清一次不该报错）。
    """
    service = _kb_cache(services)
    if kb_id:
        if provider:
            raise InvalidRequestError(
                "provider 与 kb_id 一起给说不清清的是哪一片：按库清清的是**当前地址**"
                f"（{service.provider()}）上的那三族；要按地址清就别给 kb_id"
            )
        if resource and resource not in KB_SCOPED_RESOURCES:
            raise InvalidRequestError(
                f"按库清只认这几族：{list(KB_SCOPED_RESOURCES)}"
                "（document 那一族的键是 document_id，认不出属于哪个库）"
            )
        return KbCachePurgeOut(
            removed=_purge_knowledge_base(service, kb_id=kb_id, resource=resource)
        )
    if resource:
        raise InvalidRequestError(
            "按族清要连 kb_id 一起给（写后失效是「这个库的这几族不作数了」）；"
            "不清某个库就按整片来：全清，或 ?provider= 按地址清"
        )
    if provider:
        # 地址归一（去尾斜杠）与 `KbMetaCacheService.provider()` 同一套：传进来带斜杠的
        # 地址不该清到一个不存在的键空间上（键空间本身是服务建的那片，这里只是对齐）
        return KbCachePurgeOut(removed=service.purge(provider=provider.strip().rstrip("/")))
    return KbCachePurgeOut(removed=service.purge())


def _purge_knowledge_base(service: KbMetaCacheService, *, kb_id: str, resource: str = "") -> int:
    """按库清那三族（见 ``purge_kb_cache`` 的说明）；返回删掉的行数。

    给了 ``resource`` 就只清那一族，否则三族一起清。**先看清单再动手**：清单外的资源名
    在这一层就该拦下（``-`` 那一族尤其），别让它走到存储层去碰运气。
    """
    families = (resource,) if resource else KB_SCOPED_RESOURCES
    return sum(service.invalidate(item, kb_id, views=(item == DOC_LIST)) for item in families)


def _require_key(value: str, name: str, what: str) -> None:
    """这一族的键就是它：没给就没法读，也就没什么可再确认的（说清是哪一个字段）。"""
    if not value.strip():
        raise InvalidRequestError(f"再确认{what}要给出 {name}")


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
