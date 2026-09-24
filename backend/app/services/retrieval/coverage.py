"""词面覆盖：候选与查询在**词**这一层的重合比例（相关度下限的词面那一半）。

**为什么需要它**：全文通道的原始分（PG 的 ``ts_rank_cd``）**没法当绝对下限用**。
本机四个真实库上实测（2026-09-24，bge-m3，见 ``docs`` 与本次标定记录）：

- 纯噪声查询也能拿到很高的分：医学库上「合唱团的排练时间安排」的全文最高分
  10.1，「真空镀膜机的靶材更换周期」9.9——因为 jieba 会把「的」「更换」这类词
  切出来，OR 查询命中一个高频词就够了，而 ``ts_rank_cd`` 只按覆盖密度与词频算；
- 真命中的全文最高分可以更低：同一批语料上「街道绿视率对青少年视力的影响」只有
  8.9，另一个库的「眼科」系列查询更是低到 2-5。

两个区间**重叠**，所以"绝对下限"选不出一个不误杀的数；"相对自身最高分"也没用
——噪声查询的最高分就是它自己的头部，比例永远接近 1。相对分（``score_threshold``）
因此只能剪尾巴，剪不掉头部，这正是"8 条假命中"的来源。

这一层换一个**跨查询、跨库可比**的量：查询里的实词有多少比例真的出现在这段正文里。
它是"词面证据"的归一化形态（分子分母都随查询长度走，所以长度不影响判定），
与向量余弦是**或**的关系（见 ``service._passes_relevance``）：语义够近也行、
词面够像也行，两条路各有各的证据。

**与索引的切法同源但**不同档**（``jieba.lcut`` vs 索引的 ``cut_for_search``）**：
索引那边要**宽召回**，所以 ``cut_for_search`` 会把长词再切出子词（「服务器」→ 服务/务器/服务器）；
判定这边要的是**证据**，子词会让"蹭上一个词头"也算命中（实测：「如何用 Rust 写一个 HTTP
服务器」在医学库上就靠「一个」「服务」蹭过了 0.5，留下一条完全无关的命中）。
两边同源（同一份词典、同一套分词器）保证不会漂成两种中文切法，
``tests/unit/services/retrieval/test_relevance.py`` 有一条用例盯着这个包含关系。
"""

from __future__ import annotations

from collections.abc import Sequence

import jieba

__all__ = ["MIN_TERM_CHARS", "content_terms", "term_coverage"]

#: 参与判定的最短词元（字符数）。单字词在中文里绝大多数是虚词或黏着语素
#: （的／了／是／在／机／修），拿它们当"词面证据"只会把噪声算成命中——
#: 实测「真空镀膜机的靶材更换周期」在医学库上的噪声头，就是靠「的」命中的。
MIN_TERM_CHARS = 2


def content_terms(text: str) -> tuple[str, ...]:
    """查询里的实词（去重、大小写归一）。切法见模块头。"""
    terms: dict[str, None] = {}
    for word in jieba.lcut(text or ""):
        term = word.strip()
        if len(term) < MIN_TERM_CHARS:
            continue
        # 大小写归一是为了与全文索引对齐：tsvector 对 ASCII 做折叠，
        # 查询「NDVI」命中的段落里写的是「ndvi」时，这一层也必须认。
        terms.setdefault(term.casefold(), None)
    return tuple(terms)


def term_coverage(terms: Sequence[str], text: str) -> float:
    """``terms`` 里有多少比例出现在 ``text`` 中（0.0–1.0）。

    ``terms`` 为空（查询里压根没有实词，例如只输入了「的」或一个标点）时返回 1.0：
    这一侧无从判断，不该由它来拦——**宁可少拦**。防误杀是这一层的第一原则，
    真要收紧的手感应该来自向量那一侧的下限。
    """
    if not terms:
        return 1.0
    haystack = (text or "").casefold()
    matched = sum(1 for term in terms if term in haystack)
    return matched / len(terms)
