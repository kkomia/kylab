"""对话端点：最简快速检索问答（M6 验证版）。

协议选择上有一处刻意：**流式（SSE）是默认**。
快速验证场景里"看着它一个字一个字写"远比"等十秒然后整段出现"有用，
而且出问题时能立刻看出是模型在胡扯还是检索没命中。

事件形状（``text/event-stream``，每行一个 JSON）：

```
data: {"type":"sources","items":[...]}      # 先给依据，再给答案
data: {"type":"delta","text":"向"}           # 逐块增量
data: {"type":"done","answer":"…"}           # 收尾（含拼接后的全文，便于前端兜底）
data: {"type":"error","message":"…"}         # 任何失败都在流内报，不吞
```
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from app.api.auth import check_kb_scope, require_read
from app.api.v1.schemas import (
    ChatRequestIn,
    ChatResponseOut,
    ChatSourceOut,
    SuggestedQuestionsOut,
)
from app.core.services import Services, get_services
from app.services.api_key import Caller
from app.services.llm import ChatError, ChatMessage

logger = logging.getLogger(__name__)

router = APIRouter(tags=["chat"])

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    # 关掉 nginx 一类反代的缓冲，否则流式会被攒成一坨再发
    "X-Accel-Buffering": "no",
}


@router.post(
    "/chat/stream",
    summary="快速检索问答（流式）",
    response_class=StreamingResponse,
)
async def chat_stream(
    payload: ChatRequestIn,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> StreamingResponse:
    # 对话会读到库内原文，所以同样受密钥的库范围约束
    check_kb_scope(services, caller, payload.kb_ids)
    _require_conversation(services, payload, caller)
    _warn_on_scope_drift(services, payload)
    model_pk = _effective_model(services, payload)
    thinking, effort = _effective_thinking(services, payload)
    # **在流开始前把模型校验掉**：坏 pk 应当是 422，而不是流内的一条 error 事件
    # （流一旦开始，状态码已经发出去了）。没配任何模型不算错，交由流内报可读文案。
    services.chat.llm_config(model_pk)
    return StreamingResponse(
        _events(services, payload, model_pk, thinking, effort),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@router.post("/chat", response_model=ChatResponseOut, summary="快速检索问答（一次性）")
async def chat_once(
    payload: ChatRequestIn,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> ChatResponseOut:
    """非流式版本：给脚本、MCP 与自动化测试用，逻辑与流式完全相同。"""
    check_kb_scope(services, caller, payload.kb_ids)
    _require_conversation(services, payload, caller)
    _warn_on_scope_drift(services, payload)
    model_pk = _effective_model(services, payload)
    thinking, effort = _effective_thinking(services, payload)

    sources = services.chat.retrieve_sources(
        query=payload.query,
        kb_ids=payload.kb_ids,
        top_k=payload.top_k or services.runtime.get_int("chat.top_k") or 6,
    )
    answer = services.chat.answer(
        query=payload.query,
        sources=sources,
        history=_history(services, payload),
        model_pk=model_pk,
        thinking=thinking,
        thinking_effort=effort,
    )
    _record_turn(services, payload, answer=answer.answer, sources=answer.sources)
    return ChatResponseOut(answer=answer.answer, sources=_sources_out(answer.sources))


@router.get(
    "/chat/suggested-questions",
    response_model=SuggestedQuestionsOut,
    summary="示例问题（依据所选知识库的语料生成）",
)
def suggested_questions(
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
    kb_ids: str = Query(default="", description="逗号分隔的知识库 id；留空返回空列表"),
    limit: int = Query(default=6, ge=1, le=8),
    model_pk: str | None = Query(default=None, description="用哪个模型生成；留空用全局默认"),
    refresh: bool = Query(default=False, description="true 绕过缓存重新生成"),
) -> SuggestedQuestionsOut:
    """给对话页空状态那排胶囊喂数据。

    **失败返回空列表而不是报错**（``generated=false``）：示例问题只是引导，
    拿不到就让界面回退到静态样例，不该把"打开对话页"变成一次错误提示。
    """
    ids = [item.strip() for item in kb_ids.split(",") if item.strip()]
    if ids:
        check_kb_scope(services, caller, ids)
    questions = services.suggested_questions.suggest(
        kb_ids=ids, limit=limit, model_pk=model_pk, refresh=refresh
    )
    return SuggestedQuestionsOut(questions=questions, generated=bool(questions))


# --------------------------------------------------------------------- 内部


def _effective_model(services: Services, payload: ChatRequestIn) -> str | None:
    """这一轮实际用哪个对话模型。

    优先级：**请求里的 ``model_pk`` > 会话已存的 ``model_pk`` > 全局默认（``None``）**。

    请求带了 ``model_pk`` 且指定了会话时**回写会话**——用户在输入框换了模型，
    这条会话就该记住新选择（v12"跟随会话保存"）。回写失败只记日志：模型选择没存上
    不该让这一轮问不出来。
    """
    if payload.model_pk:
        if payload.conversation_id:
            try:
                record = services.conversations.get(payload.conversation_id)
                if record.model_pk != payload.model_pk:
                    services.conversations.set_model(payload.conversation_id, payload.model_pk)
            except Exception:
                logger.exception("会话模型回写失败：%s", payload.conversation_id)
        return payload.model_pk
    if payload.conversation_id:
        # 走到这里说明 `_require_conversation` 已经把"不存在/越主"挡掉了（404）
        return services.conversations.get(payload.conversation_id).model_pk
    return None


def _effective_thinking(
    services: Services, payload: ChatRequestIn
) -> tuple[bool | None, str | None]:
    """这一轮实际用哪档思考设置。

    与 ``_effective_model`` 同一套优先级：**请求 > 会话已存 > 全局默认（``None``）**。
    请求里带了任一项且指定了会话时回写会话，让这条会话记住用户在输入框里的选择；
    回写失败只记日志——偏好没存上不该让这一轮问不出来。

    返回 ``None`` 表示"交给设置页/模型 options 决定"，而不是"关闭"：
    两层都用 ``None`` 当"没选"，把 False 混进去会让"没选"变成"显式关闭"。
    """
    thinking = payload.thinking
    effort = payload.thinking_effort
    if thinking is None and effort is None:
        if payload.conversation_id:
            record = services.conversations.get(payload.conversation_id)
            return record.thinking, record.thinking_effort
        return None, None

    if payload.conversation_id:
        try:
            record = services.conversations.get(payload.conversation_id)
            merged_thinking = thinking if thinking is not None else record.thinking
            merged_effort = effort if effort is not None else record.thinking_effort
            if record.thinking != merged_thinking or record.thinking_effort != merged_effort:
                services.conversations.set_thinking(
                    payload.conversation_id, merged_thinking, merged_effort
                )
        except Exception:
            logger.exception("会话思考偏好回写失败：%s", payload.conversation_id)
    return thinking, effort


def _events(
    services: Services,
    payload: ChatRequestIn,
    model_pk: str | None,
    thinking: bool | None,
    effort: str | None,
) -> Iterator[str]:
    """把一次问答摊成一串 SSE 事件。

    任何异常都在**流内**报出去（``type=error``）而不是靠 HTTP 状态码：
    流一旦开始发送，状态码已经发出去了，改不了——这也是最容易漏的一处。
    """
    chat = services.chat
    try:
        sources = chat.retrieve_sources(
            query=payload.query,
            kb_ids=payload.kb_ids,
            top_k=payload.top_k,
        )
    except Exception as exc:
        yield _sse({"type": "error", "message": f"检索失败：{exc}"})
        return

    # 用 pydantic 序列化而不是 ``s.__dict__``：
    # SourceRef 是 slots=True 的 dataclass，**没有 __dict__**，
    # 取它会在流式刚发第一个事件时就抛 AttributeError、把连接截断（踩过）。
    yield _sse(
        {
            "type": "sources",
            "items": [item.model_dump() for item in _sources_out(sources)],
        }
    )

    collected: list[str] = []
    try:
        for delta in chat.answer_stream(
            query=payload.query,
            sources=sources,
            history=_history(services, payload),
            model_pk=model_pk,
            thinking=thinking,
            thinking_effort=effort,
        ):
            collected.append(delta)
            yield _sse({"type": "delta", "text": delta})
    except ChatError as exc:
        yield _sse({"type": "error", "message": str(exc)})
        return
    except Exception as exc:
        logger.exception("对话流异常")
        yield _sse({"type": "error", "message": f"对话失败：{exc}"})
        return

    answer = "".join(collected)
    # 只在**回答确实产出了**之后落库：失败的那一轮不留下半截记录，
    # 否则回看时会出现"问了但没答"的空档，而用户无从判断当时发生了什么。
    # 这条判断必须真的写出来——v0.12 之前只有注释、没有 if，于是流"正常结束但一个字都没吐"
    # 时照样落了一条空回答（实测：推理模型的思考吃光预算时就是这样）。
    if answer:
        _record_turn(services, payload, answer=answer, sources=sources)
    else:
        logger.warning("对话流没有产出任何正文，本轮不落库：query=%r", payload.query[:80])
    yield _sse({"type": "done", "answer": answer})


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _history(services: Services, payload: ChatRequestIn) -> list[ChatMessage]:
    """本次要带给模型的历史。

    **带 ``conversation_id`` 时以库里的记录为准**，忽略前端传来的 history：
    两处都带会让同一轮被算两遍（前端那份 + 库里那份），而且刷新后前端那份就没了，
    行为会时好时坏。库里那份是唯一权威。
    """
    if payload.conversation_id:
        return services.conversations.history(payload.conversation_id)
    return [ChatMessage(role=item.role, content=item.content) for item in payload.history]


def _record_turn(services: Services, payload: ChatRequestIn, *, answer: str, sources) -> None:  # type: ignore[no-untyped-def]
    """把这一轮写进会话（仅在指定了 ``conversation_id`` 时）。

    引用**存快照**：``_sources_out`` 出来的就是这一轮实际依据的原文出处。
    事后重查会得到不同的结果，引用编号就对不上了。
    """
    if not payload.conversation_id:
        return
    conversation_id = payload.conversation_id
    try:
        services.conversations.append(
            conversation_id, role="user", content=payload.query
        )
        services.conversations.append(
            conversation_id,
            role="assistant",
            content=answer,
            sources=[item.model_dump(mode="json") for item in _sources_out(sources)],
        )
        services.conversations.ensure_title(conversation_id, payload.query)
    except Exception:
        # 落库失败不该让用户丢掉已经拿到的回答——那是**已经付过费**的结果。
        # 记日志即可；下一轮的历史会缺这一条，但不影响继续对话。
        logger.exception("对话落库失败：%s", conversation_id)


def _require_conversation(services: Services, payload: ChatRequestIn, caller: Caller) -> None:
    """指了会话就必须存在**且属于当前调用方**。

    **不做"静默新建"**：那样用户拼错一个 id 会得到一次正常回答，然后发现历史没存上
    ——而落库失败是静默的（见 ``_record_turn`` 的取舍），两次静默叠起来根本无法排查。
    在**流还没开始**之前抛 404，用户立刻知道 id 不对。

    成员（v10）越主同样 404：对话内容是私有数据，403 会暴露"这条会话存在"。
    不拦的话，成员拿着别人的会话 id 就能把整段历史读走（`_history` 以库里为准）。
    管理员会话不受此限（is_admin）：它要能看到 API Key 建的无主会话。
    """
    if not payload.conversation_id:
        return
    if caller.user is not None and not caller.is_admin:
        services.conversations.get_for_owner(payload.conversation_id, caller.user.id)
    else:
        services.conversations.get(payload.conversation_id)


def _warn_on_scope_drift(services: Services, payload: ChatRequestIn) -> None:
    """会话建立的库范围与本次请求不一致时留一条日志。

    刻意**不拦**：用户可能就是想换个库继续问。但这种情况下的多轮指代会指向
    "上一轮在另一个库里看到的资料"，答非所问很难排查——所以留个痕迹。
    """
    if not payload.conversation_id:
        return
    try:
        record = services.conversations.get(payload.conversation_id)
    except Exception:
        return
    if record.kb_ids and set(record.kb_ids) != set(payload.kb_ids):
        logger.info(
            "会话 %s 的库范围与本次请求不同（会话 %s / 请求 %s），多轮上下文可能不连续",
            record.id,
            list(record.kb_ids),
            payload.kb_ids,
        )


def _sources_out(sources) -> list[ChatSourceOut]:  # type: ignore[no-untyped-def]
    return [ChatSourceOut.model_validate(source) for source in sources]


__all__ = ["router"]
