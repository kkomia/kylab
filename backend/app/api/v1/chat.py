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

from app.api.v1.schemas import ChatRequestIn, ChatResponseOut, ChatSourceOut
from app.core.services import Services, get_services
from app.services.chat import ChatService
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
    payload: ChatRequestIn, services: Services = Depends(get_services)
) -> StreamingResponse:
    return StreamingResponse(
        _events(services.chat, payload),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@router.post("/chat", response_model=ChatResponseOut, summary="快速检索问答（一次性）")
async def chat_once(
    payload: ChatRequestIn, services: Services = Depends(get_services)
) -> ChatResponseOut:
    """非流式版本：给脚本、MCP 与自动化测试用，逻辑与流式完全相同。"""
    sources = services.chat.retrieve_sources(
        query=payload.query,
        kb_ids=payload.kb_ids,
        top_k=payload.top_k or services.runtime.get_int("chat.top_k") or 6,
    )
    answer = services.chat.answer(
        query=payload.query,
        sources=sources,
        history=_history(payload),
    )
    return ChatResponseOut(answer=answer.answer, sources=_sources_out(answer.sources))


# --------------------------------------------------------------------- 内部


def _events(chat: ChatService, payload: ChatRequestIn) -> Iterator[str]:
    """把一次问答摊成一串 SSE 事件。

    任何异常都在**流内**报出去（``type=error``）而不是靠 HTTP 状态码：
    流一旦开始发送，状态码已经发出去了，改不了——这也是最容易漏的一处。
    """
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
            history=_history(payload),
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

    yield _sse({"type": "done", "answer": "".join(collected)})


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _history(payload: ChatRequestIn) -> list[ChatMessage]:
    return [ChatMessage(role=item.role, content=item.content) for item in payload.history]


def _sources_out(sources) -> list[ChatSourceOut]:  # type: ignore[no-untyped-def]
    return [ChatSourceOut.model_validate(source) for source in sources]


__all__ = ["router"]
