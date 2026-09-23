"""计划门闸：``plan`` 档下"本会话是否已给出计划"（P1-1，开发计划 §12.225）。

抄的是 **QwenPaw 的 ``plan.enabled`` + ``set_plan_gate``**（《Agent-与对话架构对标调研
v0.1》§2.6 第 3 条）：计划模式下**没出计划之前写类工具一律被拦**，并把"为什么被拦"
回灌给模型。QwenPaw 那边"计划"是 ``create_plan`` 这个工具写下去的；我们这一侧的
"计划"只有一条通道——**模型这一轮的正文**（工具循环里没有"提交计划"的工具，
也不打算为它加一个：ZCode 的 ``EnterPlanMode`` 是模式工具，属于 P1-2 的斜杠命令那一批）。

## 状态放在哪里，以及为什么

**进程内存，按会话 id 一个格子**（不落库、不进设置）。取舍：

- 落库（比如 `app_settings` 里按会话拼一个键）能让"计划已给出"熬过重启，
  但会话删除时那条键没人清、多 worker 部署时又各写一份，收益是"重启后少要一次计划"
  ——而这一档真正管的是**同一轮与相邻几轮**的护栏（对方的下一条消息就是确认），
  重启之后重新给一次计划并不算错，反而是更保守的方向。
- 进程内存的代价是**多 worker 时每个进程一份**：某个进程没记过这个会话的计划，
  就照样拦一次。方向是"多要一次计划"，不是"误放行"，所以可以接受。
- 另一个可选做法是把它折进 `ToolLoop` 的实例状态。没这么做：`ToolLoop` 每一轮新建
  （见 `services/chat.tool_loop`），状态活不过一轮，而门闸的意义恰恰是跨轮次的。

## 什么时候算"已给出计划"

**这一轮以正文收尾**（模型没再要工具、把话说完了）就算。理由：对话里模型能把计划
交到用户眼前的唯一通道就是正文；而"同一轮里先写一段计划、紧接着调写类工具"**不算**
——那时候对方还没机会看到、更没确认，正是这一档要挡的形状（ZCode 那边要用户点一次
"批准"，我们的"批准"就是对方的下一条消息）。

离开 ``plan`` 档（切到 build / edit / yolo）时状态**清空**：计划阶段结束了。
再切回 ``plan`` 也是**新的一段**——哪怕中间一轮都没跑过（用户把档切来切去又切回来，
多半就是想让它重新规划一次），所以 :meth:`PlanGate.sync_mode` 认得"刚回到 plan"这件事。
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

from app.services import modes

__all__ = [
    "NO_SESSION",
    "PlanGate",
    "gate_for",
    "reset_all",
]

#: 没有会话上下文时共用的那一个格子（脚本、外部 MCP 客户端、定时任务的早期路径）。
#: **不是"不设门闸"**：那种链路上 `plan` 档仍然是拦的，只是它们共用一个状态。
NO_SESSION = ""


@dataclass(slots=True)
class _State:
    """一条会话的门闸状态（**可变**，由 :class:`PlanGate` 在锁里改）。"""

    given: bool = False
    """这一轮计划阶段里，模型有没有把计划交出来。"""

    at: float = 0.0
    """记下这条计划的时间（``time.time()``）。只用于回看/排查，不参与判定。"""

    note: str = ""
    """计划正文的开头一段。**留在内存里做证据**：日志或者界面上要回答
    "它当时给的是什么计划"时不必去翻消息表。截断保存，见 ``NOTE_CHARS``。"""

    generations: int = 0
    """这一段计划阶段被重置过几次（切走再切回 ``plan`` 一次算一次）。"""

    mode: str = ""
    """上一轮看到的档。**只用来认"刚进/回到 plan 档"这一件事**：
    同一段计划阶段里每轮都会看一眼档，而"从别的档回到 plan"意味着新的一段开始
    （哪怕中间没有跑过任何一轮——用户可能只是把档位切来切去又切回来）。"""


#: ``note`` 的保留长度。计划正文可能很长，而这里只是留个证据。
NOTE_CHARS = 400


class PlanGate:
    """一条会话的"计划给没给"。

    形状是**对象而不是裸函数**：`ToolLoop` 拿到的就是这个对象（见 `tool_loop`），
    所以判定时不需要再知道会话 id——而那正是最容易传错的一个参数
    （传成别的会话，表现是"这条会话忽然能写了"，且只在多会话并行时出现）。
    """

    def __init__(self, conversation_id: str | None = None, *, clock=time.time) -> None:
        self._key = str(conversation_id or NO_SESSION)
        self._clock = clock

    # ------------------------------------------------------------------ 身份

    @property
    def conversation_id(self) -> str:
        return self._key

    # ------------------------------------------------------------------ 读写

    @property
    def plan_given(self) -> bool:
        """这一轮计划阶段里，计划是否已经交出来了。"""
        with _LOCK:
            return _STATES.setdefault(self._key, _State()).given

    def sync_mode(self, mode: object) -> None:
        """每一轮开始时把当前档告诉门闸：**不在 ``plan`` 档就清空**。

        为什么由循环每轮调一次而不是由"切档"那个动作调：切档发生在设置端点里
        （`chat.mode` 是一次 ``PATCH /settings``），那条路上既不知道会话、
        也不该耦合到门闸；而"每一轮开始时看一次当前档"是循环本来就要做的事
        （见 `tool_loop.run`），顺手就同步了。

        两件事，缺一件都不对：

        - **不在了就清空**：切到 build / edit / yolo 之后，上一段计划不该还算数；
        - **刚回来也算新的一段**：`plan → build → plan` 中间哪怕一轮都没跑过，
          回到 ``plan`` 时也要重新给一次计划——否则"我又切回计划档了"会白捡
          上一段的那份计划，而用户切这一下多半就是想让它重新规划。
        """
        name = modes.coerce(mode)
        with _LOCK:
            state = _STATES.setdefault(self._key, _State())
            was = state.mode
            state.mode = name
            if name != modes.MODE_PLAN or was != modes.MODE_PLAN:
                _clear(state)

    def note_plan(self, text: str = "") -> None:
        """记下"计划已给出"（**这一轮以正文收尾**时由工具循环调用）。

        空正文不算：端点抽风吐了个空回答，不是计划。
        """
        plan = " ".join((text or "").split())
        if not plan:
            return
        with _LOCK:
            state = _STATES.setdefault(self._key, _State())
            # 只在第一次（或重置之后）落时间：同一段计划阶段里再答一次正文，
            # 不该把它变回"刚刚才给"——那会让"给了很久了"这件事看不出来
            if not state.given:
                state.at = self._clock()
            state.given = True
            state.note = plan[:NOTE_CHARS]

    def reset(self) -> None:
        """清空这一条会话的门闸状态（切走 ``plan`` 档时自动发生）。"""
        with _LOCK:
            state = _STATES.get(self._key)
            if state is not None:
                _clear(state)

    def snapshot(self) -> dict[str, object]:
        """给排查/测试看的只读快照（界面暂时不用它）。"""
        with _LOCK:
            state = _STATES.get(self._key) or _State()
            return {
                "conversation_id": self._key,
                "plan_given": state.given,
                "at": state.at,
                "note": state.note,
                "generations": state.generations,
                # 上一轮看到的档：排查"为什么忽然又要求给计划"时，第一眼看的就是它
                "mode": state.mode,
            }


#: 进程级的状态表：会话 id → 状态。见模块头"状态放在哪里"。
_STATES: dict[str, _State] = {}
_LOCK = threading.Lock()


def _clear(state: _State) -> None:
    """把一段计划阶段收掉（**调用方持锁**）。"""
    if state.given or state.note:
        state.generations += 1
    state.given = False
    state.at = 0.0
    state.note = ""


def gate_for(conversation_id: str | None) -> PlanGate:
    """取一条会话的门闸。**同一个会话 id 拿到的是同一份状态**（进程内）。"""
    return PlanGate(conversation_id)


def reset_all() -> None:
    """清空所有会话的状态。**只给用例用**（进程级状态在用例之间会互相传染）。"""
    with _LOCK:
        _STATES.clear()
