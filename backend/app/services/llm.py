"""对话模型（LLM）客户端（M6 快速验证版）。

与 embedding 客户端分开，因为它们是**两种模型**：embedding 只把文本变成向量，
不会说话；对话要的是能读上下文并作答的生成模型。所以配置、错误处理、超时都各自一套。

几个来自实测的约束（都踩过）：

- **SiliconFlow 上的 Qwen3.5 是推理模型**：默认会先吐一大段 ``reasoning_content``，
  把 ``max_tokens`` 吃光后 ``content`` 是空的。测试场景要显式传 ``enable_thinking: false``，
  否则表现为"模型没有回答"。
- ``reasoning_content`` 是**独立字段**，不是 content 的一部分；读的时候不能只看 content。
- 流式与非流式共用同一套请求构造，只有 ``stream`` 一个开关不同。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator, Sequence
from dataclasses import dataclass

import httpx

from app.core.exceptions import UpstreamError
from app.services.thinking import DEFAULT_EFFORT, build_thinking_payload

__all__ = ["ChatError", "ChatMessage", "LLMConfig", "OpenAICompatChat"]

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 120.0
"""比 embedding 宽：生成一段答案比算一次向量慢得多。"""

_MAX_ERROR_BODY = 300


class ChatError(UpstreamError):
    """对话调用失败。

    继承 ``UpstreamError`` 而不是自己一套：协议层就不必逐个接口写 try/except，
    统一异常处理器会把它映射成 502 + 可读文案（换 key / 换模型 / 稍后重试）。
    """

    code = "chat_error"
    message = "对话模型调用失败"


@dataclass(frozen=True, slots=True)
class ChatMessage:
    """一条对话消息。"""

    role: str
    content: str


@dataclass(frozen=True, slots=True)
class LLMConfig:
    """运行期配置快照（来自设置页）。"""

    base_url: str
    api_key: str
    model_id: str
    temperature: float = 0.3
    max_tokens: int = 1024
    enable_thinking: bool = True
    """思考开关，**默认开**（市场上主流模型默认都思考）。

    注意：不同的供应商用不同的字段表示它，由 ``services/thinking.py`` 按方言翻译；
    发错字段的后果是"开关看起来有效、实际没生效"（DeepSeek 就是这样）。
    """
    thinking_effort: str = DEFAULT_EFFORT
    """思考强度，归一化为 low / medium / high；同样交方言层翻译。"""
    thinking_dialect: str | None = None
    """思考方言的显式覆盖（模型 ``options.thinking_dialect``）；空则按地址与模型名自动识别。"""

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key and self.model_id)


@dataclass(frozen=True, slots=True)
class LLMUsage:
    """一次调用的 token 用量（G7 用量统计）。

    **供应商不一定会回这个字段**：OpenAI 兼容协议里 ``usage`` 是可选的，
    流式响应更是通常没有。所以各字段允许为 0，界面要能区分
    "真的用了 0 token" 与 "这家没报"——前者不可能，后者是常态。
    """

    prompt_tokens: int = 0
    completion_tokens: int = 0
    estimated: bool = False
    """这份数字是不是我们自己估的。

    **必须能区分"实测"与"估算"**：向量化接口（OpenAI 兼容的 ``/embeddings``）
    通常根本不返回 usage，我们只能按字符数估。把它当成实测数字展示，
    等于让用户拿一个假精度去做成本判断——那是比不给数字更糟的事。
    """

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    @property
    def is_reported(self) -> bool:
        """供应商是否真的报了用量（全 0 视为没报；自己估的不算报）。"""
        return not self.estimated and self.total_tokens > 0


class OpenAICompatChat:
    """``POST {base_url}/chat/completions``，OpenAI 兼容。"""

    #: 上一次 ``complete`` 的 token 用量；供应商没回 ``usage`` 时为 ``None``。
    #:
    #: 用属性而不是改 ``complete`` 的返回值：它的调用方大多只想要文本，
    #: 为了顺手统计用量去改签名会波及每一处调用（G7 只需要在这里记一下）。
    last_usage: LLMUsage | None = None

    def __init__(
        self,
        config: LLMConfig,
        *,
        client: httpx.Client | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self.config = config
        self._client = client
        self._timeout = timeout

    # ------------------------------------------------------------------ 接口

    def complete(self, messages: Sequence[ChatMessage]) -> str:
        """一次性拿完整回答。"""
        with self._open() as client:
            response = client.post(
                f"{self.config.base_url.rstrip('/')}/chat/completions",
                headers=self._headers(),
                json={**self._payload(messages), "stream": False},
            )
        body = self._decode(response)
        # 记下这一轮的 token 用量，供调用方取（见 ``last_usage``）。
        # 放在这里而不是让 complete 换返回值：那会改掉所有调用方的签名，
        # 而绝大多数调用方并不关心用量。
        self.last_usage = _usage_of(body)
        return _content_of(body)

    def stream(self, messages: Sequence[ChatMessage]) -> Iterator[str]:
        """流式产出增量文本（SSE）。

        逐块 yield，调用方可以直接转给前端做打字机效果——快速验证场景里
        "看着它写"比"等十秒然后一次出现"重要得多。
        """
        with self._open() as client, client.stream(
            "POST",
            f"{self.config.base_url.rstrip('/')}/chat/completions",
            headers=self._headers(),
            json={**self._payload(messages), "stream": True},
        ) as response:
            if response.status_code != 200:
                response.read()
                raise ChatError(_error_hint(response))
            for line in response.iter_lines():
                delta = _delta_of(line)
                if delta:
                    yield delta

    # ------------------------------------------------------------------ 内部

    def _open(self) -> httpx.Client:
        """复用外部传入的 client（测试用），否则每次新建。"""
        if self._client is not None:
            return _ReusedClient(self._client)
        return httpx.Client(timeout=self._timeout)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }

    def _payload(self, messages: Sequence[ChatMessage]) -> dict:
        payload: dict = {
            "model": self.config.model_id,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "temperature": self.config.temperature,
            "max_tokens": self.config.max_tokens,
        }
        # 思考参数按供应商方言翻译：各家字段名不同，见 services/thinking.py 的模块注释。
        # 只发这家认识的字段——多发一个未知字段会被严格的端点打成 400。
        payload.update(
            build_thinking_payload(
                base_url=self.config.base_url,
                model_id=self.config.model_id,
                enabled=self.config.enable_thinking,
                effort=self.config.thinking_effort,
                dialect=self.config.thinking_dialect,
                max_tokens=self.config.max_tokens,
            )
        )
        return payload

    def _decode(self, response: httpx.Response) -> dict:
        if response.status_code != 200:
            raise ChatError(_error_hint(response))
        try:
            return response.json()
        except ValueError as exc:
            raise ChatError(f"对话端点返回的不是 JSON：{exc}") from exc


class _ReusedClient:
    """把外部 client 包成上下文管理器，这样调用方不必区分两种来源。"""

    def __init__(self, client: httpx.Client) -> None:
        self._client = client

    def __enter__(self) -> httpx.Client:
        return self._client

    def __exit__(self, *_: object) -> None:
        return None


def _usage_of(body: dict) -> LLMUsage | None:
    """从响应体里取 token 用量；没有就返回 ``None``。

    **不因为缺字段而报错**：usage 在 OpenAI 兼容协议里是可选的，
    自建网关与部分国产服务都不回。为了统计把整次对话搞失败是本末倒置。
    """
    usage = body.get("usage")
    if not isinstance(usage, dict):
        return None
    try:
        return LLMUsage(
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
        )
    except (TypeError, ValueError):
        return None


def _content_of(body: dict) -> str:
    """取回答正文。

    推理模型会把思考写在 ``reasoning_content``；关掉思考后正文在 ``content``。
    两者都空时给出**可处置**的提示，而不是返回一个空字符串让界面发呆。
    """
    try:
        message = body["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ChatError(f"对话响应格式不符合 OpenAI 规范：{exc}") from exc

    content = (message.get("content") or "").strip()
    if content:
        return content

    if (message.get("reasoning_content") or "").strip():
        raise ChatError(
            "模型只返回了思考过程、没有正文：这是推理模型，思考吃掉了回复预算。"
            "请把「最大回复长度」调大，或在输入框把思考强度调低 / 关闭思考"
        )
    # 两者都空：**不能**返回空串。返回空串的话上层只会得到一句"没有回答"，
    # 用户看不出是模型没配好、被限流还是提示词太长——所以在这里就给出可处置的原因。
    raise ChatError(
        "模型返回了空正文：常见原因是 max_tokens 太小、提示词过长被截断，"
        "或该模型不支持当前请求格式。请到设置 → 对话模型里检查后重试"
    )


def _delta_of(line: str) -> str:
    """从一行 SSE 里取出增量文本。非数据行与结束标记返回空串。"""
    if not line or not line.startswith("data:"):
        return ""
    payload = line[5:].strip()
    if not payload or payload == "[DONE]":
        return ""
    try:
        body = json.loads(payload)
        return body["choices"][0].get("delta", {}).get("content") or ""
    except (KeyError, IndexError, TypeError, ValueError):
        return ""


def _error_hint(response: httpx.Response) -> str:
    """把 HTTP 错误翻成处置建议。"""
    body = response.text[:_MAX_ERROR_BODY]
    if response.status_code == 401:
        return f"对话端点鉴权失败（401）：请检查 API Key。{body}"
    if response.status_code == 404:
        return f"对话端点不存在（404）：请检查接口地址与模型 ID。{body}"
    if response.status_code == 429:
        return f"对话端点限流（429）：免费模型额度可能已用尽，稍后重试。{body}"
    return f"对话端点返回 {response.status_code}：{body}"
