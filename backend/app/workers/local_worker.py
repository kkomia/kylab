"""本机消费者：定时任务到点跑 + 本机库的空闲维护。

这个进程只服务**这台机器**，而它手上真正需要有人定期做的事只有两件：

1. **定时任务到点了没人跑**：调度记录落在本机库的 `scheduled_tasks` 表里
   （`ScheduleRepo` 属本机域），"到点"判定也在本机（`due_scheduled_tasks`）——
   没有这一环，界面上建好的任务永远是"下次运行时间"往后跳、什么也不发生；
2. **本机库只增不减**：`usage_events` 有保留期（`usage.USAGE_RETENTION_DAYS`），
   幂等键同理——没有这一环它们一次都不会被清。

所以这一模块只做这两件事，**一行摄取都不做**：摄取（解析 / 切块 / 嵌入 / 向量索引）
是知识库那边的家当，本机连那几张表都没有（知识库在别处，本机是它的客户端）。

**安全边界**：本机的空闲维护**只调用本机域那几个方法**（过期的用量行与幂等键，
保留期分别是 180 天与存储层自己那条）。不往知识库那份维护清单上凑：里面那些
（清回收站 / 任务与阶段事件 / 文档摘要）动的是知识库的数据，而那些数据不在这台机器上，
判定必须跟着数据走。

**默认起、可关**：它只做"用户自己建过的定时任务"与"到期的本机行"，没有一条是
"用户没要过的动作"，所以默认就起（`KYLAB_RUN_WORKER=false` 可以关掉）。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING
from uuid import uuid4

from app.services.schedule_runner import run_scheduled_task

if TYPE_CHECKING:  # 只为标注：组合根与本模块互相是对方的调用方，运行时导入会成环
    from app.core.services import Services

__all__ = ["LocalScheduler", "bind_local_scheduler", "run_local_scheduler"]

logger = logging.getLogger(__name__)

#: 运行 id 的前缀（"这一次运行"的标识）。与队列任务 id（``task_``）刻意不同：
#: 本机档没有队列表，这个 id 不进任何表，只在"立即跑一次"的响应里当标识用
#: （见 `services/schedules.py::run_now` 的说明）。
RUN_ID_PREFIX = "localrun_"

#: 两个节拍。**原先住在 ``workers/queue_worker.py``**（服务器档那个消费者）——
#: 那个消费者随服务器档一起删了，常量搬到这里，值一个没动。
#: ``DEFAULT_MAINTAIN_INTERVAL``：本机库的空闲维护一小时一次（防表长大）；
#: ``DEFAULT_SCHEDULE_INTERVAL``：定时任务到点判定 20 秒一轮。
DEFAULT_MAINTAIN_INTERVAL = 3600.0
DEFAULT_SCHEDULE_INTERVAL = 20.0


class LocalScheduler:
    """本机档的消费者：定时任务到点就跑 + 本机库的空闲维护。

    它同时是 `services/schedules.ScheduleService` 要的那个 ``ScheduleRunner``
    （``submit`` 那一个方法）——**装配点只有一处**（``bind_local_scheduler``），
    因为"谁来跑这条到点的任务"这件事不该有两个答案。
    """

    def __init__(
        self,
        services: Services,
        *,
        interval: float = DEFAULT_SCHEDULE_INTERVAL,
        maintain_interval: float = DEFAULT_MAINTAIN_INTERVAL,
    ) -> None:
        self._services = services
        self._interval = interval
        self._maintain_interval = maintain_interval
        # 单线程：一轮问答（几分钟、要调模型）自己排好队，不并发——
        # 本机档的定时任务多半是"汇总昨天"这种，两条一起跑只会互相抢模型额度与磁盘写锁。
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="local-schedule")
        self._busy = False

    # ---------------------------------------------------------------- 接缝（ScheduleRunner）

    def submit(self, scheduled_id: str) -> str:
        """排一条进本机运行队列，**立刻返回**这次运行的标识（真跑在后台线程里）。

        为什么不像服务器档那样"入队 + 由消费者认领"：本机没有那张队列表
        （见模块头）。这一层就是那条链在本机的最小替身，而"到点判定 / CAS 认领 /
        下一次时刻"仍然共用 `ScheduleService` 里那一份（不抄第二遍 cron 逻辑）。
        """
        run_id = f"{RUN_ID_PREFIX}{uuid4().hex[:12]}"
        logger.info("本机档：定时任务 %s 开跑（%s）", scheduled_id, run_id)
        self._pool.submit(self._run_one, scheduled_id)
        return run_id

    # ---------------------------------------------------------------- 循环

    async def run_forever(self, *, stop: asyncio.Event | None = None) -> None:
        """跑到 ``stop`` 置位（与服务器档消费者同一条退出语义：**不取消、自己收工**）。

        `stop` 由调用方（两个入口的 lifespan）给：置位后两条循环立刻从
        ``wait_for(stopping.wait(), …)`` 醒来返回，不会多等一个间隔。
        """
        stopping = stop or asyncio.Event()
        try:
            async with asyncio.TaskGroup() as group:
                group.create_task(self._schedule_loop(stopping))
                group.create_task(self._maintain_loop(stopping))
        finally:
            # 正在跑的那一轮**不打断**（它会自己把会话与 `last_status` 写完），
            # 但不在这里干等：卡住关停比丢一轮更糟。`ThreadPoolExecutor` 的线程
            # 会在解释器退出时被 join，所以那一轮仍然跑得完。
            if self._busy:
                logger.info("本机档：还有一轮定时任务在跑，关停不等它（它会自己收尾）")
            self._pool.shutdown(wait=False)

    async def _schedule_loop(self, stopping: asyncio.Event) -> None:
        """按 `DEFAULT_SCHEDULE_INTERVAL` 扫一遍"有没有定时任务到点"。

        与服务器档那条 ``_schedule_loop`` 同一条理由、同一个默认节奏（20 秒 ≈ cron 的
        最小粒度）：它做的事（"这条到点了没有"）与手上有没有活干无关，所以**独立成一条
        循环**，不挂在别的分支上。扫与认领都要写库（``arm_scheduled_task`` 是一次 CAS），
        所以丢进线程跑，不占事件循环。
        """
        while not stopping.is_set():
            try:
                count = await asyncio.to_thread(self._services.schedules.run_due)
            except Exception:
                logger.warning("本机档：扫描定时任务失败，跳过本轮", exc_info=True)
            else:
                if count:
                    logger.info("本机档：定时任务到点 %d 条（已交给本机运行队列）", count)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stopping.wait(), timeout=self._interval)

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

        两件，都是"本来就没有调用者"的承诺——写在存储层很久了，但从没人调，
        于是"保留 180 天"和"键不会无限增长"实际上都没发生：

        - 过期的用量行（`usage_events` 是本机域唯一的"有保留期的表"）；
        - 过期的幂等键（`purge_expired`）。

        逐件吞异常：一件失败不该让另一件也不跑，更不该影响消费。
        """
        try:
            removed = self._services.usage.purge_expired()
        except Exception:
            logger.warning("本机档：清理过期用量记录失败", exc_info=True)
        else:
            if removed:
                logger.info("本机档：清理过期用量记录 %d 条", removed)
        try:
            keys = self._services.idempotency.purge_expired()
        except Exception:
            logger.warning("本机档：清理过期幂等键失败", exc_info=True)
        else:
            if keys:
                logger.info("本机档：清理过期幂等键 %d 条", keys)

    # ---------------------------------------------------------------- 跑一条

    def _run_one(self, scheduled_id: str) -> None:
        """真跑一轮（在运行线程里）。**失败必须落到调度的状态上**，不能只有日志。

        `run_scheduled_task` 自己会写 ``last_status`` / ``last_error``（成功、降级、失败
        三种都写，见 `services/schedule_runner.py`），所以这里只兜住它抛出来的异常——
        否则线程池会把它吞成一条看不见的 traceback，而界面上那条任务会永远停在"还在跑"。
        """
        self._busy = True
        try:
            run_scheduled_task(self._services, scheduled_id)
        except Exception as exc:
            logger.warning("本机档：定时任务 %s 这一轮没跑成：%s", scheduled_id, exc)
        finally:
            self._busy = False


def bind_local_scheduler(services: Services, **kwargs: float) -> LocalScheduler:
    """装好本机消费者并**挂上接缝**（两个入口各调一次，实现只有这一份）。

    为什么两个入口都要调：桌面壳起的是**边车**（`python -m app.sidecar`，端口 8765），
    而"本机档后端"那个入口（`app.main`，`KYLAB_DEPLOYMENT=local`）是另一条路径——
    两边的本机库里是同一张 `scheduled_tasks` 表，所以"到点跑"这件事两边都该有人做。
    同时起两个也不会跑两遍：认领是一次 CAS（``arm_scheduled_task``），
    第二个进程要么认领失败、要么在下一轮看到 ``next_run_at`` 已经推到下一个周期。
    """
    scheduler = LocalScheduler(services, **kwargs)  # type: ignore[arg-type]
    services.schedules.bind_runner(scheduler)
    return scheduler


async def run_local_scheduler(scheduler: LocalScheduler, stop: asyncio.Event) -> None:
    """跑消费循环并兜住异常（与 `main.py::_run_worker` 同一条口径）。

    取消原样上抛：``CancelledError`` 被吞掉的话 asyncio 会以为它正常结束了，
    取消语义就丢了（那条教训写在 `main.py` 里）。
    """
    try:
        await scheduler.run_forever(stop=stop)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("本机档消费者异常退出")
