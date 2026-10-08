"""用量采集真的接在调用路径上（G7）。

镜像同构：``ChatService`` 的用量回调 + ``_RuntimeEmbedder`` 的用量记录 → 本文件。

**为什么单独测这个**：``services/usage.py`` 自己的逻辑已经测过了，但"回调到底有没有
被调用"是另一回事——一条永远不触发的埋点看起来完全正常，只是统计页永远空白。
日志、注释、接口形状都不会暴露它，只有真的跑一次对话才会。
"""

from __future__ import annotations

import pytest

from app.services.chat import ChatService, SourceRef
from app.services.llm import ChatMessage, LLMUsage
from app.services.model_registry import ModelRegistryService
from app.services.runtime_config import RuntimeConfigService


def _bound_chat_runtime(bundle):  # type: ignore[no-untyped-def]
    """一个"对话模型已配好"的运行期配置。

    v0.8 起模型身份只从注册表取，所以这里要真的登记一个供应商 + 模型再绑定，
    而不是往 app_settings 里写 ``llm.api_key``（那条路已经不通了）。
    """
    registry = ModelRegistryService(bundle)
    provider = registry.create_provider(
        kind="llm", name="测试供应商", base_url="https://api.example.com", api_key="sk-x"
    )
    model = registry.register_model(
        provider_id=provider.id, model_id="test-model", capabilities=["chat"]
    )
    registry.bind("chat", model.id)
    return RuntimeConfigService(bundle, registry=registry)


@pytest.fixture
def recorded() -> list[dict]:
    return []


@pytest.fixture
def chat(bundle, recorded):  # type: ignore[no-untyped-def]
    runtime = _bound_chat_runtime(bundle)
    service = ChatService(runtime, usage_recorder=lambda **kw: recorded.append(kw))
    return service


class _StubEmbedder:
    dim = 8
    model_id = "stub"
    max_batch = 8
    is_development = True

    def embed(self, texts):  # type: ignore[no-untyped-def]
        return [[0.0] * self.dim for _ in texts]

    def embed_query(self, text: str):  # type: ignore[no-untyped-def]
        return [0.0] * self.dim


class _NoopReranker:
    enabled = False
    model_id = "none"


class _FakeChat:
    """假模型：报告一份固定的 usage。"""

    def __init__(self, usage: LLMUsage | None) -> None:
        self.last_usage = usage

    def complete(self, messages):  # type: ignore[no-untyped-def]
        return "这是回答。[1]"


def _source() -> SourceRef:
    return SourceRef(
        index=1,
        chunk_id="c1",
        document_id="d1",
        document_name="示例.md",
        heading_path=None,
        page=None,
        score=1.0,
        preview="原文",
    )


def test_summarizing_records_usage(chat: ChatService, recorded: list[dict]) -> None:
    """一次上下文压缩（``summarize_history``）必须留下一条用量记录。

    载体是它而不是"一次问答"：问答那条内置链（`ChatService.answer` / `answer_stream`）
    已随"检索走 MCP"整块删除，今天这条链路上会现建客户端、又带用量回调的
    只剩压缩这一次模型调用。
    """
    chat._chat_factory = lambda config: _FakeChat(LLMUsage(120, 80))  # type: ignore[method-assign]

    chat.summarize_history("", [ChatMessage(role="user", content="问题")], None)

    assert len(recorded) == 1
    entry = recorded[0]
    assert entry["kind"] == "chat"
    assert entry["model_id"] == "test-model"
    assert entry["provider"] == "https://api.example.com"
    assert entry["usage"].total_tokens == 200
    assert entry["duration_ms"] >= 0


def test_summarizing_records_even_when_usage_is_missing(
    chat: ChatService, recorded: list[dict]
) -> None:
    """供应商没报用量时**仍要记一条**——否则"调用了几次"也统计不到，
    而那恰恰是唯一还可靠的数字。"""
    chat._chat_factory = lambda config: _FakeChat(None)  # type: ignore[method-assign]

    chat.summarize_history("", [ChatMessage(role="user", content="问题")], None)

    assert len(recorded) == 1
    assert recorded[0]["usage"] is None


def test_chat_without_a_recorder_still_works(bundle) -> None:  # type: ignore[no-untyped-def]
    """**回调缺席时功能照常**：用量统计是可选的旁路，不该成为 ChatService
    的必需依赖（否则所有既有用例都得跟着造一个 recorder）。"""
    runtime = _bound_chat_runtime(bundle)
    service = ChatService(runtime)  # 不传 recorder
    service._chat_factory = lambda config: _FakeChat(LLMUsage(10, 5))  # type: ignore[method-assign]

    summary = service.summarize_history("", [ChatMessage(role="user", content="问题")], None)

    assert summary == "这是回答。[1]"


def test_recorder_exception_does_not_break_the_main_path(bundle) -> None:  # type: ignore[no-untyped-def]
    """回调自己炸了也**不能把主路打断**——用户已经付过这次生成的钱。

    这是容易漏的一处：用量统计是旁路，旁路出问题绝不能反过来打断主路。
    ``UsageService.record`` 内部已经吞了自己那层异常，但回调本身可能被换成
    别的实现（测试注入、将来的上报队列），所以主路也要兜一层。
    """
    runtime = _bound_chat_runtime(bundle)

    def boom(**kwargs: object) -> None:
        raise RuntimeError("统计服务挂了")

    service = ChatService(runtime, usage_recorder=boom)
    service._chat_factory = lambda config: _FakeChat(LLMUsage(10, 5))  # type: ignore[method-assign]

    summary = service.summarize_history("", [ChatMessage(role="user", content="问题")], None)

    assert summary == "这是回答。[1]"


