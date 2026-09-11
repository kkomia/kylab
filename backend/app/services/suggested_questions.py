"""示例问题生成（对话页空状态的那排胶囊）。

依据所选知识库的**少量原文片段**，让已配置的对话模型写出"用户可能想追问的问题"。
做法参考 WeKnora 的 `GET /agents/{id}/suggested-questions`：问题来自后端，
而不是在前端写死——写死的问题和用户的语料无关，点进去往往答不上来。

三条边界：

1. **失败不报错**：没配模型、上游失败、输出解析不出——一律返回空列表，
   界面回退到静态样例。示例问题只是引导，不该让空状态变成一个错误页。
2. **成本有上限**：只采样少量片段、只生成少量问题、`max_tokens` 有上限，
   并对同一组知识库做**短 TTL 缓存**（切库会反复触发，缓存把重复调用挡掉）。
3. **不落库**：它是展示用的建议，不是内容。
"""

from __future__ import annotations

import logging
import re
import time

from app.services.chat import ChatService
from app.services.llm import ChatMessage
from app.storage.base import StoreBundle

__all__ = ["DEFAULT_LIMIT", "MAX_QUESTIONS", "SuggestedQuestionsService"]

logger = logging.getLogger(__name__)

#: 一次最多给几条。前端一屏也就放得下五六个。
MAX_QUESTIONS = 8
DEFAULT_LIMIT = 6

#: 采样多少块语料。够模型看出"这个库在讲什么"，又不至于把提示词撑大。
_SAMPLE_CHUNKS = 8
#: 每块截多长。示例问题不需要细节，看到主题就够。
_SNIPPET_CHARS = 500
#: 生成结果的缓存时长。切一次库就重新生成一次太费，缓存 5 分钟。
_CACHE_TTL_SECONDS = 300

_SYSTEM_PROMPT = (
    "你是一个知识库助手。用户会给你资料库里的若干原文片段，"
    "请据此推测用户可能想追问的问题。只输出问题本身，不要答案、不要解释。"
)
_INSTRUCTION = (
    "根据以上资料片段，写出 {n} 个用户可能想追问的中文问题。"
    "要求：具体、能靠这些资料回答；每行一个；不要编号、不要引号、不要任何额外文字。"
)

#: 去掉行首的编号/项目符号（`1.` `-` `•` `1、` `1)`）。**只吃前缀**，
#: 不能用一个 lstrip(chars) 把"2024 年的…"这种以数字开头的问题也削掉。
_ENUMERATOR = re.compile(r"^\s*(?:[-*•]+|\d+\s*[.、)．]\s*)")


class SuggestedQuestionsService:
    """把"采样语料 → 问模型 → 清洗成问题列表"这条链路收在一处。"""

    def __init__(self, stores: StoreBundle, chat: ChatService) -> None:
        self._stores = stores
        self._chat = chat
        self._cache: dict[tuple[object, ...], tuple[float, list[str]]] = {}

    def suggest(
        self,
        *,
        kb_ids: list[str],
        limit: int = DEFAULT_LIMIT,
        model_pk: str | None = None,
        refresh: bool = False,
    ) -> list[str]:
        """生成示例问题；生成不出来返回空列表（调用方据此回退）。"""
        if not kb_ids:
            return []
        capped = max(1, min(limit, MAX_QUESTIONS))
        key = (tuple(sorted(set(kb_ids))), capped, model_pk or "")
        if not refresh:
            cached = self._cache.get(key)
            if cached is not None and cached[0] > time.monotonic():
                return cached[1]
        questions = self._generate(kb_ids, limit=capped, model_pk=model_pk)
        if questions:
            self._cache[key] = (time.monotonic() + _CACHE_TTL_SECONDS, questions)
        return questions

    # ------------------------------------------------------------------ 内部

    def _generate(self, kb_ids: list[str], *, limit: int, model_pk: str | None) -> list[str]:
        try:
            chunks = self._stores.meta.sample_chunks(kb_ids, limit=_SAMPLE_CHUNKS)
            snippets = [_snippet(item) for item in chunks if item.text.strip()]
            if not snippets:
                return []
            raw = self._chat.ask_raw(
                [
                    ChatMessage(role="system", content=_SYSTEM_PROMPT),
                    ChatMessage(role="user", content=_build_prompt(snippets, limit)),
                ],
                model_pk=model_pk,
            )
        except Exception:
            # **只记日志不抛**：示例问题是引导，拿不到就回退静态样例，
            # 不能让"点开对话页"因为一次旁路调用失败而变成错误页
            logger.warning("示例问题生成失败，回退到静态样例", exc_info=True)
            return []
        return _parse_questions(raw, limit)


def _snippet(chunk) -> str:  # type: ignore[no-untyped-def]
    where = chunk.heading_path or (f"第 {chunk.page} 页" if chunk.page else "")
    body = " ".join(chunk.text.split())[:_SNIPPET_CHARS]
    return f"[{where}] {body}" if where else body


def _build_prompt(snippets: list[str], limit: int) -> str:
    material = "\n".join(f"{index}. {text}" for index, text in enumerate(snippets, start=1))
    return f"资料片段：\n{material}\n\n{_INSTRUCTION.format(n=limit)}"


def _parse_questions(raw: str, limit: int) -> list[str]:
    """把模型输出切成问题列表。

    模型经常不听话：加编号、加引号、前面还有一句"以下是几个问题"。这里只做
    **保守清洗**——去编号、去包裹的引号、丢掉过长或过短的行，绝不替它"改写"。
    """
    out: list[str] = []
    seen: set[str] = set()
    for line in raw.splitlines():
        text = _ENUMERATOR.sub("", line).strip().strip("\"'“”‘’")
        if not text or len(text) > 100:
            continue
        if text in seen:
            continue
        seen.add(text)
        out.append(text)
        if len(out) >= limit:
            break
    return out
