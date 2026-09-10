"""快速检索对话（M6 验证版）。

这是"最简可用"的一条链路：**向量检索拿原文 → 拼进提示词 → 大模型作答 → 带引用返回**。
刻意不做深（不做多轮改写、不做工具调用、不做线程持久化），
它的定位是让用户**快速验证知识库里到底有没有、答得对不对**。

与产品边界的关系（重要）：`/search` 仍然只返回原文、不做任何 LLM 加工；
LLM 只出现在这一层，并且**强制带引用**——回答必须能回到原文，
否则"验证"这件事本身就不成立。
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterator
from dataclasses import dataclass, field

from app.services.llm import ChatError, ChatMessage, LLMConfig, OpenAICompatChat
from app.services.retrieval import RetrievalQuery, RetrievalService
from app.services.runtime_config import RuntimeConfigService

__all__ = ["DEFAULT_SYSTEM_PROMPT", "ChatService", "ChatTurn", "SourceRef"]

logger = logging.getLogger(__name__)

DEFAULT_SYSTEM_PROMPT = (
    "你是知识库助手。只依据下面提供的「资料」回答用户的问题。\n"
    "要求：\n"
    "1. 资料里没有的内容，直接说「资料中没有找到」，不要凭常识补充；\n"
    "2. 回答用中文，简洁分点，不要复述全部资料；\n"
    "3. 引用处用 [1] [2] 标出对应的资料编号。"
)

#: 拼进提示词的资料条数上限：太多会挤掉问题本身，也更容易让模型跑偏
MAX_CONTEXT_CHUNKS = 6
#: 每条资料截断长度：一条 chunk 通常 500 字上下，超长的只取开头
MAX_CHUNK_CHARS = 900

#: 云端解析器把 PDF 表格输出成 HTML，这些标签对模型和用户都是噪声。
#: 只匹配真正的标签形态（``<td>``、``</tr>``、``<td rowspan="2">``、``<br/>``），
#: 数学里的 ``a < b`` 不会被误伤。
_HTML_TAG = re.compile(r"</?[A-Za-z][A-Za-z0-9]*(?:\s[^<>]*)?/?>")


@dataclass(frozen=True, slots=True)
class SourceRef:
    """回答引用的原文出处。界面上点它能跳回文档。"""

    index: int
    chunk_id: str
    document_id: str
    document_name: str
    heading_path: str | None = None
    page: int | None = None
    score: float = 0.0
    preview: str = ""


@dataclass(slots=True)
class ChatTurn:
    """一次问答的结果。"""

    answer: str
    sources: list[SourceRef] = field(default_factory=list)


class ChatService:
    """把检索、提示词与对话模型串起来。"""

    def __init__(
        self,
        retrieval: RetrievalService,
        runtime: RuntimeConfigService,
        *,
        chat_factory=None,  # type: ignore[no-untyped-def]
    ) -> None:
        self._retrieval = retrieval
        self._runtime = runtime
        # 工厂可注入：测试里换成假模型，避免真打网络
        self._chat_factory = chat_factory or (lambda config: OpenAICompatChat(config))

    # ------------------------------------------------------------------ 对外

    def retrieve_sources(
        self,
        *,
        query: str,
        kb_ids: list[str],
        top_k: int | None = None,
        candidate_k: int = 40,
    ) -> list[SourceRef]:
        """先检索，拿到带编号的出处。流式回答时**先把这个发给前端**，
        用户能立刻看到"依据是哪几段"，不用等模型写完。

        ``top_k`` 留空时读设置页里的「带入资料的条数」。
        """
        limit = top_k or self._runtime.get_int("chat.top_k") or MAX_CONTEXT_CHUNKS
        response = self._retrieval.search(
            RetrievalQuery(
                query=query,
                kb_ids=kb_ids,
                top_k=limit,
                candidate_k=candidate_k,
            )
        )
        sources: list[SourceRef] = []
        for index, hit in enumerate(response.hits, start=1):
            sources.append(
                SourceRef(
                    index=index,
                    chunk_id=hit.chunk_id,
                    document_id=hit.document_id,
                    document_name=hit.document_name or hit.document_id,
                    heading_path=hit.heading_path,
                    page=hit.page,
                    score=hit.score,
                    preview=_preview(hit.text),
                )
            )
        return sources

    def answer(
        self,
        *,
        query: str,
        sources: list[SourceRef],
        history: list[ChatMessage] | None = None,
        system_prompt: str | None = None,
    ) -> ChatTurn:
        """非流式：一次拿完整回答。"""
        chat = self._build_chat()
        messages = build_messages(
            query=query,
            sources=sources,
            history=history,
            system_prompt=system_prompt or self._runtime.get("chat.system_prompt"),
        )
        return ChatTurn(answer=chat.complete(messages), sources=sources)

    def answer_stream(
        self,
        *,
        query: str,
        sources: list[SourceRef],
        history: list[ChatMessage] | None = None,
        system_prompt: str | None = None,
    ) -> Iterator[str]:
        """流式：逐块产出回答文本。

        模型没配好时**抛 ChatError**，由协议层翻成错误事件——
        不能静默返回空答案，那会让用户以为"知识库里没有"。
        """
        chat = self._build_chat()
        messages = build_messages(
            query=query,
            sources=sources,
            history=history,
            system_prompt=system_prompt or self._runtime.get("chat.system_prompt"),
        )
        return chat.stream(messages)

    def llm_config(self) -> LLMConfig:
        return self._runtime.llm()

    def probe(self) -> str:
        """最小连通性探针：让模型回一句话，只用来验证"模型会不会说话"。

        比只查鉴权有用得多——**推理模型在 max_tokens 不够时 content 会是空的**，
        那正是最需要被测出来的坑（实测过）。设置页的「测试连接」调它。
        """
        return self._build_chat().complete([ChatMessage(role="user", content="回复两个字：可用")])

    # ------------------------------------------------------------------ 内部

    def _build_chat(self):  # type: ignore[no-untyped-def]
        config = self._runtime.llm()
        if not config.is_configured:
            raise ChatError("尚未配置对话模型，请到设置 → 模型配置里填写 API Key 与模型 ID")
        return self._chat_factory(config)


def build_messages(
    *,
    query: str,
    sources: list[SourceRef],
    history: list[ChatMessage] | None,
    system_prompt: str,
) -> list[ChatMessage]:
    """拼提示词：**一条** system（提示词 + 资料）+ 历史 + 当前问题。

    资料必须并进第一条 system，不能另起一条：OpenAI 兼容端点普遍要求
    "system 消息只能出现在开头"，发两条连续的 system 会被 400 拒掉
    （实测 SiliconFlow 返回 `20015 System message must be at the beginning`）。

    顺序上资料放在历史**之前**：历史里可能有上一轮的资料，
    把本轮资料紧挨着问题放，模型更不容易张冠李戴地引用旧编号。
    """
    parts = [system_prompt.strip() or DEFAULT_SYSTEM_PROMPT]

    if sources:
        blocks = []
        for source in sources:
            where = source.document_name
            if source.heading_path:
                where += f" › {source.heading_path}"
            # 页号可能为空（云端解析器目前不返回页码），
            # 不判空就会拼出"（第 None 页）"送到模型面前（实测踩过）
            if source.page is not None:
                where += f"（第 {source.page} 页）"
            blocks.append(f"[{source.index}] {where}\n{source.preview}")
        parts.append("资料：\n\n" + "\n\n".join(blocks) + "\n\n请只依据以上资料回答。")
    else:
        parts.append("资料：（本次检索没有命中任何内容）")

    messages: list[ChatMessage] = [ChatMessage(role="system", content="\n\n".join(parts))]
    for item in history or []:
        messages.append(item)
    messages.append(ChatMessage(role="user", content=query))
    return messages


def _preview(text: str) -> str:
    """压平空白 → 剥掉 HTML 标记 → 截断。

    两个坑都是实测踩到的：

    1. chunk 里带换行与缩进，直接拼进提示词会把「资料」的结构搞乱，先全部压成空格；
    2. **解析器会把 PDF 的表格输出成 HTML**（实测一份专家共识里 40/136 个 chunk
       是 ``<table><tr><td>`` 片段）。原样送进模型，表格数据会被标签噪声淹没；
       原样显示在引用列表里，用户第一眼看到的是 ``</td><td>``。
       这一层同时供提示词与界面使用，所以在这里剥最划算——改一处两处都对。

    只剥"看起来像标签"的部分，不认识的角括号原样保留：正文里出现 ``a < b``
    不该被连内容一起吃掉。
    """
    body = _HTML_TAG.sub(" ", " ".join(text.split()))
    body = " ".join(body.split())
    return body[:MAX_CHUNK_CHARS] + ("…" if len(body) > MAX_CHUNK_CHARS else "")
