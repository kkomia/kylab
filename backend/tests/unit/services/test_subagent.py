"""子 Agent 派生（v0.16）。

镜像同构：``app/services/subagent.py`` → 本文件。

**三件必须做的约束**（模块头那三条）逐一钉住，因为它们的失效方式都是静默的：

1. **深度只能是 1**：允许递归等于允许模型自己决定要花多少钱，而没有哪一层能拦住。
   这里断言的不只是"depth=1 被拒"，还有**子 Agent 的调用面里没有派生能力**；
2. **预算只减不增**：父任务不能把自己的预算转给子任务（否则"派生"就是绕过预算的路）；
3. **范围只继承不扩**：``kb_ids`` 与 ``workspace_id`` 由调用方复制，子 Agent 挑不了。
"""

from __future__ import annotations

import time

import pytest

from app.core.exceptions import InvalidRequestError
from app.services import subagent as sa

# --------------------------------------------------------------------- 深度


def test_depth_zero_can_spawn() -> None:
    """主 Agent（depth=0）可以派。"""
    sa.check_depth(0)


def test_depth_one_cannot_spawn_again() -> None:
    """**子 Agent 不能再派子 Agent**。这条不是"暂时这么定"——
    允许递归就是允许一个"模型自己决定花多少钱"的循环，而没有一层能拦住它。"""
    with pytest.raises(InvalidRequestError) as excinfo:
        sa.check_depth(1)

    assert "不能再派" in str(excinfo.value)


def test_depth_limit_is_explicitly_one() -> None:
    """常量本身就是契约：写成别的值时这条会失败，提醒改的人去读模块头。"""
    assert sa.MAX_DEPTH == 1


# --------------------------------------------------------------------- 预算


def test_budget_counts_down_turns() -> None:
    budget = sa.SubAgentBudget(max_turns=3)

    assert budget.remaining_turns(0) == 3
    assert budget.remaining_turns(3) == 0
    # 用超了也不返回负数（调用方据此判"没预算了"，负数会让那个判断写错）
    assert budget.remaining_turns(5) == 0


def test_budget_expires_by_time() -> None:
    """时限与轮次是**两道独立的闸**：轮次挡"来回很多次"，时限挡"某一次卡很久"。"""
    budget = sa.SubAgentBudget(max_seconds=0.01)
    time.sleep(0.02)

    assert budget.expired is True


def test_budget_has_all_three_knobs() -> None:
    budget = sa.SubAgentBudget()

    assert budget.max_turns > 0
    assert budget.max_seconds > 0
    assert budget.max_searches > 0


# --------------------------------------------------------------------- 任务


def test_task_prompt_is_self_contained() -> None:
    prompt = sa.build_task_prompt(sa.SubAgentTask(question="  查清 A 与 B 谁更快  "))

    assert prompt == "任务：查清 A 与 B 谁更快"


def test_empty_question_is_rejected() -> None:
    with pytest.raises(InvalidRequestError):
        sa.build_task_prompt(sa.SubAgentTask(question="   "))


def test_too_long_question_is_rejected_with_a_useful_message() -> None:
    """太长的任务描述要**说清为什么不行**：子 Agent 看不到父的对话历史，
    任务要自足；但把整段背景搬过来就失去了派它的意义——
    把这句话写进报错里，调用方才知道该改什么。"""
    with pytest.raises(InvalidRequestError) as excinfo:
        sa.build_task_prompt(sa.SubAgentTask(question="很长" * (sa.MAX_TASK_CHARS // 2 + 10)))

    message = str(excinfo.value)
    assert "自足" in message
    assert "压成一句话" in message


def test_task_defaults_are_conservative() -> None:
    """默认值的取舍：**没有知识库范围 = 查不到东西**，所以调用方必须显式给；
    ``workspace_id`` 为空表示"不碰任何工作区"（更保守的默认）。"""
    task = sa.SubAgentTask(question="x")

    assert task.kb_ids == []
    assert task.workspace_id is None
    assert task.depth == 0


# --------------------------------------------------------------------- 提示词


def _plain_prompt() -> str:
    """提示词去掉 Markdown 加粗再断言。

    **不要在断言里手写 ``**``**：提示词的强调写法会变（加粗、换措辞），
    而"这句话在不在"才是要测的东西——写死了标记，改一次排版就红一片，
    那种红不说明任何问题。
    """
    return sa.SUBAGENT_SYSTEM_PROMPT.replace("**", "")


def test_system_prompt_forbids_filling_gaps_from_common_sense() -> None:
    """**"不要拿常识补"是这段提示词里最要紧的一句**：子 Agent 的产出会被父 Agent
    当成有出处的结论用，而拿常识补出来的那部分会让父 Agent 误以为它有依据。"""
    prompt = _plain_prompt()

    assert "资料不足" in prompt
    assert "常识" in prompt
    # 而且要告诉它别再派人（工具面上也做不到，但明说一句省一次无效尝试）
    assert "不能再派生" in prompt


def test_system_prompt_asks_for_conclusions_not_process() -> None:
    """子 Agent 是在**交作业**，不是在跟人对话——所以它不要客套、不要复述过程。
    中间过程留在它那边，这正是"上下文隔离"的收益所在。"""
    prompt = _plain_prompt()

    assert "只给结论与依据" in prompt
    assert "过程" in prompt


# --------------------------------------------------------------------- 结果


def test_result_reports_why_it_stopped() -> None:
    """**不把"没查完"说成"查完了"**：父 Agent 需要知道这段结论有多可靠。"""
    answered = sa.SubAgentResult(answer="结论", stopped_reason="answered")
    budgeted = sa.SubAgentResult(answer="半截结论", stopped_reason="budget")

    assert answered.complete is True
    assert budgeted.complete is False
    assert budgeted.stopped_reason == "budget"


def test_result_carries_sources_so_citations_stay_real() -> None:
    """子 Agent 的出处要带回来：父 Agent 引用这段结论时，出处得是真的。"""
    result = sa.SubAgentResult(answer="结论", sources=["a", "b"], stopped_reason="answered")  # type: ignore[arg-type]

    assert len(result.sources) == 2
