"""模型那条接缝的**远端实现**（Phase B · P2，2026-09-29）。

这一层放着"**打我们自己的后端**"的那份实现（v0.1 起只服务"客户端不带 key、
由服务端代发模型"那种部署）✓。

## 用现有端点，不新造 ✗

- 模型：`POST /api/v1/model-proxy/complete|stream|events`（本层同批新增的 router ✓，
  见 `api/v1/model_proxy.py`）—— 服务器用自己的 key 调上游 ✓，**客户端永远看不到 key** ✓。

## 认证与失败语义

认证是**用户会话令牌** ✓（`Authorization: Bearer …` ✓，与前端/壳同一套 ✓）。
**"不可用"与"没内容"必须分开** ✗：

- 网络失败 / 超时 / 5xx → `RemoteUnavailableError`（**抛** ✗，不是空结果 ✓）；
- 4xx（鉴权过期、参数被拒）→ `RemoteRejectedError`（抛 ✓，带着服务端那句话 ✓）。
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Sequence
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # 只为类型标注：**模块级不 import httpx**（见下面 `_httpx()` 的说明）
    import httpx

from app.services.llm import ChatMessage, LLMDelta, ToolCallDelta, ToolSpec, _call_deltas

__all__ = [
    "RemoteClientError",
    "RemoteModelClient",
    "RemoteRejectedError",
    "RemoteUnavailableError",
]


def _httpx():  # type: ignore[no-untyped-def]
    """第一次用到时才导入 httpx（**模块级导入会让客户端运行时多背 click + pygments + rich** ✗）。

    为什么：`httpx/__init__.py` 里有一句 `from ._main import main`（它自带的 CLI 入口 ✓），
    于是**任何** `import httpx` 都会顺带拉进 `click` + `pygments` + `rich`（实测约 5.5 MB ✗）。
    而客户端（边车）只需要它**发请求**那部分能力 ✓ —— 按需导入即可：
    包里照旧装着 httpx ✓（调用那一刻导得进来 ✓），只是它不再出现在**导入闭包**里 ✓。

    **行为一个字没变**：缺包时仍在**第一次调用那一刻**抛 `ModuleNotFoundError` ✓
    （原先在导入模块那一刻抛 ✓）。判据见 `scripts/sidecar-closure.py`（重跑闭包看它是否消失 ✓）。
    """
    global _HTTPX
    if _HTTPX is None:
        import httpx

        _HTTPX = httpx
    return _HTTPX


_HTTPX = None


class RemoteClientError(RuntimeError):
    """远端实现这一族的基类（调用方按子类分档处理 ✓）。"""


class RemoteUnavailableError(RemoteClientError):
    """**服务端不可用**（连不上 / 超时 / 5xx）—— 与"没命中"是两件事 ✗。"""


class RemoteRejectedError(RemoteClientError):
    """**请求被拒**（4xx：令牌过期、越权、参数不合法）。"""


def _auth_headers(token: str) -> dict[str, str]:
    """用户会话令牌 → 鉴权头（与前端/壳同一套 ✓，**不放模型 key** ✗）。"""
    return {"Authorization": f"Bearer {token}"} if token else {}


class RemoteModelClient:
    """远端实现：打服务器上的**模型代理** ✓（key 不下发 ✓）。

    三个方法与循环要的模型能力同名同签名（`complete` / `stream` / `stream_events`）；
    `stream` / `stream_events` 都吃 SSE ✓（代理把上游的增量原样转出 ✓，见
    `api/v1/model_proxy.py`）。

    **注意**：本机档**不用它**（模型在本机直连，见 `sidecar._LocalModel`），而它对面的
    `/model-proxy` 端点也随服务器档 API 面从本仓库拆掉了——这一层是留给
    "客户端不带 key、由服务端代发"那种部署的接缝。
    """

    def __init__(
        self,
        base_url: str,
        *,
        token: str = "",
        timeout: float = 120.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout
        self._transport = transport

    def complete(self, messages: Sequence[ChatMessage]) -> str:
        payload = self._post_json("/model-proxy/complete", {"messages": _wire_messages(messages)})
        return str(payload.get("text") or "")

    def stream(self, messages: Sequence[ChatMessage]) -> Iterator[str]:
        for delta in self._stream("/model-proxy/stream", {"messages": _wire_messages(messages)}):
            if delta.text:
                yield delta.text

    def stream_events(
        self, messages: Sequence[ChatMessage], tools: Sequence[ToolSpec] | None = None
    ) -> Iterator[LLMDelta]:
        body: dict[str, object] = {"messages": _wire_messages(messages)}
        if tools:
            body["tools"] = [
                {
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": spec.parameters,
                }
                for spec in tools
            ]
        yield from self._stream("/model-proxy/events", body)

    # ------------------------------------------------------------------ 内部

    def _client(self):  # type: ignore[no-untyped-def]
        httpx = _httpx()
        return httpx.Client(
            base_url=self._base,
            timeout=self._timeout,
            transport=self._transport,
            headers=_auth_headers(self._token),
        )

    def _post_json(self, path: str, body: dict[str, object]) -> dict:
        httpx = _httpx()
        try:
            with self._client() as client:
                response = client.post(path, json=body)
        except httpx.HTTPError as exc:
            raise RemoteUnavailableError(f"模型代理连不上：{type(exc).__name__}: {exc}") from exc
        if response.status_code >= 500:
            raise RemoteUnavailableError(
                f"模型代理出错了（HTTP {response.status_code}）：{response.text[:200]}"
            )
        if response.status_code >= 400:
            raise RemoteRejectedError(
                f"模型代理拒绝了请求（HTTP {response.status_code}）：{response.text[:200]}"
            )
        payload = response.json()
        return payload if isinstance(payload, dict) else {}

    def _stream(self, path: str, body: dict[str, object]) -> Iterator[LLMDelta]:
        """SSE：`data: {json}` 一行一块；`data: [DONE]` 收尾。

        **分片要能重组** ✓：增量可能被 TCP 切成任意片段，所以按行缓冲 ✗ 不按 chunk 猜 ✗。
        """
        httpx = _httpx()
        try:
            with (
                self._client() as client,
                client.stream("POST", path, json=body) as response,
            ):
                if response.status_code >= 500:
                    raise RemoteUnavailableError(f"模型代理出错了（HTTP {response.status_code}）")
                if response.status_code >= 400:
                    raise RemoteRejectedError(
                        f"模型代理拒绝了请求（HTTP {response.status_code}）"
                    )
                for line in response.iter_lines():
                    text = line.strip()
                    if not text.startswith("data:"):
                        continue
                    raw = text[5:].strip()
                    if raw in ("", "[DONE]"):
                        continue
                    try:
                        chunk = json.loads(raw)
                    except ValueError:
                        continue
                    if not isinstance(chunk, dict):
                        continue
                    yield LLMDelta(
                        text=str(chunk.get("text") or ""),
                        reasoning=str(chunk.get("reasoning") or ""),
                        # **工具调用碎片必须转出去**（2026-09-29 查实的根因）：代理那侧
                        # `model_proxy._sse` 一直在发 `tool_calls` ✓，而这里只拼了 text/reasoning ✗
                        # → 工具循环永远看不到调用 ✗ → 真模型上**任何工具都调不起来** ✗，
                        # 而"模型只吐工具调用、没有正文"的表现就是**空回答** ✓。
                        # 映射复用 `llm._call_deltas`：碎片形状（index/id/name/arguments）
                        # 与逐块容错都只有那一处实现，别在这儿再写一份 ✓。
                        # `_proxy_call_deltas` 只做一件事：把代理的**扁平**形状
                        # 归一成嵌套形状 ✓（见它的说明）。
                        tool_calls=_proxy_call_deltas(chunk.get("tool_calls")),
                    )
        except httpx.HTTPError as exc:
            raise RemoteUnavailableError(f"模型代理连不上：{type(exc).__name__}: {exc}") from exc


def _proxy_call_deltas(raw_calls: object) -> tuple[ToolCallDelta, ...]:
    """代理 SSE 的 `tool_calls` → **归一成 OpenAI 嵌套形状**，再交给 `llm._call_deltas`。

    **这是 P3 收口的最后一环**（2026-09-29，实测数字）：代理那侧 `model_proxy._sse`
    发的是**扁平**形状 ``{index, id, name, arguments}`` ✓，而上游与 `llm._call_deltas`
    认的是 **OpenAI 嵌套**形状 ``{index, id, function: {name, arguments}}`` ✓ ——
    差一层 `function` ✗，于是 `_call_deltas` 取到的 name/arguments 全是空串 ✗。

    现场数字（`.shots/sidecar-path-probe.json`，真实一轮）：
    **工具 8 件都传下去了 ✓、`tool_calls` 碎片回来了 13 个 ✓，但 13 个的名字与参数全是空** ✗
    → 循环拼不出一个能执行的调用 ✓ → 现象就是"模型手上有 8 件工具却只宣布意图" ✓。

    ⚠️ 这里**只做形状归一**，解析仍然只有 `llm._call_deltas` 那一份实现 ✗（不写第二份 ✗）：
    两种形状都能过（带 `function` 的原样放行 ✓），这样无论代理以后改成嵌套还是保持扁平 ✓ 都对。
    """
    if not isinstance(raw_calls, list):
        return ()
    normalised: list[object] = []
    for raw in raw_calls:
        if not isinstance(raw, dict) or "function" in raw:
            normalised.append(raw)
            continue
        normalised.append(
            {
                "index": raw.get("index"),
                "id": raw.get("id"),
                "function": {"name": raw.get("name"), "arguments": raw.get("arguments")},
            }
        )
    return _call_deltas(normalised)


def _wire_messages(messages: Sequence[ChatMessage]) -> list[dict[str, object]]:
    """`ChatMessage` → 请求体里的消息（**复用 `_message_wire` 那个咽喉** ✓ —— 清洗与
    工具位序列化只有一处实现 ✗，别在这儿再写一份 ✗）。"""
    from app.services.llm import _message_wire

    return [_message_wire(message) for message in messages]
