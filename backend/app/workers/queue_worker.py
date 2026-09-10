"""异步任务消费者（M2 T2.2 的调度侧）。

把 SQLite 任务表当成队列用（架构 §2.1：不引入 Redis，重启可恢复）：

- **领取是原子单语句**（见 ``MetaStore.claim_task``），多个 worker 不会双领；
- **执行期间持续续租**：解析可能跑几分钟，租约到期被别人回收就会重复干活；
- **长任务放线程池**：摄入是同步阻塞逻辑，直接在事件循环里跑会卡住所有 API 请求
  （这正是计划风险登记册 R5 提到的"云端解析轮询拖垮单进程 asyncio"）；
- **失败按指数退避重回队列**，超过 ``max_attempts`` 才判终态失败（架构 §4）。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import UTC, datetime, timedelta

from app.core.exceptions import NotFoundError
from app.models.enums import TaskKind, TaskState
from app.services.ingest import IngestService
from app.storage.base import StoreBundle, TaskRecord

logger = logging.getLogger(__name__)

DEFAULT_LEASE_SECONDS = 60
DEFAULT_POLL_INTERVAL = 0.5
DEFAULT_BASE_BACKOFF = 2.0
DEFAULT_MAX_BACKOFF = 60.0

HANDLED_KINDS = frozenset(
    {
        TaskKind.PROBE,
        TaskKind.PARSE,
        TaskKind.CHUNK,
        TaskKind.EMBED,
    }
)
"""当前已接线的任务类型。删除与数据源拉取分别在 M6 接。"""


class TaskWorker:
    """单消费者。多进程/多协程只需各自实例化（``owner`` 不同即可）。"""

    def __init__(
        self,
        stores: StoreBundle,
        ingest: IngestService,
        *,
        owner: str,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        base_backoff: float = DEFAULT_BASE_BACKOFF,
        max_backoff: float = DEFAULT_MAX_BACKOFF,
    ) -> None:
        if lease_seconds <= 0:
            raise ValueError("租约时长必须为正")
        self._stores = stores
        self._ingest = ingest
        self._owner = owner
        self._lease_seconds = lease_seconds
        self._poll_interval = poll_interval
        self._base_backoff = base_backoff
        self._max_backoff = max_backoff
        self._current_task_id: str | None = None
        self._thread: asyncio.Task[None] | None = None

    @property
    def owner(self) -> str:
        return self._owner

    # ------------------------------------------------------------------ 主循环

    async def run_once(self) -> bool:
        """处理一个任务；没有可领任务返回 False（便于测试与优雅退出）。"""
        task = self._stores.meta.claim_task(owner=self._owner, lease_seconds=self._lease_seconds)
        if task is None:
            return False

        logger.info("领取任务 %s（%s，第 %d 次）", task.id, task.kind.value, task.attempts)
        try:
            await self._execute_with_heartbeat(task)
        except Exception as exc:
            self._retry_or_fail(task, exc)
        else:
            if self._stores.meta.finish_task(task.id, TaskState.SUCCEEDED, owner=self._owner):
                logger.info("任务 %s 完成", task.id)
            else:
                # 租约已经不在自己手上：这一份的成败不归我写，等新主人按自己的节奏收尾
                logger.warning("任务 %s 的租约已易主，放弃写入成功状态", task.id)
        return True

    async def run_forever(self, *, stop: asyncio.Event | None = None) -> None:
        """持续消费，直到 ``stop`` 被置位、租约被抢走，或者自己被取消。

        消费循环与续租循环同属一个 ``TaskGroup``，但要注意 ``TaskGroup`` 的语义：
        **子任务正常返回不会取消它的兄弟**，它会一直等下去。所以租约被抢时
        续租循环必须自己把 ``stopping`` 置位，否则消费循环会毫无察觉地继续领新任务。

        退出时还要**把手上的活收完**：``await asyncio.to_thread(...)`` 被取消
        **不会**让线程里的摄入停下来，它会继续写库——"循环停了"不等于"文档写完了"。
        收尾在 ``_execute_with_heartbeat`` 里做，这里的 ``finally`` 只是兜底。
        """
        stopping = stop or asyncio.Event()
        try:
            async with asyncio.TaskGroup() as group:
                group.create_task(self._consume_loop(stopping))
                group.create_task(self._beat_loop(stopping))
        finally:
            await self._drain_thread()

    async def _consume_loop(self, stopping: asyncio.Event) -> None:
        while not stopping.is_set():
            try:
                worked = await self.run_once()
            except Exception:
                # TaskGroup 会把异常当"要收工"处理，所以偶发故障必须在这里兜住，
                # 否则一次存储抖动就把整个消费者带走了
                logger.exception("worker 循环出现未预期异常，继续运行")
                worked = False
            if not worked:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(stopping.wait(), timeout=self._poll_interval)

    # ------------------------------------------------------------------ 单任务执行

    async def _execute_with_heartbeat(self, task: TaskRecord) -> None:
        """把同步摄入丢进线程池。

        取消到达时先等线程收尾再上抛：``to_thread`` 被取消不会让线程里的摄入停下来，
        不 Handle 的话取消一返回、事件循环一关，那份文档就停在写了一半的状态。
        """
        self._current_task_id = task.id
        self._thread = asyncio.create_task(asyncio.to_thread(self._handle, task))
        try:
            # shield：先不让取消打断线程，交给下面这个 except 里统一收尾
            await asyncio.shield(self._thread)
        except asyncio.CancelledError:
            await self._drain_thread()
            raise
        finally:
            self._current_task_id = None

    async def _drain_thread(self) -> None:
        """等线程池里那份摄入写完（幂等，写完再停比半途丢下安全）。"""
        thread = self._thread
        if thread is None or thread.done():
            return
        logger.info("等待当前任务收尾")
        with contextlib.suppress(Exception):
            await asyncio.shield(thread)

    async def _beat_loop(self, stopping: asyncio.Event) -> None:
        """按租约的三分之一周期续租；租约不再属于自己就置位 ``stopping`` 收工。

        这里**不抛异常**：租约被抢说明另一个消费者在跑同一份任务，而摄入是按已有产物
        续跑的（幂等），让它写完比写一半时硬拽回来更安全。终态写入另有 ``owner``
        条件更新兜底，不会被这次过期的执行结果覆盖。

        **续租失败也不许把消费者带走**：这个循环跑在 ``TaskGroup`` 里，
        异常会一路冒到 ``run_forever``，结果是"存储抖动一次 → 消费者整个死掉"，
        而手上那份摄入还在线程里继续跑。偶发失败只记日志；
        真的连不上库时租约自然过期，由 ``reclaim_expired_tasks`` 兜底回收。
        """
        interval = max(self._lease_seconds / 3, 0.1)
        while not stopping.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stopping.wait(), timeout=interval)
            task_id = self._current_task_id
            if task_id is None:
                continue  # 空闲，没有需要保住的租约
            try:
                still_mine = self._stores.meta.heartbeat_task(
                    task_id, owner=self._owner, lease_seconds=self._lease_seconds
                )
            except Exception:
                logger.exception("续租失败，本轮跳过（租约过期后由回收机制兜底）")
                continue
            if not still_mine:
                logger.warning("任务 %s 的租约已被回收，本 worker 停止领取新任务", task_id)
                stopping.set()
                return

    def _handle(self, task: TaskRecord) -> None:
        if task.kind not in HANDLED_KINDS:
            raise NotImplementedError(f"任务类型尚未接线：{task.kind.value}")
        if not task.document_id:
            raise ValueError(f"任务 {task.id} 缺少 document_id")
        self._ingest.ingest(task.document_id)

    # ------------------------------------------------------------------ 重试策略

    def _retry_or_fail(self, task: TaskRecord, exc: Exception) -> None:
        message = str(exc)
        stage = getattr(exc, "stage", None)
        detail = f"[{stage}] {message}" if stage else message

        if is_retryable(exc) and task.attempts < task.max_attempts:
            delay = self.backoff_for(task.attempts)
            if not self._stores.meta.reschedule_task(
                task.id,
                owner=self._owner,
                next_run_at=datetime.now(UTC) + timedelta(seconds=delay),
                error=detail,
            ):
                logger.warning("任务 %s 的租约已易主，放弃安排重试", task.id)
                return
            logger.warning(
                "任务 %s 第 %d 次失败，%.1fs 后重试：%s", task.id, task.attempts, delay, detail
            )
            return

        if not self._stores.meta.finish_task(
            task.id, TaskState.FAILED, owner=self._owner, error=detail
        ):
            logger.warning("任务 %s 的租约已易主，放弃写入失败状态", task.id)
            return
        logger.error(
            "任务 %s 判定失败（已尝试 %d 次，可重试=%s）：%s",
            task.id,
            task.attempts,
            is_retryable(exc),
            detail,
        )

    def backoff_for(self, attempts: int) -> float:
        """指数退避：2s、4s、8s…上限 ``max_backoff``（架构 §4 的"指数退避"）。"""
        exponent = max(attempts - 1, 0)
        return float(min(self._max_backoff, self._base_backoff * (2**exponent)))


NON_RETRYABLE = (NotImplementedError, ValueError, NotFoundError)
"""重试没有意义的异常：类型没接线、参数非法、目标不存在——重试一千次结果一样，只会刷日志。

与文档级失败的区别：解析失败/端点抖动属于可重试（``IngestError``、``EmbeddingError``）。
"""


def is_retryable(exc: Exception) -> bool:
    return not isinstance(exc, NON_RETRYABLE)
