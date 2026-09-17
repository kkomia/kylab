"""工具循环（P0）。

这一组的重点是**换框架之后那几条不能破的规矩**，而不是"跑通了一次调用"：

1. 模型要工具就给工具、执行结果**回到它手里**（否则它只能猜）；
2. 工具报错**如实回给模型**，不崩整轮、也不伪装成"查过了没有"；
3. 参数不是合法 JSON 时同样回给模型（这是它最常见的一种手滑）；
4. 步数用完时**说出来**，而不是把"没跑完"包装成"跑完了"；
5. 检索工具的**库范围**收在会话选定范围内——关掉知识库开关之后，模型也不该绕过去查。
"""

from __future__ import annotations

import pytest

from app.agent_tools import _scope_search
from app.services.agent import DeltaEvent, DoneEvent, SourcesEvent, StepEvent
from app.services.chat import SourceRef
from app.services.llm import LLMDelta, LLMReply, ToolCall, ToolSpec
from app.services.tool_loop import ToolLoop, ToolOutcome, _parse_arguments, _truncate

SEARCH = ToolSpec(name="search", description="查", parameters={"type": "object"})


def _hit(index: int = 1) -> SourceRef:
    return SourceRef(
        index=index,
        chunk_id=f"c{index}",
        document_id="d1",
        document_name="指南.pdf",
        preview="原文",
    )


class _FakeClient:
    """按剧本走：每次 ``complete_with_tools`` 取一条预置回复。"""

    def __init__(self, replies: list[LLMReply], answer: str = "答案") -> None:
        self._replies = list(replies)
        self._answer = answer
        self.calls: list[list] = []  # type: ignore[type-arg]
        self.answer_messages: list | None = None

    def complete_with_tools(self, messages, tools):  # type: ignore[no-untyped-def]
        self.calls.append(list(messages))
        if not self._replies:
            raise AssertionError("剧本里的回复用完了")
        return self._replies.pop(0)

    def stream_events(self, messages):  # type: ignore[no-untyped-def]
        self.answer_messages = list(messages)
        yield LLMDelta(text=self._answer)


def _loop(replies: list[LLMReply], runner, **kwargs) -> tuple[ToolLoop, _FakeClient]:  # type: ignore[no-untyped-def]
    client = _FakeClient(replies)
    return (
        ToolLoop(client_factory=lambda: client, tools=[SEARCH], runner=runner, **kwargs),
        client,
    )


def _steps(events: list) -> list[StepEvent]:
    return [e for e in events if isinstance(e, StepEvent)]


# ------------------------------------------------------------------ 正常路径


def test_model_can_answer_without_any_tool() -> None:
    """它直接答：不许平白多调一次工具，也不该出现工具步骤。"""
    loop, client = _loop([LLMReply(text="")], runner=lambda name, args: ToolOutcome("x"))

    events = list(loop.run(messages=[]))

    assert _steps(events) == []
    assert [e.text for e in events if isinstance(e, DeltaEvent)] == ["答案"]
    assert [e.answer for e in events if isinstance(e, DoneEvent)] == ["答案"]
    assert len(client.calls) == 1


def test_tool_call_runs_and_its_result_goes_back_to_the_model() -> None:
    """**这是换框架的核心**：模型要求检索 → 我们执行 → 结果回到它手里 → 它再作答。"""
    calls: list[tuple[str, dict]] = []  # type: ignore[type-arg]

    def runner(name: str, args: dict) -> ToolOutcome:  # type: ignore[type-arg]
        calls.append((name, args))
        return ToolOutcome(content="[1] 指南.pdf\n原文片段", sources=[_hit()])

    loop, client = _loop(
        [
            LLMReply(
                tool_calls=(
                    ToolCall(id="c1", name="search", arguments='{"query":"眼轴"}'),
                )
            ),
            # 工具跑完之后**会再问一次模型**（还要不要继续调、还是可以答了）——
            # 所以要给第二条：它表示"够了，作答"
            LLMReply(),
        ],
        runner=runner,
    )

    events = list(loop.run(messages=[]))

    assert calls == [("search", {"query": "眼轴"})]
    # 工具结果以 role="tool" 回灌，并带 tool_call_id 配对（少了它 OpenAI 兼容端点会 400）
    tool_messages = [m for m in client.answer_messages or [] if m.role == "tool"]
    assert len(tool_messages) == 1
    assert tool_messages[0].tool_call_id == "c1"
    assert "原文片段" in tool_messages[0].content
    # 助手那条带着 tool_calls：协议要求调用与结果配对出现
    assistant = [m for m in client.answer_messages or [] if m.role == "assistant"]
    assert assistant and assistant[0].tool_calls[0].name == "search"
    # 界面上要出现这一步与出处
    labels = [s.label for s in _steps(events)]
    assert labels == ["检索知识库", "检索知识库"]
    sources = [e for e in events if isinstance(e, SourcesEvent)]
    assert sources and sources[0].sources[0].document_name == "指南.pdf"


def test_without_tools_it_just_answers() -> None:
    """一个工具都没有的环境（没绑 runner）：直接答，不装作考虑过用工具。"""
    client = _FakeClient([])
    loop = ToolLoop(client_factory=lambda: client, tools=[], runner=lambda n, a: ToolOutcome(""))

    events = list(loop.run(messages=[]))

    assert [e.answer for e in events if isinstance(e, DoneEvent)] == ["答案"]
    assert client.calls == []


# ------------------------------------------------------------------ 失败要与模型对话


def test_tool_failure_returns_to_the_model_instead_of_raising() -> None:
    """工具是外部世界，什么都能抛。**抛出去整轮就废了**，而多数失败模型自己能纠正。"""

    def runner(name: str, args: dict) -> ToolOutcome:  # type: ignore[arg-type]
        raise RuntimeError("服务连不上")

    loop, client = _loop(
        [LLMReply(tool_calls=(ToolCall(id="c1", name="search", arguments="{}"),)), LLMReply()],
        runner=runner,
    )

    events = list(loop.run(messages=[]))

    tool_message = next(m for m in client.answer_messages or [] if m.role == "tool")
    assert "工具执行失败" in tool_message.content
    assert "服务连不上" in tool_message.content
    # 整轮照常收尾
    assert [e.answer for e in events if isinstance(e, DoneEvent)] == ["答案"]


def test_bad_arguments_are_reported_back() -> None:
    """模型给的参数不是合法 JSON：回给它，让它自己改。"""
    ran: list[str] = []
    loop, client = _loop(
        [
            LLMReply(tool_calls=(ToolCall(id="c1", name="search", arguments="{不是 JSON"),)),
            LLMReply(),
        ],
        runner=lambda name, args: (ran.append(name), ToolOutcome("x"))[1],  # type: ignore[arg-type]
    )

    list(loop.run(messages=[]))

    assert ran == []  # 参数坏的时候**不执行**：拿半截参数去跑真东西更危险
    tool_message = next(m for m in client.answer_messages or [] if m.role == "tool")
    assert "不是合法 JSON" in tool_message.content


def test_step_budget_says_so_instead_of_pretending() -> None:
    """步数用完**如实说**，并且仍然按现有信息作答。"""
    always = LLMReply(tool_calls=(ToolCall(id="c", name="search", arguments="{}"),))
    loop, _ = _loop([always, always, always], runner=lambda n, a: ToolOutcome("x"), max_steps=2)

    events = list(loop.run(messages=[]))

    assert any(s.label == "工具步数已达上限" for s in _steps(events))
    assert [e.answer for e in events if isinstance(e, DoneEvent)] == ["答案"]


# ------------------------------------------------------------------ 参数解析


def test_argument_parsing_tolerates_the_usual_slips() -> None:
    assert _parse_arguments("") == {}
    assert _parse_arguments("null") == {}
    assert _parse_arguments('{"a": 1}') == {"a": 1}
    # 有的模型把参数对象再序列化一层
    assert _parse_arguments('"{\\"a\\": 1}"') == {"a": 1}


def test_argument_parsing_rejects_what_it_cannot_trust() -> None:
    for bad in ("[1,2]", "不是 JSON", '"..."'):
        with pytest.raises(ValueError):
            _parse_arguments(bad)


def test_long_results_are_truncated_and_marked() -> None:
    """截断**要说明**：悄悄截断会让模型以为"这就是全部"。"""
    outcome = _truncate(ToolOutcome(content="字" * 20000))

    assert "已截断" in outcome.content
    assert len(outcome.content) < 20000


# ------------------------------------------------------------------ 检索的库范围


def test_search_scope_is_injected_when_the_model_does_not_say() -> None:
    """模型通常不知道有哪些库：没指定就用会话选定的那几个，不逼它先列一遍。"""
    assert _scope_search({"query": "x"}, ["kb_1"]) == {
        "query": "x",
        "knowledge_base_ids": ["kb_1"],
    }


def test_search_scope_is_intersected_when_the_model_says() -> None:
    scoped = _scope_search({"query": "x", "knowledge_base_ids": ["kb_2", "kb_9"]}, ["kb_1", "kb_2"])

    assert scoped is not None and scoped["knowledge_base_ids"] == ["kb_2"]


def test_search_outside_the_scope_is_refused() -> None:
    """越界**拒绝**而不是悄悄换成允许的库：换了它会把别处的结论按在这个库上说。"""
    assert _scope_search({"query": "x", "knowledge_base_ids": ["kb_9"]}, ["kb_1"]) is None


def test_search_without_any_scope_is_refused() -> None:
    """关掉知识库开关（这一轮没有可查的库）：检索直接拒绝。

    这一条就是那个开关的意义所在——它不该只挡界面，模型也不该能绕过去查。
    """
    assert _scope_search({"query": "x"}, []) is None

def test_step_detail_prefers_the_human_summary() -> None:
    """过程面板显示**人话**而不是结构化结果。

    实测的真机一轮里，这一行曾经直接显示 `[{"id": "kb_...", "name": ...`——
    结果是给模型的，界面要的是"这次拿到了什么"。
    """
    outcome = ToolOutcome(content='[{"id": "kb_1", "name": "库"}]', summary="共 3 个知识库")

    assert outcome.step_detail() == "共 3 个知识库"
    # 没有摘要时**回退到结果开头**（不如不显示）
    assert ToolOutcome(content="一段结果").step_detail() == "一段结果"
