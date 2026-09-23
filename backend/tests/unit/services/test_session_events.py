"""会话事件日志的词表与投影（P0-2，抄 ZCode 的只追加事件日志）。

这一组守的是这条设计的**核心验收**：「从事件重建的步骤快照与
``chat_messages.steps`` 等价」。等价不靠两边各自小心，而靠**同一份写侧映射**
（``agent.step_snapshot`` 被写侧与投影共用）——所以这里的用例钉住的是那条
换算的边界：哪些 kind 进投影、``running`` 那条为什么被筛掉、
空字段为什么不留键（留了就不等于快照了）。

端到端那一半在 ``tests/integration/api/test_chat_api.py``：
一轮真问答跑完，比对"库里的事件投影出来的 steps"与"消息里存的 steps"。
"""

from __future__ import annotations

from app.services.agent import StepEvent, step_snapshot
from app.services.session_events import (
    EVENT_KINDS,
    KIND_COMMAND,
    KIND_ERROR,
    KIND_INTERRUPTED,
    KIND_MODE_CHANGED,
    KIND_STEP,
    KIND_THINKING,
    KIND_TOOL_CALL,
    STEP_KINDS,
    TURN_STATUSES,
    EventDraft,
    SessionEvent,
    command_draft,
    interrupted_payload,
    mode_changed_draft,
    step_event_draft,
    steps_from_events,
    thinking_draft,
    turn_end_draft,
    turn_start_draft,
)


def _tool(call_id: str = "c1") -> StepEvent:
    return StepEvent(phase="tool", label="检索知识库", tool="search", status="running")


def test_the_word_table_is_the_trimmed_zcode_enum() -> None:
    """词表**只有这九个**（照调研报告 §2.1 的枚举裁到我们有的）。

    多一个少一个都是设计变更：多出来的 kind 没有生产者（读的人会以为漏了），
    少一个则会让某条链路悄悄退回"不记日志"。
    ``mode/changed``（P1-1 遗留 #6）与 ``command``（P1-2）是后来补的两条：
    前者抄 ZCode 的 ``SessionModeChanged``，后者抄 DSH 的"命令写 session log"。
    """
    assert EVENT_KINDS == (
        "turn/start",
        "turn/end",
        "step",
        "tool_call",
        "thinking",
        "error",
        "interrupted",
        "mode/changed",
        "command",
    )
    assert frozenset({KIND_STEP, KIND_TOOL_CALL}) == STEP_KINDS
    # 终止原因是枚举（调研报告 §2.1 第 2 条）：四个取值，没有"其他"
    assert set(TURN_STATUSES) == {"ok", "degraded", "error", "empty"}


def test_turn_start_carries_the_mode_and_nothing_extra_when_absent() -> None:
    """``turn/start`` 带上这一轮的档；没给时不写这个键（照快照那套"空字段不留键"）。

    ``mode`` 是 ``ModeWatch`` 判定"档换过了没有"的基线（见 services/commands），
    所以它必须真的落在事件里，而不是只活在内存里。
    """
    draft = turn_start_draft(query="问题", model_pk="m1", mode="plan")
    assert draft.payload["mode"] == "plan"
    assert "mode" not in turn_start_draft(query="问题", model_pk=None).payload


def test_mode_changed_payload_is_the_zcode_shape() -> None:
    """``mode/changed`` 的三个字段（P1-1 遗留 #6）。

    "从哪一档换到哪一档、谁切的"缺一不可：只有"现在是 yolo"回答不了
    "它是什么时候开始不问我的"（调研报告 §2.6 抄点第 4 条）。
    """
    draft = mode_changed_draft(previous_mode="build", mode="yolo", source="command")
    assert draft.kind == KIND_MODE_CHANGED
    assert draft.payload == {"previousMode": "build", "mode": "yolo", "source": "command"}


def test_command_draft_keeps_only_what_is_needed() -> None:
    """``command`` 只留"敲了哪条、带什么参数、结果是什么"（P1-2，DSH 那一半）。"""
    draft = command_draft(name="mode", args="plan", result="已切到「计划」档", ok=True)
    assert draft.kind == KIND_COMMAND
    assert draft.payload["name"] == "mode"
    assert draft.payload["args"] == "plan"
    assert draft.payload["ok"] is True
    # 空字段不留键：一条没有参数的命令不必给日志加一个空串
    assert "args" not in command_draft(name="help").payload


def test_a_tool_step_is_recorded_as_a_tool_call_not_as_two_events() -> None:
    """带 ``tool`` 的一步记成 ``tool_call``，其余记成 ``step``——**不写两条**。

    ZCode 把步骤序列与 ``ToolCall{...}`` 分成两族事件，我们这里的一步就是一次
    工具调用（一次调用两条事件：running 那条是「开始」、done 那条带结果），
    再补一条重复的只会让日志翻倍、投影还得去重。
    """
    draft = step_event_draft(_tool())
    assert draft.kind == KIND_TOOL_CALL
    assert draft.payload["tool"] == "search"

    plain = step_event_draft(StepEvent(phase="answer", label="组织回答", status="running"))
    assert plain.kind == KIND_STEP


def test_running_steps_are_logged_but_do_not_reach_the_snapshot() -> None:
    """``running`` 那条**进日志、不进投影**——两边各有各的必要。

    投影不进它：回看时多一行没有结论的步骤没有意义（``agent.step_snapshot``
    当年的取舍）。日志要留它：中断时"哪些调用没有结果"正是从这些 running 里
    数出来的（QwenPaw 那条教训）。
    """
    running = step_event_draft(_tool())
    assert running.payload["status"] == "running"
    assert steps_from_events([running]) == [], "running 的调用不该出现在快照里"

    # 唯一的例外：「组织回答」的 running 也要进快照（它的完成由 done 事件表达，
    # 不带上它就少了最后那一行——见 `agent.step_snapshot`）
    answering = step_event_draft(
        StepEvent(phase="answer", label="组织回答", status="running")
    )
    assert [item["label"] for item in steps_from_events([answering])] == ["组织回答"]


def test_the_projection_equals_the_snapshot_it_shares_code_with() -> None:
    """写侧映射与投影**逐字一致**：同一批事件投影出来的就是快照那份形状。

    这条是"等价"在单元层的表达：**期望值由 `agent.step_snapshot` 现算**，
    而不是在这里手抄一份——手抄的那份哪天就会与真快照分叉，而分叉的表现是
    "端到端比对红了，但红的地方离原因很远"。
    """
    step_events = [
        _tool(),
        StepEvent(
            phase="tool",
            label="检索知识库",
            tool="search",
            detail="命中 3 段原文",
            added=3,
            args='{"query": "眼轴"}',
            result="……",
            artifacts=({"artifact_id": "art_1", "name": "报告.docx"},),
        ),
        StepEvent(phase="answer", label="组织回答", status="running"),
    ]
    events: list[EventDraft] = [
        turn_start_draft(query="问题", model_pk="pk_1"),
        *(step_event_draft(event) for event in step_events),
        turn_end_draft(status="ok", answer_chars=12, steps=2),
    ]

    expected = [snapshot for snapshot in map(step_snapshot, step_events) if snapshot is not None]
    assert expected, "这几条里至少有一条该进快照，否则这条用例什么也没测"
    assert steps_from_events(events) == expected


def test_non_step_kinds_never_enter_the_snapshot() -> None:
    """``turn/*``、``thinking``、``error``、``interrupted`` 都不进过程面板。"""
    events = [
        turn_start_draft(query="问题", model_pk=None),
        thinking_draft(),
        EventDraft(kind=KIND_ERROR, payload={"message": "失败"}),
        EventDraft(kind=KIND_INTERRUPTED, payload=interrupted_payload(reason="停止")),
        turn_end_draft(status="error", answer_chars=0, steps=0),
    ]
    assert steps_from_events(events) == []


def test_the_interrupted_payload_carries_the_unpaired_calls() -> None:
    """中断要能回答"哪些调用没有结果"（QwenPaw 那条教训的落点）。"""
    payload = interrupted_payload(
        reason="客户端断开或用户停止",
        unpaired=[{"tool": "search", "label": "检索知识库"}],
        answer="写到一半的",
    )
    assert payload["reason"] == "客户端断开或用户停止"
    assert payload["unpaired"] == [{"tool": "search", "label": "检索知识库"}]
    assert payload["answer"] == "写到一半的"

    # 正文一个字都没有时不留这个键（与快照"空字段不写键"同一口径）
    assert "answer" not in interrupted_payload(reason="停止")


def test_a_thinking_delta_accumulates_into_one_event() -> None:
    """一段连续思考在日志里只占**一条**：增量拼进同一个 payload。

    每来一块写一行的代价是实打实的：长思考有几百块，而它们在投影里毫无区别
    （思考不进 steps）。
    """
    draft = thinking_draft()
    events = [draft]
    for piece in ("先看", "再查", "最后答"):
        draft.payload["text"] = f"{draft.payload['text']}{piece}"
    assert events[0].kind == KIND_THINKING
    assert events[0].payload["text"] == "先看再查最后答"


def test_the_projection_reads_both_drafts_and_stored_events() -> None:
    """同一段代码同时服务两个方向：写侧自检（草稿）与读端点（库里的事件）。"""
    draft = step_event_draft(
        StepEvent(phase="tool", label="检索知识库", tool="search", status="done")
    )
    stored = SessionEvent(
        id=7,
        seq=2,
        kind=draft.kind,
        payload=dict(draft.payload),
        created_at=None,
    )
    assert steps_from_events([stored]) == steps_from_events([draft]) == [dict(draft.payload)]
