"""记忆工作区的**文件层**（v0.14 三期；档案制见 `docs/设计/记忆档案-设计-v0.1.md`）。

**2026-10-09 瘦身到只剩"常量与纯函数"**：这一层现在只有两件**还有读者**的事——

1. **``CORE_FILES``**：哪几份文件算"核心文件"的**唯一清单**。人设注入的清单校验
   （``services/memory.py::persona_order``）按它判，``memory.persona_files`` 里写了
   名单外的文件名会被丢掉并记一条日志；少列一个的后果是那份文件被当成随手写的普通
   笔记。改这里等于改"哪些算设定"；
2. **``parse_frontmatter``**：拆 YAML frontmatter 与正文。技能 / 插件 / 命令 / 市场
   那几层都拿它读自己的 ``SKILL.md``（五处 import），所以它住在这里，
   而不是各写一份。

**读文件与扫工作区那一半删了**：原先这一层还管 ``safe_path``（按路径解析，越界拒绝）、
``read_file`` / ``describe``（读原文与元信息）、``classify``（按目录分核心 / 每日 / 整合）、
``stats``（几份文件、上次改动）。它们的界面消费者是记忆页上那节只读的「人设与旧档案」、
迁移草稿查看与 ``GET /memory`` 的文件读数，而那一块连同 ``GET /memory/files/{path}``
一起下了架（人设属于人设层，不是记忆）。删的时候逐个查过引用：这几个符号当时**只剩
自己的单测在调**，所以按"零生产读者"一并删掉——留一条没人走但还在的路，
比留一个空入口更容易让人以为功能还在。**列表那一侧更早退场**（``scan``）。

（更早的历史：这一层还是 ReMe 的 HTTP 门面，管过检索 / 切块 / 图谱 / 当天索引页，
都随档案制退场。旧文件留在磁盘上不动——它们是用户数据，只是代码不再消费它们。）
"""

from __future__ import annotations

import logging
import re
from typing import Any

import yaml

__all__ = ["CORE_FILES", "parse_frontmatter"]

logger = logging.getLogger(__name__)

#: 核心文件：住在工作区根下、**靠注入生效**的那几份。
#:
#: 人设那两份（``SOUL.md`` 人格 / ``AGENTS.md`` 操作规程）与旧档案两份
#: （``MEMORY.md`` / ``PROFILE.md``）都在这张清单里，而**各有各的理由**：
#:
#: - 人设两份**每轮注入**（见 ``services/memory.py::persona_texts``），清单认它们；
#: - 旧档案两份**已经不再注入**，留着是因为**别人的盘上可能还躺着这两份文件**
#:   （旧部署的现场，退场不等于删用户的东西）：它们仍该被当成设定文件认出来，
#:   别被当成一份随手写的笔记——而"哪些是设定"这条分界只有这张清单一处说了算。
CORE_FILES: tuple[str, ...] = ("MEMORY.md", "SOUL.md", "PROFILE.md", "AGENTS.md")

#: frontmatter 开头的 ``---`` 块。
_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """拆出 YAML frontmatter 与正文。

    **解析失败不抛错**：frontmatter 是给人看的约定，手写时少个引号很正常，
    而"因为 frontmatter 坏了就打不开这个文件"是最糟的处理——用户正是来修它的。
    退回空 frontmatter、正文原样返回（含那段 ``---``），让他能改。
    """
    match = _FRONTMATTER.match(text)
    if not match:
        return {}, text
    try:
        loaded = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        logger.debug("frontmatter 解析失败，按无 frontmatter 处理", exc_info=True)
        return {}, text
    meta = loaded if isinstance(loaded, dict) else {}
    return meta, text[match.end() :]
