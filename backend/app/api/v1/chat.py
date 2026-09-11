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

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.api.auth import check_kb_scope, require_read
from app.api.v1.schemas import ChatRequestIn, ChatResponseOut, ChatSourceOut
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
    return StreamingResponse(
        _events(services, payload),
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

    sources = services.chat.retrieve_sources(
        query=payload.query,
        kb_ids=payload.kb_ids,
        top_k=payload.top_k or services.runtime.get_int("chat.top_k") or 6,
    )
    answer = services.chat.answer(
        query=payload.query,
        sources=sources,
        history=_history(services, payload),
    )
    _record_turn(services, payload, answer=answer.answer, sources=answer.sources)
    return ChatResponseOut(answer=answer.answer, sources=_sources_out(answer.sources))


# --------------------------------------------------------------------- 内部


def _events(services: Services, payload: ChatRequestIn) -> Iterator[str]:
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
    # 否则回看时会出现"问了但没答"的空档，而用户无从判断当时发生了什么
    _record_turn(services, payload, answer=answer, sources=sources)
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
