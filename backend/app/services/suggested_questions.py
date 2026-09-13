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

__all__ = [
    "DEFAULT_LIMIT",
    "MAX_QUESTIONS",
    "MIN_QUESTIONS",
    "PROMPT_MAX_CHARS",
    "SuggestedQuestionsService",
]

logger = logging.getLogger(__name__)

#: 一次最多给几条。前端一屏也就放得下五六个。
MAX_QUESTIONS = 8
MIN_QUESTIONS = 1
DEFAULT_LIMIT = 6

#: 自定义出题提示词的长度上限。它是给模型的自然语言指令，写太长只是浪费 token。
PROMPT_MAX_CHARS = 2000

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
        limit: int | None = None,
        model_pk: str | None = None,
        refresh: bool = False,
    ) -> list[str]:
        """生成示例问题；生成不出来返回空列表（调用方据此回退）。

        设置来源（v19）：**条数 / 模型 / 提示词都读库上的设置**，请求参数只是覆盖。
        多库同时选中时，取样包含全部启用的库，而"条数 / 模型 / 提示词"取**第一个
        启用的库**——出一份列表只能有一套参数，按选择顺序取第一个既确定，
        也符合"你先点的那个库说了算"。

        请求显式给了 ``limit`` 就以它为准（脚本 / API 用）；界面上不再传，
        让库设置说了算，否则在界面上改了条数却看不到变化。
        ``model_pk`` 优先级：**库设置 > 请求 > 全局默认**（库上单独指定一个
        "出题用的便宜模型"是这组设置存在的理由之一）。
        """
        resolved = self._resolve(kb_ids)
        if resolved is None:
            return []
        ids, count, kb_prompt, kb_model = resolved
        if limit is not None:
            count = max(MIN_QUESTIONS, min(limit, MAX_QUESTIONS))
        model = kb_model or model_pk or None
        key = (tuple(sorted(set(ids))), count, model or "", kb_prompt)
        if not refresh:
            cached = self._cache.get(key)
            if cached is not None and cached[0] > time.monotonic():
                return cached[1]
        questions = self._generate(ids, limit=count, model_pk=model, instruction=kb_prompt)
        if questions:
            self._cache[key] = (time.monotonic() + _CACHE_TTL_SECONDS, questions)
        return questions

    # ------------------------------------------------------------------ 内部

    def _resolve(self, kb_ids: list[str]) -> tuple[list[str], int, str, str | None] | None:
        """把请求里的库 id 收敛成"参与出题的那几个 + 一套参数"。

        关掉推荐问题的库**既不取样也不参与**——这正是那个开关的意思。
        一个都没启用（或都没了）时返回 ``None``，调用方据此直接回退静态样例，
        连一次模型调用都不花。
        """
        enabled = []
        for kb_id in kb_ids:
            record = self._stores.meta.get_knowledge_base(kb_id)
            if record is not None and record.suggested_enabled:
                enabled.append(record)
        if not enabled:
            return None
        head = enabled[0]
        count = max(MIN_QUESTIONS, min(head.suggested_count, MAX_QUESTIONS))
        return (
            [item.id for item in enabled],
            count,
            head.suggested_prompt.strip(),
            head.suggested_model_pk or None,
        )

    def _generate(
        self,
        kb_ids: list[str],
        *,
        limit: int,
        model_pk: str | None,
        instruction: str = "",
    ) -> list[str]:
        try:
            chunks = self._stores.meta.sample_chunks(kb_ids, limit=_SAMPLE_CHUNKS)
            snippets = [_snippet(item) for item in chunks if item.text.strip()]
            if not snippets:
                return []
            raw = self._chat.ask_raw(
                [
                    ChatMessage(role="system", content=_SYSTEM_PROMPT),
                    ChatMessage(role="user", content=_build_prompt(snippets, limit, instruction)),
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


def _build_prompt(snippets: list[str], limit: int, instruction: str = "") -> str:
    """资料片段 + 出题指令。

    ``instruction`` 为库上的自定义提示词时**替换内置那一句**，资料片段照旧附在前面——
    自定义的是"怎么出题"，而"依据哪些片段"是系统必须给的东西，不该让用户去拼。
    句子里的 ``{n}`` 会替换成条数；用户写了别的大括号（比如正则或 JSON 示例）时
    ``format`` 会抛，那就原样发出去，不因为一次格式化失败让出题整个失败。
    """
    material = "\n".join(f"{index}. {text}" for index, text in enumerate(snippets, start=1))
    template = instruction or _INSTRUCTION
    try:
        ask = template.format(n=limit)
    except (KeyError, IndexError, ValueError):
        ask = template
    return f"资料片段：\n{material}\n\n{ask}"


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
