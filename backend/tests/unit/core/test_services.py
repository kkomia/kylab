"""组合根装配的冒烟测试（`core/services.py`）。

它是最容易被"改一处忘一处"的地方：新增一个服务却忘了接进 `Services`、
回调闭包漏了某个装配，都不会在别处报错，直到那个功能被用到。
这里只钉"整张图装配齐了、且不落盘"——具体行为归各自的单测。
"""

from __future__ import annotations

from app.core.services import build_services

#: 必须装配齐全的字段（新增服务时同步加进来；漏了就在这里红）。
_EXPECTED = (
    "knowledge_bases",
    "documents",
    "ingest",
    "retrieval",
    "chat",
    "stats",
    "runtime",
    "api_keys",
    "idempotency",
    "chunks",
    "models",
    "usage",
    "users",
    "auth",
    "shares",
    "lifecycle",
    "sources",
    "observability",
    "tabular",
    "conversations",
    "suggested_questions",
    "webhooks",
    "embedder",
    "reranker",
    "worker",
)


def test_build_services_wires_every_component(bundle) -> None:  # type: ignore[no-untyped-def]
    services = build_services(stores=bundle)

    missing = [name for name in _EXPECTED if getattr(services, name, None) is None]
    assert missing == [], f"这些组件没有装配：{missing}"


def test_build_services_is_pure_wiring_when_stores_are_given(bundle) -> None:  # type: ignore[no-untyped-def]
    """给了 stores 就不该再去建库/建目录——测试与 MCP 进程都靠这条。"""
    before = bundle.meta.list_knowledge_bases()

    services = build_services(stores=bundle)

    assert services.knowledge_bases is not None
    assert bundle.meta.list_knowledge_bases() == before


def test_suggested_questions_and_chat_share_the_same_chat_service(bundle) -> None:  # type: ignore[no-untyped-def]
    """示例问题用的是同一个对话服务（否则两处的模型选择与未配置报错口径会分叉）。"""
    services = build_services(stores=bundle)

    assert services.suggested_questions._chat is services.chat
