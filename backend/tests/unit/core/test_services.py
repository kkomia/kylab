"""组合根装配的冒烟测试（`core/services.py`）。

它是最容易被"改一处忘一处"的地方：新增一个服务却忘了接进 `Services`、
回调闭包漏了某个装配，都不会在别处报错，直到那个功能被用到。
这里只钉"整张图装配齐了、且不落盘"——具体行为归各自的单测。
"""

from __future__ import annotations

from app.core.services import KbServices, Services, build_services, get_kb_services

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
    "schedules",
    "runtime",
    "models",
    "usage",
    "embedder",
    "reranker",
    "chat",
    "kb",
    "commands",
    "approvals",
    "load",
    "provider",
    "kb_cache",
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


def test_the_kb_slot_carries_what_is_left_of_the_kb_face(bundle) -> None:  # type: ignore[no-untyped-def]
    """`Services.kb` 那一格只装三样：凭据判定 + 入库两条接缝。

    **名字不能改**：`scripts/check_domains.py` 用 `services.kb.<字段>` 这个形状识别
    "经组合根取 KB 域服务"。而**它只装这三样**——知识库服务本体（建库 / 检索 /
    表格 / 回收站…）随知识库产品剥离搬走了，本机不持有那些数据。
    """
    services = build_services(stores=bundle)

    assert isinstance(services.kb, KbServices)
    assert services.kb.api_keys is not None
    # 本机这一档两条接缝都是**提供者网关**（打远端），不是进程内那套服务
    assert not hasattr(services.kb, "knowledge_bases")
    assert not hasattr(services.kb, "retrieval")
    assert not hasattr(services.kb, "tabular")


def test_get_kb_services_is_the_same_slot(bundle) -> None:  # type: ignore[no-untyped-def]
    """进程里只有一份图：`get_kb_services()` 就是根上那一格，不二次装配。

    二次装配的后果是两份 `StoreBundle`、两个补传线程、两份运行期配置
    （于是"设置页存进去了、聊天那边读不到"这类最难查的分叉）。判据是**同一对象**，
    不是"两个等价的图"。
    """
    from app.core.services import get_services

    assert isinstance(get_services(), Services)
    assert get_kb_services() is get_services().kb


def test_build_services_is_pure_wiring_when_stores_are_given(bundle) -> None:  # type: ignore[no-untyped-def]
    """给了 stores 就不该再去建库/建目录——测试与 CLI 那条路都靠这条。"""
    services = build_services(stores=bundle)

    assert services.conversations is not None
    # 拿到手的就是传进来的这一份存储（不是又建了一个库）
    assert services.runtime._stores is bundle
    assert services.conversations._stores is bundle


def test_the_worker_is_not_a_task_worker(bundle) -> None:  # type: ignore[no-untyped-def]
    """**组合根不再造队列消费者**：摄取那条流水线是知识库那边的家当。

    本机消费者是 `workers/local_worker.py` 的调度器（由 `main.py` 的 lifespan 拉起
    并 bind 到 `services.schedules`），它不进 `Services`——它没有"认领任务"这件事。
    """
    services = build_services(stores=bundle)

    assert not hasattr(services, "workers")
    assert not hasattr(services, "worker")


def test_the_kb_read_line_is_bound_to_the_provider(bundle) -> None:  # type: ignore[no-untyped-def]
    """**装配期那一处后挂**：`stores.meta.kb` 的 reader 指向提供者客户端。

    没挂上的话，凡是走 `stores.meta` 的 KB 元数据读都会抛"知识库提供者还没接上
    （组合根未装配）"——而那是**装配漏了一处**，不是"这台机器没接提供者"。
    """
    services = build_services(stores=bundle)

    reader = bundle.meta.kb._reader  # type: ignore[attr-defined]
    assert reader is not None
    # 缓存包在 reader **外面**：页面面与 reader 面读的是同一份快照、同一套排程
    # （两个入口各建一个缓存就会各排各的，那正是"再验证风暴"的来源）
    assert reader._cache is services.kb_cache
