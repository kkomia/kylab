"""「交给长期记忆」那条步骤（P0-8 的可见性）。

镜像同构：``app/api/v1/chat.py`` 的 ``_memory_handoff_step`` / ``_note_memory_handoff``
→ 本文件。

三件事：

1. **判据与写侧同源**：它问的是 ``MemoryService.capture_due``，不是自己算一遍
   ——两处各算一遍迟早会漂成"界面上说会沉淀、其实不会"，而那种不一致不报错；
2. **两份一起进**：消息里的快照与事件日志各一份、且是同一个 payload，
   否则 P0-2 那条"日志的投影 == 快照"的验收会当场不成立；
3. **措辞只说"会沉淀"**：此刻还不知道结果——那是队列里另一次模型调用的输出。
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from app.api.v1.chat import _maybe_capture_memory, _memory_handoff_step, _note_memory_handoff
from app.services.api_key import Caller
from app.services.session_events import KIND_STEP, steps_from_events


def _human() -> Caller:
    """管理员网页会话：人在说话，该沉淀。"""
    return Caller(is_admin=True)


def _automated() -> Caller:
    """API Key 通道（MCP / 脚本 / 自动化测试）：机器在说话，不该沉淀。

    ``api_key`` 只需要"非空"这个事实，所以给一个占位对象即可——判据就是它非空。
    """
    return Caller(api_key=SimpleNamespace(id="key_1"))  # type: ignore[arg-type]


class _Sink:
    """只实现这一步用到的两个格子（形状与真的 ``_TurnSink`` 一致）。"""

    def __init__(self) -> None:
        self.steps: list[dict[str, object]] = []
        self.events: list[Any] = []


class _Services:
    """只实现这一步用到的两件事：会话的消息数、记忆的沉淀判据。"""

    def __init__(self, *, count: int = 10, due: bool = True) -> None:
        self.asked: list[int] = []
        self.conversations = SimpleNamespace(message_count=lambda _cid: count)
        self.memory = SimpleNamespace(capture_due=self._capture_due)
        self._due = due

    def _capture_due(self, turns: int) -> bool:
        """记下被问到的回合数——"问的是哪一轮"本身就是一条要钉的行为。"""
        self.asked.append(turns)
        return self._due


def test_the_step_is_absent_when_the_capture_is_not_due() -> None:
    assert _memory_handoff_step(_Services(due=False), "conv_1") is None


def test_a_conversation_less_turn_is_left_alone() -> None:
    """没有会话就没有可回溯的来源，也就没有那一步（与 `_maybe_capture_memory` 同口径）。"""
    assert _memory_handoff_step(_Services(due=True), None) is None


def test_the_step_says_it_will_be_captured_not_what_was_captured() -> None:
    """只说"**会**沉淀"，不说"记住了 N 条"。

    此刻还不知道结果：那是队列里另一次模型调用的输出，要报结果得等它跑完，
    而那时这一轮早结束了。写成"记住了 N 条"就是编——界面上的假话比少一句话糟得多。
    """
    payload = _memory_handoff_step(_Services(due=True), "conv_1")

    assert payload is not None
    assert payload["phase"] == "memory" and payload["status"] == "done"
    assert "会沉淀" in str(payload["detail"])


def test_the_turn_count_asked_about_is_the_one_after_this_turn() -> None:
    """这一轮马上要写两条消息（问 + 答），所以判据里的回合数是**之后**的那个。

    用"之前"的话会整体晚一轮：第 4 轮就显示会沉淀，而实际第 5 轮才沉淀。
    """
    services = _Services(count=8, due=True)

    _memory_handoff_step(services, "conv_1")

    assert services.asked == [5], "8 条消息 = 4 轮；加上这一轮的问答就是第 5 轮"


def test_the_step_goes_into_both_the_snapshot_and_the_log() -> None:
    """**两份一起进、且是同一个 payload**：P0-2 的"投影 == 快照"靠这个成立。

    只进其中一处的话那条验收会红，而它只在跑真实对话的端到端用例里才看得见。
    """
    sink = _Sink()
    steps: list[dict[str, object]] = []

    _note_memory_handoff(
        _Services(due=True), "conv_1", caller=_human(), steps=steps, sink=sink
    )

    assert steps == sink.steps, "两份内容必须一样"
    assert steps_from_events(sink.events) == steps, "日志的投影必须等于快照"
    assert sink.events[0].kind == KIND_STEP


def test_the_two_lists_stay_separate_when_they_are_different_objects() -> None:
    """非 Agent 那条链路上 ``steps`` 与 ``sink.steps`` 不是同一个列表。

    两边都要有：``turn/end`` 的步数读 sink，落库读 ``steps``——只写一边的话，
    要么日志里多一条快照里没有的（验收红），要么反过来（用户看不到）。
    """
    sink = _Sink()
    steps: list[dict[str, object]] = []

    _note_memory_handoff(
        _Services(due=True), "conv_1", caller=_human(), steps=steps, sink=sink
    )

    assert len(sink.steps) == 1 and len(steps) == 1


def test_nothing_is_recorded_when_the_capture_is_not_due() -> None:
    sink = _Sink()
    steps: list[dict[str, object]] = []

    _note_memory_handoff(
        _Services(due=False), "conv_1", caller=_human(), steps=steps, sink=sink
    )

    assert steps == [] and sink.events == [] and sink.steps == []


def _capture_spy() -> tuple[Any, list[dict[str, Any]]]:
    calls: list[dict[str, Any]] = []
    services = SimpleNamespace(
        conversations=SimpleNamespace(message_count=lambda _cid: 10),
        memory=SimpleNamespace(capture_turn=lambda cid, **kw: calls.append({"cid": cid, **kw})),
    )
    return services, calls


def test_an_automated_turn_does_not_enqueue_a_capture() -> None:
    """自动化通道**连队都不入**。

    这条与上面那条是一对：上面钉"界面不报那一步"，这里钉"写侧真的没发生"。
    只改一处就会出现"报了却不入队"或反过来——那种分叉不报错，只是用户慢慢发现
    "记忆里怎么多了一堆我没说过的话"。
    """
    services, calls = _capture_spy()

    _maybe_capture_memory(services, "conv_1", caller=_automated())

    assert calls == []


def test_a_human_turn_still_enqueues_a_capture() -> None:
    """对照组：人在说话时照旧沉淀——否则这条排除会把整件事一起关掉。"""
    services, calls = _capture_spy()

    _maybe_capture_memory(services, "conv_1", caller=_human())

    assert len(calls) == 1 and calls[0]["cid"] == "conv_1"


def test_an_automated_turn_never_promises_a_handoff() -> None:
    """**自动化通道不沉淀，也就不该报这一步**（"自动化请求不入记忆"）。

    API Key 那条路是 MCP 客户端、脚本与自动化测试在说话：把它们记进"这个人说过
    什么"里，等于让机器替人往记忆里写话。而界面上**报一个不会发生的事比不报更糟**
    ——用户会以为这一轮的内容留下了，其实没有。
    """
    sink = _Sink()
    steps: list[dict[str, object]] = []

    _note_memory_handoff(
        _Services(due=True), "conv_1", caller=_automated(), steps=steps, sink=sink
    )

    assert steps == [] and sink.events == [] and sink.steps == []
