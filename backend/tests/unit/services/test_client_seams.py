"""两条接缝的"可替换"用例（Phase B 第一刀）。

这一轮的验收不是"新功能" ✓，而是**证明接缝真的可换** ✓：

1. **模型侧**：`llm.OpenAICompatChat` 结构上满足 `ModelClient` ✓（同名的三个方法 ✓）——
   于是"把模型换成服务器代理"不需要改循环 ✗；
2. **KB 侧**：`ChatService.retrieve_sources` 的签名与 `KnowledgeClient` 一致 ✓，
   而且**一个假实现能顶上去**跑通"检索 → 拿回带编号的出处"这条链 ✓ ——
   这正是边车模式（本地循环 + 远端 KB）要的形状 ✓。

**反向验证**：把协议里的方法名改掉（或让假实现少一个方法）→ 用例必须红 ✓。
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence

from app.services.chat import ChatService, SourceRef
from app.services.knowledge_client import KnowledgeClient
from app.services.llm import ChatMessage, LLMConfig, LLMDelta, OpenAICompatChat, ToolSpec
from app.services.model_client import ModelClient


class _FakeModelClient:
    """一个**完全进程内**的假模型（不动网络 ✓）：证明循环只需要这三个方法。"""

    def __init__(self, reply: str = "假回答") -> None:
        self.reply = reply
        self.seen: list[Sequence[ChatMessage]] = []

    def complete(self, messages: Sequence[ChatMessage]) -> str:
        self.seen.append(messages)
        return self.reply

    def stream(self, messages: Sequence[ChatMessage]) -> Iterator[str]:
        self.seen.append(messages)
        yield self.reply

    def stream_events(
        self, messages: Sequence[ChatMessage], tools: Sequence[ToolSpec] | None = None
    ) -> Iterator[LLMDelta]:
        self.seen.append(messages)
        yield LLMDelta(text=self.reply)


class _FakeKnowledgeClient:
    """一个假的 KB（不动库 ✓）：边车模式下它就是"打服务器"的那份实现。"""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def retrieve_sources(
        self,
        *,
        query: str,
        kb_ids: list[str],
        top_k: int | None = None,
        candidate_k: int = 40,
        reader: object | None = None,
    ) -> list[SourceRef]:
        self.calls.append({"query": query, "kb_ids": kb_ids, "top_k": top_k})
        return [
            SourceRef(
                index=1,
                chunk_id="c1",
                document_id="d1",
                document_name="指南.pdf",
                heading_path="第 3 章",
                page=7,
                score=0.5,
                preview="原文",
            )
        ]


def test_the_in_process_model_client_satisfies_the_protocol() -> None:
    """**默认实现就是协议的一份实现** ✓ —— 于是换实现不必改循环。"""
    client = OpenAICompatChat(
        LLMConfig(base_url="http://localhost:1", model_id="m", api_key="k")
    )

    assert isinstance(client, ModelClient)
    # 三个方法一个都不能少（少了服务器代理就装不进去 ✗）
    for name in ("complete", "stream", "stream_events"):
        assert callable(getattr(client, name))


def test_a_fake_model_client_is_usable_where_the_protocol_is_expected() -> None:
    """假的也能顶上：**循环只认这三个方法** ✓（这条就是"可替换"的证明）。"""
    fake = _FakeModelClient()

    assert isinstance(fake, ModelClient)
    assert fake.complete([ChatMessage(role="user", content="问题")]) == "假回答"
    chunks = list(fake.stream([ChatMessage(role="user", content="问题")]))
    assert chunks == ["假回答"]
    deltas = list(fake.stream_events([ChatMessage(role="user", content="问题")]))
    assert [d.text for d in deltas] == ["假回答"]


def test_the_in_process_knowledge_client_satisfies_the_protocol() -> None:
    """`ChatService` 那个方法就是协议的一份实现 ✓（签名逐字一致 ✓）。"""
    assert hasattr(ChatService, "retrieve_sources")

    # 关键字参数形状一致（`query` 必须是关键字——子 Agent 那条链踩过位置参数的坑 ✓）
    import inspect

    signature = inspect.signature(ChatService.retrieve_sources)
    parameters = list(signature.parameters)
    assert "query" in parameters
    assert parameters[1] in ("query",) or signature.parameters["query"].kind.name == "KEYWORD_ONLY"


def test_a_fake_knowledge_client_is_usable_where_the_protocol_is_expected() -> None:
    """假的 KB 能顶上，并且**拿回的是同一形状的出处** ✓（边车模式要的就是这个）。"""
    fake = _FakeKnowledgeClient()

    assert isinstance(fake, KnowledgeClient)
    sources = fake.retrieve_sources(query="储能", kb_ids=["kb_1"], top_k=3)

    assert [source.index for source in sources] == [1]
    assert sources[0].document_name == "指南.pdf"
    assert fake.calls == [{"query": "储能", "kb_ids": ["kb_1"], "top_k": 3}]
