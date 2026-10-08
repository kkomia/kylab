"""本机消费者：本机库的空闲维护。

这个进程只服务**这台机器**，而它手上真正需要有人定期做的事只剩一件：

1. **本机库只增不减**：`usage_events` 有保留期（`usage.USAGE_RETENTION_DAYS`），
   没有这一环它一次都不会被清。

**一行摄取都不做**：摄取（解析 / 切块 / 嵌入 / 向量索引）是知识库那边的家当，
本机连那几张表都没有（知识库在别处，本机是它的客户端）。

**安全边界**：本机的空闲维护**只调用本机域那几个方法**（现在只有过期的用量行，
保留期 `USAGE_RETENTION_DAYS = 180` 天）。不往知识库那份维护清单上凑：里面那些
（清回收站 / 任务与阶段事件 / 文档摘要）动的是知识库的数据，而那些数据不在这台机器上，
判定必须跟着数据走。

**默认起、可关**：它只做"到期的本机行"，没有一条是"用户没要过的动作"，
所以默认就起（`KYLAB_RUN_WORKER=false` 可以关掉）。

## 2026-10-09：定时任务那一半删掉了

原先这里还跑第二条循环：定时任务到点判定（`services/schedules.py::run_due`）与
"就地跑一轮"（旧的 `LocalScheduler.submit` → `schedule_runner.run_scheduled_task`）。
定时任务模块整个删掉之后（端点族 / 服务层 / 执行器 / agent 工具表里那两条 / 前端那一页），
那一半随之消失——于是类与两个入口改名成 `LocalMaintainer` /
`bind_local_maintainer` / `run_local_maintainer`：它们现在只做维护，
再叫 "Scheduler" 会骗人。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # 只为标注：组合根与本模块互相是对方的调用方，运行时导入会成环
    from app.core.services import Services

__all__ = ["LocalMaintainer", "bind_local_maintainer", "run_local_maintainer"]

logger = logging.getLogger(__name__)

#: 本机库的空闲维护一小时一次（防表长大）。**原先住在 ``workers/queue_worker.py``**
#: （服务器档那个消费者）——那个消费者随服务器档一起删了，常量搬到这里，值一个没动。
DEFAULT_MAINTAIN_INTERVAL = 3600.0


class LocalMaintainer:
    """本机档的消费者：定期收一收本机库里只增不减的表。"""

    def __init__(
        self, services: Services, *, maintain_interval: float = DEFAULT_MAINTAIN_INTERVAL
    ) -> None:
        self._services = services
        self._maintain_interval = maintain_interval

    async def run_forever(self, *, stop: asyncio.Event | None = None) -> None:
        """跑到 ``stop`` 置位（与服务器档消费者同一条退出语义：**不取消、自己收工**）。

        `stop` 由调用方（两个入口的 lifespan）给：置位后循环立刻从
        ``wait_for(stopping.wait(), …)`` 醒来返回，不会多等一个间隔。
        """
        stopping = stop or asyncio.Event()
        await self._maintain_loop(stopping)

    async def _maintain_loop(self, stopping: asyncio.Event) -> None:
        """按 `DEFAULT_MAINTAIN_INTERVAL` 收一收**本机**那几张只增不减的表。

        一小时一次（与服务器档同一节奏）：它防的是"表无限长大"，不必更勤。
        异常一律吞掉——清理失败不该带走消费者（下一轮还会再来一次）。
        """
        while not stopping.is_set():
            try:
                await asyncio.to_thread(self._maintain)
            except Exception:
                logger.warning("本机档：空闲维护失败，跳过本轮", exc_info=True)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stopping.wait(), timeout=self._maintain_interval)

    def _maintain(self) -> None:
        """本机库自己的收尾：**只碰本机域的表**（见模块头"安全边界"）。

        一件：过期的用量行（`usage_events` 是本机域唯一"有保留期"的表）。
        它挂在消费者上是因为**本来就没有调用者**——`usage.purge_expired` 写在存储层
        很久了，但从没人调，于是"保留 180 天"实际上没发生。

        吞异常：清理失败不该影响消费，也不该让循环停摆。
        """
        try:
            removed = self._services.usage.purge_expired()
        except Exception:
            logger.warning("本机档：清理过期用量记录失败", exc_info=True)
        else:
            if removed:
                logger.info("本机档：清理过期用量记录 %d 条", removed)


def bind_local_maintainer(services: Services, **kwargs: float) -> LocalMaintainer:
    """装好本机消费者（两个入口各调一次，实现只有这一份）。

    为什么两个入口都要调：桌面壳起的是**边车**（`python -m app.sidecar`，端口 8765），
    而开发时也会直接起 `app.main`（uvicorn，端口 8000 那一档）——两边落的是同一个数据目录、
    同一份本机库，所以"到点收一收"这件事两边都该有人做。
    """
    return LocalMaintainer(services, **kwargs)  # type: ignore[arg-type]


async def run_local_maintainer(maintainer: LocalMaintainer, stop: asyncio.Event) -> None:
    """跑消费循环并兜住异常（与 `main.py::_run_worker` 同一条口径）。

    取消原样上抛：``CancelledError`` 被吞掉的话 asyncio 会以为它正常结束了，
    取消语义就丢了（那条教训写在 `main.py` 里）。
    """
    try:
        await maintainer.run_forever(stop=stop)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("本机档消费者异常退出")
