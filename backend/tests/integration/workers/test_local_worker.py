"""本机档的消费者（`app/workers/local_worker.py`）。

它 2026-10-09 起只剩一件事：**本机库的空闲维护**（过期的用量行）。

原先这里还钉着定时任务那一半（到点交给本机运行队列 / 本机档真去入队会抛 /
没挂接缝一条都不跑 / 接缝→后台线程那一跳）——那一半随定时任务模块整块删掉，
那四条用例一起没了。留在这里的是与"维护那一半"直接相关的两件事：

1. **它只碰本机表**：调的是 `UsageService.purge_expired`（本机 `usage_events`）——
   服务器那份 `_maintain` 里的回收站 / 任务 / 阶段事件一件都不许在本机跑
   （那些数据在 NAS 上）；
2. **两个入口都装得上**（`bind_local_maintainer`）：边车与 `app.main` 各有自己的
   lifespan，实现只有这一份。

不需要任何外部服务：它只用本机 SQLite 与文件系统。
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Iterator

import pytest

from app.core.config import get_settings
from app.core.services import get_services, reset_services
from app.core.storage import reset_stores
from app.workers import local_worker


@contextlib.contextmanager
def _local(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """钉死本机档（与 `test_local_signing_secret._local_app` 同一手法）。

    这一档只能落本机库：而本机档见到连接串会当场拒绝启动（"两个真相源"那条）。
    """
    get_settings.cache_clear()
    reset_services()
    reset_stores()
    try:
        yield
    finally:
        reset_services()
        reset_stores()
        get_settings.cache_clear()


def test_bind_local_maintainer_builds_a_maintainer(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """两个入口都调它：拿到的是一个真维护器（组合根那一侧只此一份实现）。"""
    with _local(monkeypatch):
        maintainer = local_worker.bind_local_maintainer(get_services())
        assert isinstance(maintainer, local_worker.LocalMaintainer)


def test_the_maintenance_pass_only_touches_local_tables(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """维护那一轮**只调本机域那一件**：`UsageService.purge_expired`。

    它挂在这里是因为本来就没有别的调用者——`purge_expired` 写在存储层很久了，
    没有这一环"保留 180 天"实际上不会发生。

    等的是**条件**（假替身跑完那一轮把事件置位），不是墙钟：`_maintain` 跑在
    `asyncio.to_thread` 里，那一轮回来就置位；`run_forever` 本身是无限循环，
    等到之后用 stop 事件收工（不会多等一个 `maintain_interval`）。
    """
    with _local(monkeypatch):
        services = get_services()
        calls: list[str] = []
        loop = asyncio.new_event_loop()
        done = asyncio.Event()

        def fake_purge() -> int:
            calls.append("usage.purge_expired")
            loop.call_soon_threadsafe(done.set)
            return 3

        monkeypatch.setattr(services.usage, "purge_expired", fake_purge)
        maintainer = local_worker.bind_local_maintainer(services, maintain_interval=0.01)

        async def scenario() -> None:
            stop = asyncio.Event()
            task = asyncio.create_task(maintainer.run_forever(stop=stop))
            await asyncio.wait_for(done.wait(), timeout=5.0)
            stop.set()
            await asyncio.wait_for(task, timeout=5.0)

        try:
            asyncio.set_event_loop(loop)
            loop.run_until_complete(scenario())
        finally:
            asyncio.set_event_loop(None)
            loop.close()
        assert calls == ["usage.purge_expired"]
