"""处理进度时间线：把阶段事件折成"共几步 / 现在第几步 / 每步多久"（v24）。

镜像同构：``app/services/timeline.py`` → 本文件。

要紧的四条：

1. **归并中间态**：``parsed``/``chunked`` 不是独立环节，混进去会让进度条平白多两段；
2. **最后一步的耗时是"到现在"**——跑着的文档要能看到它在长（这是"还在动"的证据）；
3. **重试与重新摄入的时间都算得进去**（同一环节 visits > 1）；
4. 失败/取消是**整条流水线的结局**，不是某个环节——"炸在哪一步"取最后一个有事件的环节。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.services.timeline import PIPELINE_STEPS, build_timeline

T0 = datetime(2026, 9, 15, 1, 0, 0, tzinfo=UTC)


class _Event:
    def __init__(self, stage: str, offset_s: float, error: str | None = None) -> None:
        self.stage = stage
        self.entered_at = T0 + timedelta(seconds=offset_s)
        self.error = error


def _at(offset_s: float) -> datetime:
    return T0 + timedelta(seconds=offset_s)


def test_steps_are_the_coarse_pipeline_not_raw_stages() -> None:
    """界面上是 6 个环节，不是状态机那 8 个阶段。"""
    timeline = build_timeline(
        document_id="doc_1",
        stage="uploaded",
        events=[_Event("uploaded", 0)],
        now=_at(5),
    )

    assert [step.key for step in timeline.steps] == [
        "uploaded",
        "probing",
        "parsing",
        "chunking",
        "embedding",
        "indexed",
    ]
    assert timeline.step_total == len(PIPELINE_STEPS) == 6


def test_middle_states_merge_into_their_step() -> None:
    """`parsed`/`chunked` 归并进"解析"/"切分"，不另起一段。"""
    timeline = build_timeline(
        document_id="doc_1",
        stage="chunked",
        events=[
            _Event("uploaded", 0),
            _Event("parsing", 10),
            _Event("parsed", 40),
            _Event("chunking", 45),
            _Event("chunked", 60),
        ],
        now=_at(70),
    )

    by_key = {step.key: step for step in timeline.steps}
    # parsed 的 5 秒算进"解析"（parsing→parsed 是这一步的一部分）
    assert by_key["parsing"].duration_ms == 35_000
    # chunking→chunked 15 秒 + chunked→now 10 秒 = 25 秒，全在"切分"上
    assert by_key["chunking"].duration_ms == 25_000
    assert by_key["chunking"].status == "running"
    assert by_key["probing"].visits == 0 and by_key["probing"].status == "pending"


def test_last_step_grows_while_running() -> None:
    """跑着时最后一步 = 到现在：换一个 now，耗时跟着变。"""
    events = [_Event("uploaded", 0), _Event("embedding", 30)]

    early = build_timeline(document_id="doc_1", stage="embedding", events=events, now=_at(40))
    later = build_timeline(document_id="doc_1", stage="embedding", events=events, now=_at(100))

    assert early.total_ms == 40_000 and later.total_ms == 100_000
    assert (early.current_index, early.status) == (5, "running")
    assert later.status == "running"


def test_retries_accumulate_and_are_visible() -> None:
    """重试/重新摄入：同一环节进出多次，耗时累加、visits > 1。"""
    timeline = build_timeline(
        document_id="doc_1",
        stage="indexed",
        events=[
            _Event("uploaded", 0),
            _Event("parsing", 10),
            _Event("failed", 70, error="上游超时"),
            _Event("parsing", 80),  # 重试
            _Event("chunking", 100),
            _Event("embedding", 110),
            _Event("indexed", 120),
        ],
        now=_at(130),
    )

    parsing = next(step for step in timeline.steps if step.key == "parsing")
    # 第一次解析 60s + 重试那次 20s
    assert parsing.visits == 2
    assert parsing.duration_ms == 80_000
    assert timeline.status == "done" and timeline.current_index == 6


def test_failed_is_a_pipeline_outcome_not_a_step() -> None:
    """失败不是环节：进度条停在"炸在哪一步"，并带上原因。"""
    timeline = build_timeline(
        document_id="doc_1",
        stage="failed",
        events=[
            _Event("uploaded", 0),
            _Event("parsing", 10),
            _Event("failed", 90, error="所有解析器都失败"),
        ],
        now=_at(100),
    )

    assert timeline.status == "failed"
    assert timeline.current_index == 3  # 停在"解析内容"
    parsing = next(step for step in timeline.steps if step.key == "parsing")
    assert parsing.status == "failed"
    assert parsing.error == "所有解析器都失败"
    # 后面几步仍是 pending，没有假装跑过
    later = ("chunking", "embedding", "indexed")
    assert all(step.status == "pending" for step in timeline.steps if step.key in later)


def test_canceled_marks_the_step_it_stopped_at() -> None:
    timeline = build_timeline(
        document_id="doc_1",
        stage="canceled",
        events=[
            _Event("uploaded", 0),
            _Event("parsing", 5),
            _Event("canceled", 20, error="已取消"),
        ],
        now=_at(30),
    )

    assert timeline.status == "canceled"
    parsing = next(step for step in timeline.steps if step.key == "parsing")
    assert parsing.status == "canceled" and parsing.error == "已取消"


def test_no_events_yields_an_empty_timeline_without_crashing() -> None:
    """老数据（这个机制之前入库的文档）没有事件：如实给一条空时间线。"""
    timeline = build_timeline(document_id="doc_old", stage="indexed", events=[], now=_at(0))

    assert timeline.status == "done"
    assert timeline.total_ms == 0
    assert all(step.duration_ms == 0 for step in timeline.steps)
