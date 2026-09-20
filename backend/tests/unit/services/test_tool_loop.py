"""工具循环（P0）。

这一组的重点是**换框架之后那几条不能破的规矩**，而不是"跑通了一次调用"：

1. 模型要工具就给工具、执行结果**回到它手里**（否则它只能猜）；
2. 工具报错**如实回给模型**，不崩整轮、也不伪装成"查过了没有"；
3. 参数不是合法 JSON 时同样回给模型（这是它最常见的一种手滑）；
4. 步数用完时**说出来**，而不是把"没跑完"包装成"跑完了"；
5. 检索工具的**库范围**收在会话选定范围内——关掉知识库开关之后，模型也不该绕过去查。
6. 一批里的几次调用**并发**跑，但事件、消息、编号的顺序仍然是确定的（v0.27）。
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.services.agent import DeltaEvent, DoneEvent, SourcesEvent, StepEvent
from app.services.agent_tools import _scope_search
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

    # **不出现工具步骤**，但作答这一步要在（它是真实动作；界面上少了它会退回
    # 一条会凭空画出"检索知识库"的兜底，见 tool_loop._answer 的说明）
    assert [s.label for s in _steps(events)] == ["组织回答"]
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
    assert labels == ["检索知识库", "检索知识库", "组织回答"]
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
    """步数用完**如实说**，并且仍然按现有信息作答。

    同时它是**这一轮唯一的降级情形**：`degraded=True` 让界面给出重试入口——
    "这次答得浅"与"链路退化了，你可以再要一次"对用户是两件事，
    不说清楚他只会觉得模型不行。
    """
    always = LLMReply(tool_calls=(ToolCall(id="c", name="search", arguments="{}"),))
    loop, _ = _loop([always, always, always], runner=lambda n, a: ToolOutcome("x"), max_steps=2)

    events = list(loop.run(messages=[]))

    limit = next(s for s in _steps(events) if s.label == "工具步数已达上限")
    assert limit.degraded is True
    assert [e.answer for e in events if isinstance(e, DoneEvent)] == ["答案"]


def test_a_normal_run_is_not_degraded() -> None:
    """正常收口的一轮不许挂降级标——挂错了，用户会在没坏的时候被叫去重试。"""
    loop, _ = _loop([LLMReply(text="")], runner=lambda n, a: ToolOutcome("x"))

    events = list(loop.run(messages=[]))

    assert all(not s.degraded for s in _steps(events))


def test_a_search_step_carries_how_many_new_sources_it_added() -> None:
    """``added`` 是过程面板"这轮没找到新资料"的唯一依据，**0 与 None 不是一回事**：

    ``0`` = 查了但什么都没多出来（用户该知道这次白查了）；
    ``None`` = 这一步压根不是检索（列举文档、写笔记……），界面不该对它说"没找到资料"。
    """

    def runner(name: str, args: dict) -> ToolOutcome:  # type: ignore[type-arg]
        return ToolOutcome(content="[1] 指南.pdf\n原文", sources=[_hit()], added=0)

    loop, _ = _loop(
        [
            LLMReply(tool_calls=(ToolCall(id="c1", name="search", arguments="{}"),)),
            LLMReply(text=""),
        ],
        runner=runner,
    )

    events = list(loop.run(messages=[]))

    done = next(s for s in _steps(events) if s.label == "检索知识库" and s.status != "running")
    assert done.added == 0


def test_a_non_retrieval_step_has_no_added() -> None:
    """非检索类工具不带这个数：否则界面会对"写了一条笔记"那一步说"没找到新资料"。"""

    def runner(name: str, args: dict) -> ToolOutcome:  # type: ignore[type-arg]
        return ToolOutcome(content="写好了", summary="写了一条笔记")

    loop, _ = _loop(
        [
            LLMReply(tool_calls=(ToolCall(id="c1", name="create_note", arguments="{}"),)),
            LLMReply(text=""),
        ],
        runner=runner,
    )

    events = list(loop.run(messages=[]))

    done = next(s for s in _steps(events) if s.status != "running" and s.phase == "tool")
    assert done.added is None


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


def test_a_tool_step_carries_its_raw_arguments_and_result() -> None:
    """每一步带上**原文**：入参与返回（v0.25，界面"点开看这一步到底调了什么"）。

    只给 `detail` 那一行结论的话，用户没法判断"检索知识库"这次查的是什么词、
    为什么没命中——而那是他在这一步唯一想知道的事。
    """
    loop, _ = _loop(
        [
            LLMReply(
                tool_calls=(
                    ToolCall(id="c1", name="search", arguments='{"query": "海豹08 贴膜"}'),
                )
            ),
            LLMReply(text="答"),
        ],
        runner=lambda n, a: ToolOutcome("命中 2 段", summary="命中 2 段"),
    )

    steps = _steps(list(loop.run(messages=[])))
    # 每一步都先发一条 `running` 再发 `done`；原文只在 `done` 那条上
    tool_step = next(s for s in steps if s.phase == "tool" and s.status != "running")

    assert tool_step.args == '{"query": "海豹08 贴膜"}'
    assert tool_step.result == "命中 2 段"
    # `detail` 与 `result` 分工不同：前者是结论（人话），后者是原文
    assert tool_step.detail == "命中 2 段"


def test_a_huge_result_is_clipped_and_says_so() -> None:
    """超长结果截断到 `MAX_STEP_PREVIEW_CHARS`，并**如实标注**。

    给模型的上限是 12000 字，那是模型的上下文预算；这一份只是给人看的。
    不标注的话，用户会以为工具只返回了这么多。
    """
    from app.services.tool_loop import MAX_STEP_PREVIEW_CHARS

    loop, _ = _loop(
        [
            LLMReply(tool_calls=(ToolCall(id="c1", name="search", arguments="{}"),)),
            LLMReply(text="答"),
        ],
        runner=lambda n, a: ToolOutcome("x" * (MAX_STEP_PREVIEW_CHARS + 500)),
    )

    steps = _steps(list(loop.run(messages=[])))
    tool_step = next(s for s in steps if s.phase == "tool" and s.status != "running")

    assert len(tool_step.result) < MAX_STEP_PREVIEW_CHARS + 60
    assert "已截断" in tool_step.result
    assert str(MAX_STEP_PREVIEW_CHARS + 500) in tool_step.result


def test_a_step_without_raw_text_leaves_both_empty() -> None:
    """没有原文的步骤（"组织回答"）`args` / `result` 都是空串。

    界面据此**不给展开入口**——点开一个空框比没有那个箭头更让人困惑。
    """
    loop, _ = _loop([LLMReply(text="答")], runner=lambda n, a: ToolOutcome("x"))

    steps = _steps(list(loop.run(messages=[])))
    # 「组织回答」只有一条 running（它没有"完成"事件，完成由 DoneEvent 表达）
    answer = next(s for s in steps if s.phase == "answer")

    assert answer.args == ""
    assert answer.result == ""

# ------------------------------------------------------------------ 子 Agent（P1 补上）


def test_spawn_subagent_is_offered_and_returned_with_sources() -> None:
    """子 Agent 是工具之一：它自包含地跑，结论与出处回到父链路。

    出处要带回来（`SourcesEvent`）：子 Agent 查到的原文同样是这次回答的依据，
    丢了它，界面会显示"没有出处"而实际上是有的。
    """
    from app.services.agent_tools import build_runner

    seen: list[str] = []

    class _Services:
        class skills:
            @staticmethod
            def list():  # type: ignore[no-untyped-def]
                return []

    runner = build_runner(
        _Services(),  # type: ignore[arg-type]
        None,  # type: ignore[arg-type]
        kb_ids=["kb_1"],
        subagent=lambda task: (seen.append(task), ("结论：是的", [_hit()]))[1],
    )

    outcome = runner("spawn_subagent", {"task": "这批文献的结论一致吗"})

    assert seen == ["这批文献的结论一致吗"]
    assert "结论：是的" in outcome.content
    assert outcome.sources and outcome.sources[0].document_name == "指南.pdf"


def test_spawn_subagent_says_so_when_unavailable() -> None:
    """这一轮没有子 Agent 就**明说**：模型据此才该自己去查，而不是以为已经派人查过了。"""
    from app.services.agent_tools import build_runner

    runner = build_runner(_FakeServices(), None, kb_ids=["kb_1"])  # type: ignore[arg-type]

    outcome = runner("spawn_subagent", {"task": "随便什么"})

    assert "不可用" in outcome.content


class _FakeServices:
    """技能工具用到的最小形状。"""

    class skills:
        @staticmethod
        def list():  # type: ignore[no-untyped-def]
            return []


def test_spawn_subagent_requires_a_task() -> None:
    from app.services.agent_tools import build_runner

    runner = build_runner(_FakeServices(), None)  # type: ignore[arg-type]

    assert "task" in runner("spawn_subagent", {}).content


# ------------------------------------------------------------------ 来源账本（v0.20 修）


class _SearchServices:
    """``search`` 那条路要用到的两样：凭据判定与"资料从哪来"。"""

    def __init__(self, batches: list[list[SourceRef]]) -> None:
        self._batches = list(batches)
        self.queries: list[str] = []

        class _Keys:
            @staticmethod
            def check_access(caller, *, kb_ids):  # type: ignore[no-untyped-def]
                return None

        class _Chat:
            def __init__(self, outer) -> None:  # type: ignore[no-untyped-def]
                self._outer = outer

            def retrieve_sources(self, *, query, kb_ids, top_k=None):  # type: ignore[no-untyped-def]
                self._outer.queries.append(query)
                return self._outer._batches.pop(0) if self._outer._batches else []

        self.api_keys = _Keys()
        self.chat = _Chat(self)


def test_sources_are_cumulative_and_renumbered_across_searches() -> None:
    """一轮里查两次拿到**不同**的片段：第二次发出的出处是**累计的**，编号接着往下排。

    这一条守的是引用号。模型一次回答里可能同时引 [1] 与 [2]，而它们来自两次不同的
    检索：如果界面只认最后一批、编号又各自从 1 开始，那么答案里的 [1] 指向的东西
    与用户看到的那一段**不是同一段**——引用看起来有、点开来是错的内容，
    这比"没有引用"更坏。

    两次给**同一段**的情形见下一条（去重）。
    """
    from app.services.agent_tools import build_runner

    services = _SearchServices([[_hit(1)], [_hit(2)]])
    runner = build_runner(services, None, kb_ids=["kb_1"])  # type: ignore[arg-type]

    first = runner("search", {"query": "第一次"})
    second = runner("search", {"query": "第二次"})

    assert [item.index for item in first.sources] == [1]
    assert [item.index for item in second.sources] == [1, 2]
    assert first.added == 1
    assert second.added == 1
    # 渲染给模型的文本用的是**同一套号**：内容与界面必须对得上
    assert second.content.startswith("[2] ")


def test_the_same_chunk_is_never_given_two_numbers() -> None:
    """两轮检索命中**同一段**：只留一条，且先前给出的编号不变。

    换检索词但落点相同是多轮检索里最常见的浪费。不去重的话同一段会占两个引用号：
    界面上两条一模一样的出处，而模型可能各引一次，读者以为那是两份不同的资料。

    **编号不许重排**：第一轮的 ``[1]`` 已经渲染给模型了，重排会让它先前写下的引用
    指向别处——这也是"先到的那条保留原编号、不按分数替换"的原因。
    """
    from app.services.agent_tools import build_runner

    services = _SearchServices([[_hit(1), _hit(2)], [_hit(2), _hit(3)]])
    runner = build_runner(services, None, kb_ids=["kb_1"])  # type: ignore[arg-type]

    first = runner("search", {"query": "第一次"})
    second = runner("search", {"query": "换个说法"})

    assert first.added == 2
    assert second.added == 1  # c2 已经给过了
    assert [item.chunk_id for item in second.sources] == ["c1", "c2", "c3"]
    assert [item.index for item in second.sources] == [1, 2, 3]
    # 给模型的文本只含**新增**那段：重复的那些它上面已经读过了
    assert second.content.startswith("[3] ")
    assert "c1" not in second.content


def test_a_search_that_finds_nothing_new_says_so() -> None:
    """查了但什么都没多出来：``added == 0``，且**话要说明白**。

    这里回"没有命中任何片段"是错的——模型会把它读成"这个库里没有相关资料"，
    于是放弃换角度，而它其实只是重复查了同一处。
    """
    from app.services.agent_tools import build_runner

    services = _SearchServices([[_hit(1)], [_hit(1)]])
    runner = build_runner(services, None, kb_ids=["kb_1"])  # type: ignore[arg-type]

    runner("search", {"query": "第一次"})
    again = runner("search", {"query": "换个说法"})

    assert again.added == 0
    assert "没有新增片段" in again.content
    assert "没有命中任何片段" not in again.content


def test_search_renders_the_material_not_the_raw_hit() -> None:
    """喂给模型的是**整段小节**（``SourceRef.preview``），不是命中的那一块。

    这是 P0 换框架时丢过的东西：工具那条路直接回 chunk，模型读到的上下文变窄，
    而它**看起来完全正常**，只是答得更浅。所以这条用例盯住"用哪一份文本"。
    """
    from app.services.agent_tools import build_runner

    hit = SourceRef(
        index=1,
        chunk_id="c1",
        document_id="d1",
        document_name="指南.pdf",
        heading_path="3 监测",
        page=4,
        score=0.9,
        preview="整段小节：眼轴长度是主要参数。" * 3,
    )
    services = _SearchServices([[hit]])
    runner = build_runner(services, None, kb_ids=["kb_1"])  # type: ignore[arg-type]

    outcome = runner("search", {"query": "眼轴"})

    assert "整段小节" in outcome.content
    assert "指南.pdf › 3 监测（第 4 页）" in outcome.content
    assert outcome.sources == [hit]


def test_search_without_scope_does_not_query_the_retriever() -> None:
    """关掉知识库开关时**一次检索都不发**（不是"查了再丢掉"）。"""
    from app.services.agent_tools import build_runner

    services = _SearchServices([[_hit(1)]])
    runner = build_runner(services, None, kb_ids=[])  # type: ignore[arg-type]

    outcome = runner("search", {"query": "随便"})

    assert services.queries == []
    assert "没有可查的知识库" in outcome.content


def test_step_events_carry_the_raw_tool_name() -> None:
    """步骤事件要带上**原始工具名**（v0.26）。

    界面拿它做两件事：挑图标、把同类调用并成一组。两件都要求它是个稳定标识——
    `label` 是给人看的中文（会被改写），`phase` 更不行（所有工具调用的 phase 都是 `tool`）。
    """
    from app.services.llm import ToolCall
    from app.services.tool_loop import ToolOutcome

    def runner(name: str, args: dict[str, object]) -> ToolOutcome:
        return ToolOutcome(content="好", summary="查了")

    loop, _ = _loop(
        [
            LLMReply(
                tool_calls=(
                    ToolCall(id="c1", name="web_search", arguments="{}"),
                    ToolCall(id="c2", name="web_fetch", arguments="{}"),
                )
            ),
            LLMReply(text="答"),
        ],
        runner=runner,
    )

    events = list(loop.run(messages=[]))
    names = [step.tool for step in _steps(events) if step.phase == "tool"]

    # 每条工具步骤（含 running 那条）都带名字，且是**原始名**不是中文标签
    assert names == ["web_search", "web_search", "web_fetch", "web_fetch"] or names == [
        "web_search",
        "web_fetch",
        "web_search",
        "web_fetch",
    ]
    assert all(name in ("web_search", "web_fetch") for name in names)


# ------------------------------------------------------------------ 并发（v0.27）


def _batch_loop(calls, runner):  # type: ignore[no-untyped-def]
    """两条回复的循环：先给一批调用，再"够了，作答"。"""
    return _loop([LLMReply(tool_calls=tuple(calls)), LLMReply(text="答")], runner=runner)


def test_one_batch_runs_at_the_same_time_but_comes_back_in_order() -> None:
    """同一批里的几件事**并发**跑，结果仍按调用顺序回到模型与界面。

    模型说"这三页互不依赖、一起抓"时（系统提示词第 2 条），串行等它们就是白等——
    等的是同一个网络。但并发**只发生在执行那一段**：事件的顺序必须确定，
    因为界面把 `done` 合进"同名的第一条 running"（前端 `useChatTurns.mergeStep`），
    乱序会让步骤行配错——那是用户唯一能看见这层改动的地方。
    """
    guard = threading.Lock()
    in_flight = 0
    peak = 0

    def runner(name: str, args: dict) -> ToolOutcome:  # type: ignore[type-arg]
        nonlocal in_flight, peak
        with guard:
            in_flight += 1
            peak = max(peak, in_flight)
        time.sleep(0.12)  # 真调用是网络往返；这里只为了让三条真的重叠
        with guard:
            in_flight -= 1
        return ToolOutcome(content=f"结果是{args['q']}", summary=str(args["q"]))

    loop, client = _batch_loop(
        [
            ToolCall(id=f"c{index}", name="search", arguments=f'{{"q": "{word}"}}')
            for index, word in enumerate(("甲", "乙", "丙"))
        ],
        runner,
    )

    events = list(loop.run(messages=[]))

    # 1）三条真的同时在跑（不是"看起来像"）
    assert peak > 1
    # 2）回灌给模型的结果按调用顺序，`tool_call_id` 各自配对
    tool_messages = [m for m in client.answer_messages or [] if m.role == "tool"]
    assert [m.content for m in tool_messages] == ["结果是甲", "结果是乙", "结果是丙"]
    assert [m.tool_call_id for m in tool_messages] == ["c0", "c1", "c2"]
    # 3）界面上的 done 也按调用顺序（用入参认人：三条的 label 一模一样）
    tool_steps = [s for s in _steps(events) if s.phase == "tool"]
    assert [s.status for s in tool_steps] == ["running"] * 3 + ["done"] * 3
    assert [s.args for s in tool_steps if s.status == "done"] == [
        '{"q": "甲"}',
        '{"q": "乙"}',
        '{"q": "丙"}',
    ]


def test_a_single_call_does_not_pay_for_a_pool() -> None:
    """一条调用是常态：为它建线程池是白付一层开销（也少一处可出错的地方）。

    不建池这件事本身不可见，可见的是**结果一样**——所以这条用例盯的是
    "走单条那条路也照样把结果按顺序回灌"。
    """
    loop, client = _batch_loop(
        [ToolCall(id="c1", name="search", arguments='{"q": "甲"}')],
        lambda name, args: ToolOutcome(content="结果", summary="查了"),
    )

    list(loop.run(messages=[]))

    tool_messages = [m for m in client.answer_messages or [] if m.role == "tool"]
    assert [m.content for m in tool_messages] == ["结果"]


def test_a_batch_emits_one_cumulative_source_list() -> None:
    """一批里的出处**并成一条累计的发出去**，而不是每条调用各发一条。

    每条 `ToolOutcome.sources` 都是"那一刻的账本"快照（账本本身是累计的），
    而并发下**按调用顺序排在最后的那条未必是最晚跑完的**：先跑完的那条可能带着
    更全的账本。界面只认最后一次 `SourcesEvent`，取"最后一条"会把资料丢掉——
    正是账本当初要解决的那个问题（见 `agent_tools.build_runner`）。
    """

    def runner(name: str, args: dict) -> ToolOutcome:  # type: ignore[type-arg]
        if args["q"] == "排在前面但后跑完":
            return ToolOutcome(content="甲", sources=[_hit(1), _hit(2)])
        # 这一条排在后面，但它跑得快、快照只到第 1 条
        return ToolOutcome(content="乙", sources=[_hit(1)])

    loop, _ = _batch_loop(
        [
            ToolCall(id="c1", name="search", arguments='{"q": "排在前面但后跑完"}'),
            ToolCall(id="c2", name="search", arguments='{"q": "排在后面先跑完"}'),
        ],
        runner,
    )

    events = list(loop.run(messages=[]))
    sources = [e for e in events if isinstance(e, SourcesEvent)]

    assert len(sources) == 1
    assert [ref.index for ref in sources[0].sources] == [1, 2]


def test_selection_and_answer_use_the_same_client() -> None:
    """挑工具与作答**同一个客户端、同一档思考**（v0.27 试过拆开，撤了）。

    拆开的收益是"选工具那一步不思考"（实测单次往返 1.18s → 0.68s），
    但多步循环里"下一步做什么、几件事能不能一起发、这条路走不通换哪条"都是思考
    产出的判断，而拆开之后模型在工具轮里连自己上一轮想过什么都看不见。
    这条用例守着"不拆"：两处调用都走 `client_factory`。
    """
    client = _FakeClient([LLMReply(text="")])
    loop = ToolLoop(
        client_factory=lambda: client,
        tools=[SEARCH],
        runner=lambda name, args: ToolOutcome("好"),
    )

    list(loop.run(messages=[]))

    assert len(client.calls) == 1  # 挑工具
    assert client.answer_messages is not None  # 作答


def test_two_searches_at_the_same_time_never_share_a_number() -> None:
    """并发查几次：**编号不重不漏**。

    账本（`agent_tools.build_runner` 里的 `book`）是共享可变状态，而工具循环会把
    同一批里的几次调用并发跑（v0.27）。没有锁时两个线程会同时读到"账本里有 N 条"、
    各自从 N+1 开始编——同一段资料占两个号，或者一条编号谁也没占；
    模型引 [2] 而界面上第 2 条是另一段，引用看起来有、点开来是错的内容。

    这条用例守的是**不变量**（每段一个号、号不重不漏），不是复现某一次故障：
    竞态窗口很窄，去掉锁也不一定每次都红。
    """
    from app.services.agent_tools import build_runner

    barrier = threading.Barrier(4)

    class _Services:
        class _Keys:
            @staticmethod
            def check_access(caller, *, kb_ids):  # type: ignore[no-untyped-def]
                return None

        class _Chat:
            @staticmethod
            def retrieve_sources(*, query, kb_ids, top_k=None):  # type: ignore[no-untyped-def]
                barrier.wait(timeout=10)  # 把几次检索挤到同一刻，账本才会被抢
                return [_hit(int(query))]

        api_keys = _Keys()
        chat = _Chat()

    runner = build_runner(_Services(), None, kb_ids=["kb_1"])  # type: ignore[arg-type]

    with ThreadPoolExecutor(max_workers=4) as pool:
        outcomes = list(pool.map(lambda q: runner("search", {"query": q}), ["1", "2", "3", "4"]))

    seen: dict[str, set[int]] = {}
    for outcome in outcomes:
        for ref in outcome.sources:
            seen.setdefault(ref.chunk_id, set()).add(ref.index)

    assert sum(outcome.added for outcome in outcomes) == 4
    assert all(len(indexes) == 1 for indexes in seen.values())  # 一段资料只有一个号
    assert sorted({ref.index for outcome in outcomes for ref in outcome.sources}) == [1, 2, 3, 4]


def test_the_ledger_lets_only_one_thread_in_at_a_time(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """账本的互斥是**真的**：把 `_absorb` 换成一个会睡一会儿的版本，看有没有重叠。

    为什么不用"跑几次看编号对不对"来验：`_absorb` 从头到尾只占一个 GIL 时间片，
    **去掉锁也很少真的交错**（实测连跑 8 次全绿）——那种用例守的是不变量，
    抓不到"锁被删了"。这里反过来盯过程：只要两个线程同时进过 `_absorb` 的峰值是 1，
    互斥就在；锁被拿掉时它是 2，用例立刻红。
    """
    from app.services import agent_tools

    real_absorb = agent_tools._absorb
    inside = 0
    peak = 0
    guard = threading.Lock()

    def slow_absorb(book, incoming):  # type: ignore[no-untyped-def]
        nonlocal inside, peak
        with guard:
            inside += 1
            peak = max(peak, inside)
        time.sleep(0.15)  # 真检索在 `_absorb` 之前就把网络往返等掉了，这里只是把它挪进来
        with guard:
            inside -= 1
        return real_absorb(book, incoming)

    monkeypatch.setattr(agent_tools, "_absorb", slow_absorb)

    class _Services:
        class _Keys:
            @staticmethod
            def check_access(caller, *, kb_ids):  # type: ignore[no-untyped-def]
                return None

        class _Chat:
            @staticmethod
            def retrieve_sources(*, query, kb_ids, top_k=None):  # type: ignore[no-untyped-def]
                return [_hit(int(query))]

        api_keys = _Keys()
        chat = _Chat()

    runner = agent_tools.build_runner(_Services(), None, kb_ids=["kb_1"])  # type: ignore[arg-type]

    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(lambda q: runner("search", {"query": q}), ["1", "2", "3"]))

    assert peak == 1


def test_the_assistant_message_carries_the_selection_reasoning() -> None:
    """选工具那一轮想的东西，要跟着助手消息回到下一轮请求里（v0.27）。

    `LLMReply.reasoning` → `ChatMessage.reasoning` 这一段是**端点强制要求**的
    （DeepSeek 在思考模式下缺这个字段直接 400，实测见 `thinking.ECHO_DIALECTS`）。
    循环如果在这里把它丢掉，故障会出现在**下一轮请求**上——离起因已经很远，
    所以在这一层钉住它。
    """
    loop, client = _loop(
        [
            LLMReply(
                tool_calls=(ToolCall(id="c1", name="search", arguments="{}"),),
                reasoning="先查一下眼轴的共识。",
            ),
            LLMReply(text="答"),
        ],
        runner=lambda name, args: ToolOutcome("结果"),
    )

    list(loop.run(messages=[]))

    assistant = next(m for m in client.answer_messages or [] if m.role == "assistant")
    assert assistant.reasoning == "先查一下眼轴的共识。"
    # 工具结果那条不该带（它不是模型想出来的东西）
    tool_message = next(m for m in client.answer_messages or [] if m.role == "tool")
    assert tool_message.reasoning is None

# ------------------------------------------------------------------ 墙钟闸（§12.211）


class _Clock:
    """可推进的假时钟。用例不必真的 sleep 到超时，也就能稳定停在"跨过上限那一步"。"""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_wall_clock_expiry_says_so_and_answers_with_what_it_has() -> None:
    """时间到 → **如实说、按现有信息作答**，与步数用尽走同一条降级路径。

    这道闸挡的是"某一步卡很久"：下面这个 runner 一跑就吃掉 30 秒，步数一动不动地耗着。
    两者分开成两道闸的理由见 `tool_loop.DEFAULT_MAX_SECONDS`。
    """
    always = LLMReply(tool_calls=(ToolCall(id="c", name="search", arguments="{}"),))
    clock = _Clock()
    ran: list[str] = []

    def slow_tool(name: str, args: dict) -> ToolOutcome:  # type: ignore[type-arg]
        ran.append(name)
        clock.now += 30.0  # 这一步自己很慢
        return ToolOutcome("x")

    loop, client = _loop(
        [always, always, always], runner=slow_tool, max_seconds=10.0, clock=clock
    )

    events = list(loop.run(messages=[]))

    timeout = next(s for s in _steps(events) if s.label == "本轮时间已用尽")
    assert timeout.degraded is True
    assert "最多 10 秒" in (timeout.detail or "")
    # 慢工具只跑了一次：时间到之后**没有再开新的一轮 LLM 调用**
    assert ran == ["search"]
    assert len(client.calls) == 1
    assert [e.answer for e in events if isinstance(e, DoneEvent)] == ["答案"]
    # 与"步数用尽"是**两条不同的提示**：用户看到"慢"和看到"多"，下一步该做的事不一样
    assert not any(s.label == "工具步数已达上限" for s in _steps(events))


def test_expired_clock_blocks_the_batch_before_it_runs() -> None:
    """模型自己"想"超时了：这一批工具**不执行**，把"没时间了"回给它。

    省下的是真实调用——而模型下一轮照样得给出回答（`_answer` 兜底）。
    """
    always = LLMReply(tool_calls=(ToolCall(id="c", name="search", arguments="{}"),))
    clock = _Clock()
    ran: list[str] = []

    class _SlowModel(_FakeClient):
        def complete_with_tools(self, messages, tools):  # type: ignore[no-untyped-def]
            clock.now += 30.0
            return super().complete_with_tools(messages, tools)

    client = _SlowModel([always, always])
    loop = ToolLoop(
        client_factory=lambda: client,
        tools=[SEARCH],
        runner=lambda name, args: (ran.append(name), ToolOutcome("x"))[1],
        max_seconds=10.0,
        clock=clock,
    )

    messages = []
    events = list(loop.run(messages=messages))

    assert ran == [], "超时之后这一批工具不该真的跑"
    # 回给模型的是"没时间了"这句话，而不是任何一个工具结果——它下一轮据此直接作答
    tool_messages = [m for m in messages if getattr(m, "role", "") == "tool"]
    assert len(tool_messages) == 1
    assert "时间已用尽" in (tool_messages[0].content or "")
    timeout = next(s for s in _steps(events) if s.label == "本轮时间已用尽")
    assert timeout.degraded is True


def test_zero_budget_is_clamped_not_a_way_to_disable_tools() -> None:
    """`max_seconds=0` 被夹到 1 秒：**它不等于"关掉这道闸"**，而等于"关掉所有工具"。

    想关就传一个大数。这条钉住那个夹取，免得有人照着"0 = 不限制"的直觉去用。
    """
    always = LLMReply(tool_calls=(ToolCall(id="c", name="search", arguments="{}"),))
    ran: list[str] = []
    loop, _ = _loop(
        [always, LLMReply(text="")],
        runner=lambda name, args: (ran.append(name), ToolOutcome("x"))[1],
        max_seconds=0.0,
    )

    list(loop.run(messages=[]))

    assert ran == ["search"], "夹到 1 秒之后，第一次调用仍该执行"
