"""本机档专属端点（M2 阶段 3）。

这个模块装两样东西，都是"**只在本机档成立**"的那几件：

1. ``GET /local/status``（`router`）——**我的数据在哪**。桌面壳与界面显示"本机运行时"
   那条状态条靠它（阶段 4 接线），排障时第一眼看的也是它：这一档的库文件在哪、
   多大、这一份进程接的是哪个 NAS。**只读、不建档**：打开一次界面不该把库建出来；
2. **两条薄重声明**（`chat_reads`）——``GET /conversations/{id}/events`` 与
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

``/local/import*``（旧会话导入与回滚）是阶段 5 的事，届时加在 `router` 上。
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.api.auth import ReadDep
from app.api.v1 import chat
from app.core.config import Settings, get_settings
from app.core.services import Services, get_services
from app.core.storage import LOCAL_DB_NAME

__all__ = ["chat_reads", "router"]

router = APIRouter(prefix="/local", tags=["local"])

#: 两条薄重声明的落点。**没有前缀**：它们就在原来的路径上（理由见模块头）。
chat_reads = APIRouter(tags=["local"])


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
    """**我的数据在哪**：库文件、数据目录、远端两头。

    库路径与 ``core/storage.py`` 用的是**同一个字面量**（`LOCAL_DB_NAME`）与同一套优先级
    （``KYLAB_LOCAL_DB`` > ``<data_dir>/kylab.db``）：两处各写一份文件名，迟早会出现
    "状态页说 A、实际写 B"。
    """
    data_dir = Path(settings.data_dir)
    database = Path(settings.local_db) if settings.local_db else data_dir / LOCAL_DB_NAME
    return LocalStatusOut(
        deployment=settings.deployment,
        data_dir=str(data_dir),
        database=str(database),
        database_exists=database.exists(),
        database_bytes=_size_of(database),
        database_wal_bytes=_size_of(database.with_name(database.name + "-wal")),
        server_url=settings.server_url or None,
        note=(
            "会话 / 消息 / 事件 / 产物 / 笔记 / 设置 / 工作区落本机 SQLite；"
            "知识库（检索与入库）在 NAS 上，M3 接提供者。"
        ),
    )


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
