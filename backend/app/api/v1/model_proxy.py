"""**模型代理**端点（Phase B · P2，2026-09-29）：服务器拿**自己的 key** 调模型，
把结果 / SSE 原样转给客户端 ✓。

## 为什么单开一个 router

`api/v1/chat.py` 是**会话那条链**（检索 → 循环 → 落库 ✓），它刚被别的 lane 提交过 ✗。
代理这条链与它无关 ✓：**只做"消息进、增量出"** ✓，所以放新文件、注册一行 ✓ ——
既减少争用，也让"代理"这件事有自己的落点。

## 边界（照裁定）

- **鉴权**：用户会话令牌 ✓（`require_read` ✓，与检索端点同一档 ✓）；
- **key 不下发** ✗：上游配置从 `services.runtime.llm_for(...)` 读 ✓（服务端自己的 key ✓）；
- **客户端传的是 OpenAI 兼容的消息形状** ✓（`_message_wire` 那个咽喉的产物 ✓）——
  代理只做一次反序列化 ✓，不重新拼提示词 ✗；
- **SSE 透传** ✓：每个增量一条 `data: {json}` ✓，收尾 `data: [DONE]` ✓ ——
  壳里聊天要逐字冒 ✓（这正是我们裁定"前端直连远端"的原因 ✓）；
- **配额/计费**：**占位注释** ✓（P4 做 ✗，现在不实现 ✗）。
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator

from app.api.auth import require_read
from app.core.services import Services, get_services
from app.services.api_key import Caller
from app.services.llm import ChatMessage, LLMDelta, OpenAICompatChat, ToolSpec

router = APIRouter(tags=["model-proxy"])

#: SSE 的媒体类型（与前端/壳那侧的解析口径一致 ✓）。
SSE_MEDIA_TYPE = "text/event-stream"


class _WireMessage(BaseModel):
    """客户端传来的消息（OpenAI 兼容形状 ✓，与 `llm._message_wire` 的产物一致 ✓）。"""

    role: str
    content: str = ""


class _WireTool(BaseModel):
    name: str
    description: str = ""
    parameters: dict = Field(default_factory=dict)


class ProxyRequest(BaseModel):
    messages: list[_WireMessage] = Field(default_factory=list)
    tools: list[_WireTool] = Field(default_factory=list)
    model_pk: str | None = Field(default=None, description="留空用全局默认模型")

    @model_validator(mode="after")
    def _require_messages(self) -> ProxyRequest:
        """**空 body 必须 422，不能变成 502** ✗（P2 复盘：真请求打过一次空 body → 502 ✓）。

        502 的意思是"上游不可用" ✗，而空 body 是**参数问题** ✓。把参数问题报成上游故障，
        正是"失败分档"要防的误导（离线明示、排障、配额统计都会跟着错 ✗）。
        所以先校验：一条消息都没有就拒（422 ✓），根本不去碰模型 ✓。
        """
        if not self.messages:
            raise ValueError("messages 不能为空：至少给一条消息（role + content）")
        return self


class ProxyTextOut(BaseModel):
    text: str


def _messages(payload: ProxyRequest) -> list[ChatMessage]:
    return [ChatMessage(role=item.role, content=item.content) for item in payload.messages]


def _tools(payload: ProxyRequest) -> list[ToolSpec] | None:
    if not payload.tools:
        return None
    return [
        ToolSpec(name=item.name, description=item.description, parameters=item.parameters)
        for item in payload.tools
    ]


def _chat(services: Services, payload: ProxyRequest) -> OpenAICompatChat:
    """用**服务端**的模型档位建客户端 ✓（key 在这一侧 ✓，不下发 ✗）。

    TODO(P4)：配额与计费在这里挂钩子 —— 现在不做 ✗。
    """
    config = services.runtime.llm_for(payload.model_pk)
    return OpenAICompatChat(config)


def _sse(delta: LLMDelta) -> str:
    body: dict[str, object] = {"text": delta.text, "reasoning": delta.reasoning}
    if delta.tool_calls:
        body["tool_calls"] = [
            {
                "index": call.index,
                "id": call.id,
                "name": call.name,
                "arguments": call.arguments,
            }
            for call in delta.tool_calls
        ]
    return f"data: {json.dumps(body, ensure_ascii=False)}\n\n"


@router.post("/model-proxy/complete", response_model=ProxyTextOut, summary="模型代理：一次性补全")
def complete(
    payload: ProxyRequest,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
) -> ProxyTextOut:
    """一次性补全（子 Agent、摘要这类小任务 ✓）。``caller`` 只用于鉴权 ✓。"""
    del caller
    return ProxyTextOut(text=_chat(services, payload).complete(_messages(payload)))


def _stream(payload: ProxyRequest, services: Services, *, with_tools: bool) -> Iterator[str]:
    client = _chat(services, payload)
    events = client.stream_events(_messages(payload), _tools(payload) if with_tools else None)
    for delta in events:
        yield _sse(delta)
    yield "data: [DONE]\n\n"


@router.post("/model-proxy/stream", summary="模型代理：流式（只要正文）")
def stream(
    payload: ProxyRequest,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
) -> StreamingResponse:
    """只转正文增量 ✓（这条给普通对话用 ✓）。``caller`` 只用于鉴权 ✓。"""
    del caller
    return StreamingResponse(
        _stream(payload, services, with_tools=False), media_type=SSE_MEDIA_TYPE
    )


@router.post("/model-proxy/events", summary="模型代理：流式 + 工具调用（SSE 透传）")
def events(
    payload: ProxyRequest,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
) -> StreamingResponse:
    """带工具位的那条（边车的工具循环用 ✓）。``caller`` 只用于鉴权 ✓。"""
    del caller
    return StreamingResponse(
        _stream(payload, services, with_tools=True), media_type=SSE_MEDIA_TYPE
    )
