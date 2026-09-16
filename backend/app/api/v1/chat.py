"""对话端点：最简快速检索问答（M6 验证版）。

协议选择上有一处刻意：**流式（SSE）是默认**。
快速验证场景里"看着它一个字一个字写"远比"等十秒然后整段出现"有用，
而且出问题时能立刻看出是模型在胡扯还是检索没命中。

事件形状（``text/event-stream``，每行一个 JSON）：

```
data: {"type":"step","phase":"intent","label":"意图：查事实","detail":"…"}   # Agent 步骤
data: {"type":"sources","items":[...]}      # 依据；多轮检索会多次发出，始终是累计列表
data: {"type":"thinking","text":"…"}         # 思考增量（推理模型的 reasoning_content）
data: {"type":"delta","text":"向"}           # 逐块增量
data: {"type":"done","answer":"…"}           # 收尾（含拼接后的全文，便于前端兜底）
data: {"type":"error","message":"…"}         # 任何失败都在流内报，不吞
```

Agent 工作流（v20）默认开启，可用设置项 ``chat.agent_enabled`` 关掉退回单轮检索。
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
from app.services.agent import (
    DeltaEvent,
    SourcesEvent,
    StepEvent,
    ThinkingEvent,
)
from app.services.api_key import Caller
from app.services.llm import ChatError, ChatMessage
from app.services.suggested_questions import (
    DEFAULT_LIMIT as SUGGESTED_DEFAULT_LIMIT,
)
from app.services.suggested_questions import (
    MAX_QUESTIONS as SUGGESTED_MAX,
)
from app.services.suggested_questions import (
    MIN_QUESTIONS as SUGGESTED_MIN,
)

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
def chat_stream(
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
def chat_once(
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
    history, summary, _ = _context(services, payload, model_pk)

    if _use_agent(services):
        answer = services.chat.answer_agent(
            query=payload.query,
            kb_ids=payload.kb_ids,
            history=history,
            summary=summary,
            model_pk=model_pk,
            thinking=thinking,
            thinking_effort=effort,
            top_k=payload.top_k,
        )
    else:
        sources = services.chat.retrieve_sources(
            query=payload.query,
            kb_ids=payload.kb_ids,
            top_k=payload.top_k or services.runtime.get_int("chat.top_k") or 6,
        )
        answer = services.chat.answer(
            query=payload.query,
            sources=sources,
            history=history,
            summary=summary,
            model_pk=model_pk,
            thinking=thinking,
            thinking_effort=effort,
        )
    _record_turn(services, payload, answer=answer.answer, sources=answer.sources)
    return ChatResponseOut(answer=answer.answer, sources=_sources_out(answer.sources))


@router.get(
    "/chat/suggested-questions",
    response_model=SuggestedQuestionsOut,
    summary="推荐问题（取自入库时为各分段生成的问题）",
)
def suggested_questions(
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
    kb_ids: str = Query(default="", description="逗号分隔的知识库 id；留空返回空列表"),
    limit: int | None = Query(
        default=None,
        ge=SUGGESTED_MIN,
        le=SUGGESTED_MAX,
        description="最多返回几条；留空用默认",
    ),
) -> SuggestedQuestionsOut:
    """给对话页空状态那排胶囊喂数据。

    **不再调模型**（v23）：问题在**入库时**就为每个分段生成好了（见
    `services/suggested_questions.py`），这里只是随机抽几段、把它们的问题取回来。
    这样空状态看到的"你可以这样问"与库里真实内容一致，也不必为一个引导多花一次
    模型调用。

    **失败返回空列表而不是报错**（``generated=false``）：库里还没有问题
    （功能没开、或文档还没重新摄入）时如此，界面据此回退到静态样例——
    不该把"打开对话页"变成一次错误提示。
    """
    ids = [item.strip() for item in kb_ids.split(",") if item.strip()]
    if ids:
        check_kb_scope(services, caller, ids)
    questions = services.suggested_questions.list_questions(
        kb_ids=ids, limit=limit or SUGGESTED_DEFAULT_LIMIT
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

    两条链路：Agent 工作流（默认，见 ``services/agent.py``）与单轮检索（``chat.agent_enabled``
    关掉时）。两条都会把 ``sources`` 与 ``delta`` 用同一套事件形状发出去，
    前端不必关心走的是哪条。
    """
    chat = services.chat
    collected: list[str] = []
    sources: list = []
    # 上下文（含压缩）对两条链路都适用：Agent 关掉时同样需要"摘要 + 最近原文"
    history, summary, compressed = _context(services, payload, model_pk)
    if compressed:
        yield _sse(
            {
                "type": "step",
                "phase": "compress",
                "label": "压缩上下文",
                "detail": "较早的对话已折成摘要，之后的问答仍记得它们",
                "status": "done",
            }
        )

    if _use_agent(services):
        try:
            for event in chat.answer_agent_stream(
                query=payload.query,
                kb_ids=payload.kb_ids,
                history=history,
                summary=summary,
                model_pk=model_pk,
                thinking=thinking,
                thinking_effort=effort,
                top_k=payload.top_k,
            ):
                if isinstance(event, StepEvent):
                    yield _sse(
                        {
                            "type": "step",
                            "phase": event.phase,
                            "label": event.label,
                            "detail": event.detail,
                            "status": event.status,
                            # 两个都是"可选补充"，只在有意义时发（v25）：
                            # degraded 让界面给重试入口，added 让界面说清这轮找到了几条新资料
                            **({"degraded": True} if event.degraded else {}),
                            **({"added": event.added} if event.added is not None else {}),
                        }
                    )
                elif isinstance(event, SourcesEvent):
                    sources = event.sources
                    yield _sse(
                        {
                            "type": "sources",
                            "items": [item.model_dump() for item in _sources_out(sources)],
                        }
                    )
                elif isinstance(event, ThinkingEvent):
                    yield _sse({"type": "thinking", "text": event.text})
                elif isinstance(event, DeltaEvent):
                    collected.append(event.text)
                    yield _sse({"type": "delta", "text": event.text})
                # DoneEvent 不在这里发：收尾统一放在循环外，保证 done 里的全文
                # 与落库用的 answer 是同一个字符串
        except ChatError as exc:
            yield _sse({"type": "error", "message": str(exc)})
            return
        except Exception as exc:
            logger.exception("对话流异常")
            yield _sse({"type": "error", "message": f"对话失败：{exc}"})
            return
    else:
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
        try:
            for delta in chat.answer_stream(
                query=payload.query,
                sources=sources,
                history=history,
                summary=summary,
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


def _use_agent(services: Services) -> bool:
    """Agent 工作流是否启用（设置项 ``chat.agent_enabled``，默认开）。"""
    raw = services.runtime.get("chat.agent_enabled")
    if raw is None:
        return True
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _context(
    services: Services, payload: ChatRequestIn, model_pk: str | None
) -> tuple[list[ChatMessage], str, bool]:
    """本轮要带给模型的历史、摘要，以及"这轮有没有做过压缩"。

    **不指定会话**（脚本/MCP 无状态调用）时不压缩：没有会话就没有历史可压。
    ``prepare_context`` 里的摘要调用可能失败（模型临时不可用），这里兜底成
    "最近若干条历史"——压缩是优化，不该把整轮问答拖垮。
    """
    if not payload.conversation_id:
        return (
            [ChatMessage(role=item.role, content=item.content) for item in payload.history],
            "",
            False,
        )
    try:
        prepared = services.chat.prepare_context(
            conversation_id=payload.conversation_id, query=payload.query, model_pk=model_pk
        )
        return prepared.history, prepared.summary, prepared.compressed
    except Exception:
        logger.warning("上下文准备失败，退回最近历史", exc_info=True)
        return services.conversations.history(payload.conversation_id), "", False


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
