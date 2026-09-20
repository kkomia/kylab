"""续跑：把上一轮**没做完**的材料重新交给模型，让它接着做（开发计划 §12.212）。

## 为什么需要它

工具循环有两道闸（步数、整轮墙钟），撞上之后会降级收尾——"按现有信息作答"。
用户看到的是回答突然变浅，而他能做的只有"重发一遍"：**那等于把已经付过费的检索
全部丢掉重来**。调研（《工具调用限制调研 v0.1》第 3 节）里 Claude 的 `pause_turn`
就是这件事的另一半：暂停之后**可以续跑，由调用方决定**。

## 续跑不是"再来一次"，而是"接着来"

原来的重试 = 回退一轮 + 重发同一句提问（见 `ConversationService.rewind`），
代价是重新检索、重新花钱，而模型对上一轮查到了什么一无所知。

这里的做法是**从快照重建上下文**：回合内的工具对话（assistant 的 tool_calls +
tool 结果）**不入库**（`ChatMessageRecord` 只有 user / assistant 两种角色），
所以恢复不了原始消息序列；但落库的快照里有每步的结论（`detail`）、原文
（`args` / `result`）与这一轮的出处（`sources`），够拼出一段人能读、模型能用的交接说明。

于是续跑由三件事组成：

1. **一段交接说明**（`resume_note`）——做过什么、拿到了什么、停在哪、接着做什么；
2. **出处接上**：上一轮的 `sources` 通过 `build_runner(seed_sources=…)` 喂回来源账本，
   编号接着往下排。**这是必须的**：说明里告诉模型"材料 [3] 是那份共识"，
   账本里却没有第 3 条，它引用出来的编号就会指向别的资料；
3. **预算给够**：续跑各给一点增量（见下面的常量），不是无限续。

## 不做次数上限，是有意的

每次续跑都是一次用户点击，代价由他每一次点击决定（与 Claude 的 pause_turn 同一套思路：
"开发者决定是否续跑"）。如果续跑之后又撞上限，界面照样给按钮——
连点十次的人会看到十次失败，而不是被一个我们编的"最多续 2 次"挡住。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

#: 续跑多给几步。给一半：续跑的常态是"差最后一点"，而不是"从头再来一遍"。
RESUME_EXTRA_STEPS = 15

#: 续跑多给多少秒墙钟。给 3 分钟：常规一轮是 1~2 分钟，续跑通常更短，
#: 但"上一轮是撞时间停的"意味着这一次大概率也要查一会儿。
RESUME_EXTRA_SECONDS = 180.0

#: 交接说明的**总长上限**（字符）。它是要进提示词的，不能无限长：
#: 说明比资料还长就本末倒置了。超了从后面砍（先砍"写了一半的回答"）。
MAX_NOTE_CHARS = 6000

#: 说明里最多列几条已有动作 / 几条已有出处。**不是越多越好**：
#: 列 30 条动作等于让模型再读一遍它的历史，而它需要的是"别再重复这些"。
MAX_NOTE_STEPS = 12
MAX_NOTE_SOURCES = 10

#: 每条动作的结论、每段出处、以及"写了一半的回答"各自的截断长度。
STEP_DETAIL_CHARS = 200
SOURCE_PREVIEW_CHARS = 240
PARTIAL_ANSWER_CHARS = 1500

#: 降级步骤在快照里的样子（`api/v1/chat.py` 落库时写的键）。
_DEGRADED_KEY = "degraded"


@dataclass(frozen=True, slots=True)
class ResumeMaterial:
    """续跑要用到的上一轮快照。**只带文本与出处**，不带工具对话。

    ``answer`` 是上一轮那段没写完的正文（可能为空：撞上限时可能一句都没输出）。
    """

    question: str
    answer: str
    steps: Sequence[dict[str, object]]
    sources: Sequence[dict[str, object]]


def degraded_reason(steps: Sequence[dict[str, object]]) -> str:
    """这一轮是不是**降级收尾**的；是就返回服务端当时写的原因，否则空串。

    原因取那条降级步骤的 ``detail``（"本轮最多 300 秒，已用 312 秒，按现有信息作答"）——
    它是给人看的一句话，界面与交接说明都用它，**不在别处再写一份**。
    """
    for step in steps:
        if step.get(_DEGRADED_KEY):
            detail = str(step.get("detail") or "").strip()
            label = str(step.get("label") or "").strip()
            return detail or label or "这一轮没跑完"
    return ""


def _clip(text: str, limit: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _step_lines(steps: Sequence[dict[str, object]]) -> list[str]:
    lines: list[str] = []
    for step in steps:
        if step.get(_DEGRADED_KEY):
            continue  # 降级那一条单独写在"停在哪"里，不混进动作清单
        label = str(step.get("label") or "").strip()
        if not label:
            continue
        detail = _clip(str(step.get("detail") or ""), STEP_DETAIL_CHARS)
        lines.append(f"- {label}：{detail}" if detail else f"- {label}")
    return lines[:MAX_NOTE_STEPS]


def _source_lines(sources: Sequence[dict[str, object]]) -> list[str]:
    lines: list[str] = []
    for position, source in enumerate(sources[:MAX_NOTE_SOURCES], start=1):
        index = source.get("index") or position
        name = str(source.get("document_name") or "（未命名文档）")
        heading = str(source.get("heading_path") or "").strip()
        preview = _clip(str(source.get("preview") or ""), SOURCE_PREVIEW_CHARS)
        where = f"{name} §{heading}" if heading else name
        lines.append(f"[{index}] {where}：{preview}" if preview else f"[{index}] {where}")
    return lines


def resume_note(material: ResumeMaterial, *, reason: str) -> str:
    """拼"接着做"那一段交接说明。**它是给模型看的，措辞按指令写**。

    刻意写清两件事：**已经做过什么**（避免它把同一个检索再做一遍，那是真花钱的）
    与**材料的编号**（它要引用就直接用这些号——账本已经把这些出处接上了，见模块头）。
    """
    parts: list[str] = ["【这一轮是接着上一次继续做的】"]
    if reason:
        parts.append(f"上一次停在中途，原因是：{reason}")
    parts.append(f"你当时要回答的问题是：{_clip(material.question, 400)}")

    steps = _step_lines(material.steps)
    if steps:
        parts.append("已经做过这些事（**不要重复做**）：\n" + "\n".join(steps))

    sources = _source_lines(material.sources)
    if sources:
        parts.append(
            "已经拿到并引用过的原文（**编号沿用，要引用就直接用这些编号**）：\n"
            + "\n".join(sources)
        )

    partial = _clip(material.answer, PARTIAL_ANSWER_CHARS)
    if partial:
        parts.append(f"上一次写到这里（还没写完）：\n{partial}")

    parts.append(
        "请**接着把这一轮做完**：不要重复上面已经做过的检索与抓取；"
        "如果现有材料已经够，就直接给出完整回答。"
    )
    note = "\n\n".join(parts)
    if len(note) > MAX_NOTE_CHARS:
        note = note[: MAX_NOTE_CHARS - 1] + "…"
    return note
