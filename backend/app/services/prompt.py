"""提示词贡献者：把"每轮怎么拼 system prompt"从一段 append 变成一张表（P1）。

为什么值得单独一层：提示词来源会不断变多（基础提示词、人设文件、库级提示词、记忆、
技能目录、摘要，以后还有工具说明与工作区信息）。手写一串 `parts.append` 的代价不是
代码长，而是**顺序与"缺了会怎样"变成隐式知识**——加一个来源就得回头读整段、
并重新推演一遍它的位置。

三条约定照 QwenPaw 的 PromptManager（它的实测理由：贡献者是可插拔的，
插件也能往里加一段）：

1. **优先级升序拼接** —— 顺序是数据，不是注释里的一句话；
2. **空块跳过** —— 不产生空行，也不留下"这里本来有东西"的痕迹；
3. **单个贡献者抛异常只跳过它自己** —— 提示词组装不该被任何一个来源拖垮。
   这条不是理论：某个来源读文件失败（磁盘、权限、编码）在真实部署里都会发生，
   而"人设文件读不出来导致整轮对话失败"是完全不可接受的因果关系。
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass

__all__ = [
    "PromptContext",
    "PromptContributor",
    "build_system_prompt",
    "default_contributors",
]

logger = logging.getLogger(__name__)

#: 各来源的优先级。**数字之间留空档**是为了以后能插进来而不必重排全部。
#: 语义上：越靠前越像"我是谁"，越靠后越像"这一轮的上下文"。
PRIORITY_BASE = 10
PRIORITY_PERSONA = 20
PRIORITY_KB_PROMPT = 30
PRIORITY_MEMORY = 40
PRIORITY_SKILLS = 50
PRIORITY_SUMMARY = 60


@dataclass(frozen=True, slots=True)
class PromptContext:
    """这一轮拼提示词要用到的全部素材（都是**待拼的原文**，不是拼好的块）。"""

    base: str = ""
    """基础提示词。工具循环与检索链路各有一份默认，由调用方给。"""

    persona: tuple[tuple[str, str], ...] = ()
    """``[(文件名, 正文)]``，来自 `MemoryService.persona_texts`（按人设顺序）。"""

    kb_prompt: str = ""
    memory: str = ""
    skills: str = ""
    summary: str = ""


#: ``(优先级, 名字, 产出)``。名字用于日志（"哪个来源没拼上"要知道是谁）。
PromptContributor = tuple[int, str, Callable[[PromptContext], str]]


def default_contributors() -> list[PromptContributor]:
    """内置贡献者表。顺序即模型读到的顺序（升序）。"""
    return [
        (PRIORITY_BASE, "base", lambda ctx: ctx.base),
        (PRIORITY_PERSONA, "persona", _persona_block),
        (PRIORITY_KB_PROMPT, "kb_prompt", lambda ctx: ctx.kb_prompt),
        (PRIORITY_MEMORY, "memory", lambda ctx: ctx.memory),
        (PRIORITY_SKILLS, "skills", lambda ctx: ctx.skills),
        (PRIORITY_SUMMARY, "summary", _summary_block),
    ]


def build_system_prompt(
    context: PromptContext,
    contributors: Sequence[PromptContributor] | None = None,
) -> str:
    """按优先级把非空的块拼成一条 system 消息的内容。"""
    parts: list[str] = []
    table = sorted(contributors or default_contributors(), key=lambda item: item[0])
    for _priority, name, build in table:
        try:
            fragment = build(context)
        except Exception:
            # 见模块头第 3 条：一个来源坏了只少它自己
            logger.warning("提示词贡献者 %s 失败，跳过它", name, exc_info=True)
            continue
        text = (fragment or "").strip()
        if text:
            parts.append(text)
    return "\n\n".join(parts)


def _persona_block(context: PromptContext) -> str:
    """人设文件块：每份前面标出**它是什么**。

    标名字不是为了好看：模型得知道哪句是"我该怎么说话"（人格）、哪句是"已知的事实"
    （记忆）。少了这层区分，它会把记忆当成对方这一轮说的话——而记忆是可能过时的。
    """
    blocks: list[str] = []
    for name, text in context.persona:
        body = text.strip()
        if not body:
            continue
        label = _PERSONA_LABELS.get(name, name)
        if name == "MEMORY.md":
            # 只有记忆这份要带"可能过时"的声明，见 `MemoryService.prompt_block` 里的理由
            blocks.append(
                f"【{label}（{name}，来自过去的对话，可能已经过时；"
                f"与对方当前所说冲突时以他当下的为准）】\n{body}"
            )
        else:
            blocks.append(f"【{label}（{name}）】\n{body}")
    return "\n\n".join(blocks)


_PERSONA_LABELS = {
    "SOUL.md": "你的人格",
    "PROFILE.md": "身份与对方",
    "AGENTS.md": "操作规程",
    "MEMORY.md": "长期记忆",
}


def _summary_block(context: PromptContext) -> str:
    if not context.summary:
        return ""
    head = "【此前对话的摘要】（用于保持上下文）"
    return f"{head}{chr(10)}{context.summary.strip()}"
