"""组合根装配的冒烟测试（`core/services.py`）。

它是最容易被"改一处忘一处"的地方：新增一个服务却忘了接进 `Services`、
回调闭包漏了某个装配，都不会在别处报错，直到那个功能被用到。
这里只钉"整张图装配齐了、且不落盘"——具体行为归各自的单测。
"""

from __future__ import annotations

from app.core.services import build_services

#: 必须装配齐全的字段（新增服务时同步加进来；漏了就在这里红）。
_EXPECTED = (
    "conversations",
    "artifacts",
    "conversation_export",
    "legacy_import",
    "notes",
    "note_ai",
    "memory",
    "workspaces",
    "skills",
    "skill_market",
    "skill_sources",
    "plugins",
    "mcp",
    "runtime",
    "models",
    "usage",
    "embedder",
    "reranker",
    "chat",
    "api_keys",
    "commands",
    "approvals",
    "load",
    "backup_snapshot",
    "backup_provider",
    "backup_queue",
    "backup_restore",
    "secrets",
    "credentials",
)


def test_build_services_wires_every_component(bundle) -> None:  # type: ignore[no-untyped-def]
    services = build_services(stores=bundle)

    missing = [name for name in _EXPECTED if getattr(services, name, None) is None]
    assert missing == [], f"这些组件没有装配：{missing}"


def test_the_root_carries_the_access_check(bundle) -> None:  # type: ignore[no-untyped-def]
    """`Services.api_keys` 是**本机唯一的调用主体判定**（`api/auth.py` 的两道依赖从它取）。

    判定仍然走它、而不是在协议层改成"不判"：`check_access` 在本机这一档直接放行，
    但"谁是主人"这件事只有一处定义才不会漂。
    """
    services = build_services(stores=bundle)

    assert services.api_keys is not None
    # 知识库服务本体（建库 / 检索 / 表格 / 回收站…）不在根上：本机不持有那些数据
    assert not hasattr(services, "kb")
    assert not hasattr(services, "kb_cache")
    assert not hasattr(services, "provider")


def test_build_services_is_pure_wiring_when_stores_are_given(bundle) -> None:  # type: ignore[no-untyped-def]
    """给了 stores 就不该再去建库/建目录——测试与 CLI 那条路都靠这条。"""
    services = build_services(stores=bundle)

    assert services.conversations is not None
    # 拿到手的就是传进来的这一份存储（不是又建了一个库）
    assert services.runtime._stores is bundle
    assert services.conversations._stores is bundle


def test_the_worker_is_not_a_task_worker(bundle) -> None:  # type: ignore[no-untyped-def]
    """**组合根不再造队列消费者**：摄取那条流水线是知识库那边的家当。

    本机消费者是 `workers/local_worker.py` 的维护器（由 `main.py` 的 lifespan 拉起，
    定时任务那一半 2026-10-09 已删），它不进 `Services`——它没有"认领任务"这件事。
    """
    services = build_services(stores=bundle)

    assert not hasattr(services, "workers")
    assert not hasattr(services, "worker")
