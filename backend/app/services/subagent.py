"""子 Agent 派生（v0.16，设计见 ``docs/设计/Agent-工作区与能力层设计-v0.1.md`` §6.3）。

QwenPaw 的 "Sub-agents at runtime"：一个 Agent 可以**派一个独立的子 Agent**去干
一件自成体系的事，拿回结论继续干自己的。它有用的地方很具体：

- **上下文隔离**：一件需要翻十几份材料才能下结论的事，把那些中间过程留在子 Agent 里，
  父 Agent 只拿到一段结论——否则父的上下文会被中间过程撑满；
- **任务边界清楚**：子 Agent 拿到的是一个**自足的任务描述**，而不是"接着聊"，
  这会逼调用方把任务说清楚（说不清的任务本来也不该派出去）。

**三件必须做的约束**（这是本模块存在的理由，不是可选优化）：

1. **深度只能是 1**。子 Agent 不能再派子 Agent：允许递归等于允许一个
   "模型自己决定要花多少钱"的循环，而没有任何一层能把它拦住。
   实现上不是"检查 depth 然后继续"，而是**子 Agent 的工具集里根本没有 spawn**。
2. **预算**：轮次与时间都有上限。超了就带着"已经查到什么"收尾，
   而不是继续跑——一个跑不完的子任务不该把父任务一起拖死。
3. **范围只能继承，不能扩**：子 Agent 拿到的是父的那份知识库范围与工作区，
   **不能自己挑库**。否则"派个子 Agent"就成了绕过权限检查的一条路。

**它不是"再开一个进程"**：子 Agent 跑在同一个进程里（同一份检索、同一份模型配置），
只是**独立的一套上下文与一个更小的工具面**。这样"派生"的代价是一次模型调用，
而不是一次进程启动。
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from app.core.exceptions import InvalidRequestError

if TYPE_CHECKING:  # 只为类型标注：运行时不需要，避免与 chat.py 循环导入
    from app.services.chat import SourceRef

__all__ = [
    "MAX_DEPTH",
    "SubAgentBudget",
    "SubAgentResult",
    "SubAgentTask",
    "build_task_prompt",
]

logger = logging.getLogger(__name__)

#: **最大派生深度**。1 = 只有主 Agent 能派，子 Agent 不能。
#: 不是"我们暂时设成 1"，而是**设计上就该是 1**：见模块头第 1 条。
MAX_DEPTH = 1

#: 一个子任务最多几轮（一次工具调用算一轮）。
MAX_TURNS = 3

#: 一个子任务的总时限（秒）。与轮次上限是两道独立的闸：
#: 轮次挡住"来回很多次"，时限挡住"某一次调用卡很久"。
MAX_SECONDS = 90.0

#: 子任务的检索次数上限。搜索是这个 Agent 最贵的动作，单独限一道。
MAX_SEARCHES = 3

#: 派给子 Agent 的任务描述长度上限。**超长说明调用方没想清楚**：
#: 子任务该是一句自足的话，不是一篇背景材料。
MAX_TASK_CHARS = 2000


@dataclass(frozen=True, slots=True)
class SubAgentBudget:
    """给一个子任务的预算。**父任务不能把自己的预算转给子任务**——
    这里只减不增，所以"派生"不会变成"绕过预算的一条路"。"""

    max_turns: int = MAX_TURNS
    max_seconds: float = MAX_SECONDS
    max_searches: int = MAX_SEARCHES
    started_at: float = field(default_factory=time.monotonic)

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.started_at

    @property
    def expired(self) -> bool:
        return self.elapsed >= self.max_seconds

    def remaining_turns(self, used: int) -> int:
        return max(0, self.max_turns - used)


@dataclass(frozen=True, slots=True)
class SubAgentTask:
    """要派出去的事。

    ``kb_ids`` 与 ``workspace_id`` **由调用方从父任务复制过来**，子 Agent 不允许
    自己挑——这条是"范围只继承、不扩"的实现方式（见模块头第 3 条）。
    """

    question: str
    kb_ids: list[str] = field(default_factory=list)
    workspace_id: str | None = None
    depth: int = 0


@dataclass(frozen=True, slots=True)
class SubAgentResult:
    """子 Agent 的产出：**一段结论**，不是它的全部过程。

    ``sources`` 要带回来：父 Agent 引用这段结论时，出处得是真实的。
    """

    answer: str
    sources: list[SourceRef] = field(default_factory=list)
    turns: int = 0
    searches: int = 0
    elapsed_seconds: float = 0.0
    stopped_reason: str = ""
    """为什么停下来：``answered`` / ``budget`` / ``timeout`` / ``error``。

    带上它是为了**不把"没查完"说成"查完了"**——父 Agent 需要知道这段结论
    有多可靠。
    """

    @property
    def complete(self) -> bool:
        return self.stopped_reason == "answered"


#: 子 Agent 的系统提示词。**与主 Agent 那套是不同的**，因为它要干的事不同：
#: 主 Agent 在跟人对话，子 Agent 是在交作业——只要结论与出处，不要寒暄与铺垫。
SUBAGENT_SYSTEM_PROMPT = (
    "你是一个子 Agent，被派去完成一件**自成体系的调研任务**。你的产出会被父 Agent "
    "直接当作结论使用，所以：\n"
    "1. 只给结论与依据，不要客套、不要复述任务、不要说「我查了…」的过程；\n"
    "2. 每个结论都要能对应到检索到的资料；资料不足就明确说「资料不足」——"
    "**不要拿常识补**，那会让父 Agent 以为这是有出处的；\n"
    "3. 篇幅控制在几段以内。你查过的中间过程留在你这里，不要搬给父 Agent。\n"
    "你**不能**再派生别的 Agent，也**不能**改变资料范围。"
)


def build_task_prompt(task: SubAgentTask) -> str:
    """把任务描述拼成子 Agent 的用户消息。

    **要求调用方给的是自足的任务**：子 Agent 看不到父任务的对话历史
    （那正是上下文隔离的意义）。所以这里做一次检查——太短或太长都拒，
    因为它们分别对应"没说清"与"把历史搬过来了"两种失败。
    """
    text = " ".join((task.question or "").split())
    if not text:
        raise InvalidRequestError("缺少参数：question（要子 Agent 做什么）")
    if len(text) > MAX_TASK_CHARS:
        raise InvalidRequestError(
            f"任务描述太长（{len(text)} 字，上限 {MAX_TASK_CHARS}）。"
            "子 Agent 看不到父任务的对话历史，所以任务要自足；但把背景整段搬过来"
            "就失去了派它的意义——请把任务压成一句话"
        )
    return f"任务：{text}"


def check_depth(depth: int) -> None:
    """深度检查。**在入口处拦**，而不是靠"子 Agent 工具集里没有 spawn"这一条规矩：
    规矩会被下一个改动打破，而这里是代码。"""
    if depth >= MAX_DEPTH:
        raise InvalidRequestError(
            f"不能再派子 Agent 了（当前深度 {depth}，上限 {MAX_DEPTH}）："
            "允许递归等于允许模型自己决定要花多少钱，而没有哪一层能拦住它"
        )
