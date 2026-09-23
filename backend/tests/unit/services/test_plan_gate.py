"""计划门闸的状态机（P1-1，开发计划 §12.225）。

``plan`` 档的拦与放**只看这一份状态**（"本会话给没给过计划"），所以它自己必须先是对的。
四条边界：

1. **初始是"没给"**：``plan`` 档下一进来就拦（fail-closed，与工具元数据的默认值同口径）；
2. **以正文收尾才算给了计划**：空正文不算（端点抽风不是计划）；
3. **离开 ``plan`` 档就清空**：计划阶段结束了；再切回来是**新的一次**，不该白捡上一份；
4. **按会话隔离**：会话 A 给过计划，不影响会话 B——串了的表现是"某条会话忽然能写了"。

状态放在**进程内存**（取舍写在 ``plan_gate`` 模块头）：所以用例必须自己清，
否则上一个用例留下的状态会传染给下一个（与 ``useLiveTurn`` 那条同一个坑）。
"""

from __future__ import annotations

from app.services import modes, plan_gate


def _gate(conversation_id: str | None = "c1") -> plan_gate.PlanGate:
    plan_gate.reset_all()
    return plan_gate.gate_for(conversation_id)


def test_a_new_session_has_not_given_a_plan_yet() -> None:
    """初始是"没给"：fail-closed 的那一边（``plan`` 档下宁可不写）。"""
    gate = _gate()

    assert gate.plan_given is False
    assert gate.snapshot() == {
        "conversation_id": "c1",
        "plan_given": False,
        "at": 0.0,
        "note": "",
        "generations": 0,
        "mode": "",
    }


def test_an_answer_ending_turn_marks_the_plan_as_given() -> None:
    """**以正文收尾**就算把计划给出来了，并把开头一段留作证据。"""
    gate = _gate()

    gate.note_plan("计划：先读三份文档，再写一份对比笔记，最后导出一份 md。")

    assert gate.plan_given is True
    assert "先读三份文档" in str(gate.snapshot()["note"])


def test_an_empty_answer_is_not_a_plan() -> None:
    """空正文不算：那是端点抽风（推理模型 max_tokens 不够时会这样），不是计划。"""
    gate = _gate()

    gate.note_plan("")
    gate.note_plan("   \n  ")

    assert gate.plan_given is False


def test_leaving_plan_mode_clears_the_state() -> None:
    """切走 ``plan`` 档就清空；再切回来是**新的一次**（不该白捡上一份计划）。"""
    gate = _gate()
    gate.note_plan("计划：做 A、B、C")

    gate.sync_mode(modes.MODE_BUILD)
    assert gate.plan_given is False
    assert gate.snapshot()["generations"] == 1

    # 回到 plan 档：仍然要重新给一次计划
    gate.sync_mode(modes.MODE_PLAN)
    assert gate.plan_given is False
    gate.note_plan("计划：还是那三件事")
    assert gate.plan_given is True


def test_syncing_while_still_in_plan_keeps_the_state() -> None:
    """每一轮开始时都会同步一次档位：**还在 ``plan`` 档就不许把状态冲掉**。

    冲掉的后果很直接——模型给完计划、下一轮准备动手时又被拦一次，
    用户看到的是"它说完了计划却什么都没做"。

    调用顺序就是真实顺序（``tool_loop.run`` 每轮**先同步、再跑**）：
    先 `sync_mode`，那一轮结束以正文收尾时才 `note_plan`。
    """
    gate = _gate()
    gate.sync_mode(modes.MODE_PLAN)
    gate.note_plan("计划：做 A")

    # 下一轮：还在同一档，状态必须留着
    gate.sync_mode(modes.MODE_PLAN)
    gate.sync_mode("plan")

    assert gate.plan_given is True


def test_coming_back_to_plan_mode_starts_a_new_plan_phase() -> None:
    """``plan → build → plan`` 中间**一轮都没跑过**，回到计划档也要重新给一次计划。

    用户把档切来切去又切回来，多半就是"我想让它重新规划一次"。白捡上一段那份计划，
    表现是"我刚切回计划档，它就直接动手了"——而那一档唯一的意义就是先给计划。
    """
    gate = _gate()
    gate.sync_mode(modes.MODE_PLAN)
    gate.note_plan("计划：做 A")

    gate.sync_mode(modes.MODE_BUILD)
    gate.sync_mode(modes.MODE_PLAN)

    assert gate.plan_given is False
    assert gate.snapshot()["mode"] == modes.MODE_PLAN


def test_the_state_is_per_conversation() -> None:
    """按会话隔离：一条会话给过计划**不等于**另一条也给过。"""
    plan_gate.reset_all()
    first = plan_gate.gate_for("c1")
    second = plan_gate.gate_for("c2")

    first.note_plan("计划：做 A")

    assert first.plan_given is True
    assert second.plan_given is False
    # 同一条会话再取一次门闸，拿到的是同一份状态
    assert plan_gate.gate_for("c1").plan_given is True


def test_no_conversation_shares_one_slot() -> None:
    """没有会话上下文的那条链路（脚本、外部 MCP）共用一个格子，**而不是不设门闸**。"""
    gate = _gate(None)

    assert gate.conversation_id == plan_gate.NO_SESSION
    assert gate.plan_given is False  # 照样拦
