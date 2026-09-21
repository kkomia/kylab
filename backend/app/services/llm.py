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
from app.core.http import shared_client
from app.services.thinking import DEFAULT_EFFORT, build_thinking_payload, echoes_reasoning

__all__ = [
    "ChatError",
    "ChatMessage",
    "LLMConfig",
    "LLMDelta",
    "OpenAICompatChat",
    "ToolCallDelta",
    "assemble_tool_calls",
]

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
class ToolCall:
    """模型要求调用的一次工具。

    ``arguments`` 保留**原始字符串**，不在这里解析成 dict：模型可能给出不完整或
    不合法的 JSON（尤其是流式拼起来时），而"解析失败"要作为一次可上报的工具错误
    回到循环里，而不是在构造消息时就抛。解析放在执行那一步（见 services/tool_loop.py）。
    """

    id: str
    name: str
    arguments: str = ""


@dataclass(frozen=True, slots=True)
class ToolCallDelta:
    """流式响应里一次工具调用的**碎片**（v0.34）。

    同一个 ``index`` 的若干块按到达顺序拼起来才是完整调用：``id`` 与 ``name``
    通常只在第一块里，``arguments`` 是**逐字符切开**的 JSON（一个参数值可能横跨几块）。
    所以单块不能解析，完整调用由 :func:`assemble_tool_calls` 在流结束后拼。
    """

    index: int
    id: str = ""
    name: str = ""
    arguments: str = ""


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """一个工具的定义（发给模型的 JSON Schema）。"""

    name: str
    description: str
    parameters: dict


@dataclass(frozen=True, slots=True)
class LLMReply:
    """一次模型回复：正文、它要求的工具调用、以及它的思考。

    三者可能同时非空（模型先说一句再做），所以不是一个"二选一"的联合类型。

    **产出者只有一处**：工具循环那一步（``tool_loop._answer``）把流式增量拼成这个形状
    ——正文与思考是攒出来的字符串，工具调用由 :func:`assemble_tool_calls` 按 ``index``
    拼回完整调用。v0.40 之前这里还有一条非流式产线（``complete_with_tools``），
    合并"选工具"与"作答"两次调用之后就没人用了，已删除。
    """

    text: str = ""
    tool_calls: tuple[ToolCall, ...] = ()

    reasoning: str = ""
    """模型这一轮的思考（``reasoning_content``），**要原样带回下一轮请求**。

    留它不是因为我们想显示它（显示那条走流式，见 ``LLMDelta.reasoning``），
    而是有些端点在思考模式下**强制要求**：带工具调用的助手消息若不把这个字段
    传回去，下一轮直接 400（实测记录见 ``thinking.ECHO_DIALECTS``）。
    """

    @property
    def wants_tools(self) -> bool:
        return bool(self.tool_calls)


@dataclass(frozen=True, slots=True)
class ChatMessage:
    """一条对话消息。

    ``tool_calls`` / ``tool_call_id`` 是工具循环要的两个附加位：
    助手消息可以"带着一组工具调用"（此时 ``content`` 常为空），
    而 ``role="tool"`` 的结果消息必须用 ``tool_call_id`` 指回是哪一次调用的结果
    ——**少了它，OpenAI 兼容端点会直接 400**（工具结果必须与调用配对）。

    ``reasoning`` 是第三个附加位，**只有工具循环那条路用得到**：它是"这一轮的思考"，
    要随助手消息回到下一轮请求里（见 ``LLMReply.reasoning`` 与
    ``thinking.ECHO_DIALECTS``）。``None`` 表示这条消息不该带这个字段——
    普通消息（用户、系统、工具结果）本来就没有推理，多发一个空字段只是噪声。
    """

    role: str
    content: str
    tool_calls: tuple[ToolCall, ...] = ()
    tool_call_id: str | None = None
    reasoning: str | None = None


@dataclass(frozen=True, slots=True)
class LLMConfig:
    """运行期配置快照（来自设置页）。"""

    base_url: str
    api_key: str
    model_id: str
    temperature: float = 0.3
    max_tokens: int | None = None
    """回复长度上限。**默认不传**（``None`` = 请求里不带这个字段）。

    为什么不设默认值：上限本来就是模型自己的事——不传时端点会一直生成到模型自然收尾
    或撞上它自己的上限（OpenAI 兼容协议就是这么定的，实测 DeepSeek 也是），
    我们再拍一个数字只会引入一类新故障：设小了思考就把预算吃光、正文一个字都出不来
    （2048 时实测过，而且**时好时坏**，因为思考长短随采样波动）。

    只有显式给了值才发出去：给「有些端点不传就退化成很小的默认值」留一条手动出路
    （走模型注册里的 ``options.max_tokens``），而不是把它当成默认。
    """
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
class LLMDelta:
    """流式的一块增量。

    **思考与正文分开**：推理模型把思考写在 ``reasoning_content`` 里，它与 ``content``
    是同一条流里的两个字段，可能交替出现。界面要把它们分成两个区域显示
    （思考是过程、正文是结果），所以从这一层就分开，而不是在上层再拆字符串。
    三者都为空（例如只带 ``finish_reason`` 的收尾块）时，这一块直接跳过。
    """

    text: str = ""
    reasoning: str = ""
    tool_calls: tuple[ToolCallDelta, ...] = ()
    """这一块里的工具调用碎片（见 ``ToolCallDelta``）；空元组 = 这一块不含工具调用。"""


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
                # 超时按调用点给：共享客户端自带的那个只是兜底（见 app/core/http.py）
                timeout=self._timeout,
            )
        body = self._decode(response)
        # 记下这一轮的 token 用量，供调用方取（见 ``last_usage``）。
        # 放在这里而不是让 complete 换返回值：那会改掉所有调用方的签名，
        # 而绝大多数调用方并不关心用量。
        self.last_usage = _usage_of(body)
        return _content_of(body)

    def stream(self, messages: Sequence[ChatMessage]) -> Iterator[str]:
        """流式产出**正文**增量（SSE）。

        逐块 yield，调用方可以直接转给前端做打字机效果——快速验证场景里
        "看着它写"比"等十秒然后一次出现"重要得多。

        思考增量在这里被有意丢掉；要展示思考过程（界面的"过程面板"）用 ``stream_events``。
        """
        for delta in self.stream_events(messages):
            if delta.text:
                yield delta.text

    def stream_events(
        self, messages: Sequence[ChatMessage], tools: Sequence[ToolSpec] | None = None
    ) -> Iterator[LLMDelta]:
        """流式产出增量，**正文与思考分开**（推理模型的 ``reasoning_content`` 单独成块）。

        **可以带工具表**（v0.34）：收尾那次作答也把工具发出去——走到那里不等于
        "模型已经不想用工具了"，而不带工具表时它会**把调用写进正文**
        （实测 DeepSeek Flash：同一个请求带 tools 回结构化 ``tool_calls``，
        去掉 tools 就把 ``<｜｜DSML｜｜ invoke …>`` 写进 content，见
        ``tool_loop._answer``）。带工具时这一路只负责**原样转出碎片**
        （``LLMDelta.tool_calls``），拼装与执行在工具循环那边。

        **一个字正文都没吐出来就报错**，不能静默收尾：静默的后果是上层存下一条空回答，
        用户看到"只有问题、没有回答"，却拿不到任何可处置的线索（实测过：推理模型的
        思考把预算吃光时就是这个现象，而且时好时坏）。非流式那条路一直有这道判断——
        两条路必须一个口径。

        判断的口径：**正文与工具调用都算"产出了"**——只想调工具的那一轮正文是空的，
        那不是空回答；只有思考不算。
        """
        produced = False
        finish_reason = ""
        with (
            self._open() as client,
            client.stream(
                "POST",
                f"{self.config.base_url.rstrip('/')}/chat/completions",
                headers=self._headers(),
                json={**self._payload(messages, tools), "stream": True},
                timeout=self._timeout,
            ) as response,
        ):
            if response.status_code != 200:
                response.read()
                raise ChatError(_error_hint(response))
            for line in response.iter_lines():
                chunk = _chunk_of(line)
                if chunk is None:
                    continue
                if chunk.finish_reason:
                    finish_reason = chunk.finish_reason
                if chunk.text or chunk.tool_calls:
                    produced = True
                if chunk.text or chunk.reasoning or chunk.tool_calls:
                    yield LLMDelta(
                        text=chunk.text,
                        reasoning=chunk.reasoning,
                        tool_calls=chunk.tool_calls,
                    )
        if not produced:
            raise ChatError(_empty_stream_hint(finish_reason))

    # ------------------------------------------------------------------ 内部

    def _open(self) -> httpx.Client:
        """拿一个客户端：注入的优先（测试用），否则是**进程级共享**的那个。

        两者都不在这里关闭——注入的那个属于调用方，共享的那个属于整个进程。
        以前是"没注入就每次新建、`with` 退出时关掉"，那正是每次调用都要重新握手的来源
        （见 ``app/core/http.py``）。所以返回的仍是 ``_ReusedClient`` 这层壳：
        它的 ``__exit__`` 什么都不做。
        """
        return _ReusedClient(self._client or shared_client())

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }

    def _payload(
        self,
        messages: Sequence[ChatMessage],
        tools: Sequence[ToolSpec] | None = None,
    ) -> dict:
        # 思考模式下有些端点要求把推理回传（见 thinking.ECHO_DIALECTS）：
        # **只在这次请求开着思考、且方言认这个字段时**才发——思考关着时端点不认这个
        # 要求（实测 200），而给不认识的端点多发字段是有风险的（见 thinking 模块头）。
        echo = self.config.enable_thinking and echoes_reasoning(
            self.config.base_url, self.config.model_id, self.config.thinking_dialect
        )
        payload: dict = {
            "model": self.config.model_id,
            "messages": [_message_wire(m, echo_reasoning=echo) for m in messages],
            "temperature": self.config.temperature,
        }
        # `tools` 只在给了的时候发：不带工具的调用与以前**逐字节一样**
        # （多发一个空数组会被某些端点当成"要求工具调用"而拒答）
        if tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": item.name,
                        "description": item.description,
                        "parameters": item.parameters,
                    },
                }
                for item in tools
            ]
            # auto：由模型自己决定要不要调。**不设 required**——大多数对话没有工具可调，
            # 强制调用会逼它为了"用一次工具"而瞎调一个
            payload["tool_choice"] = "auto"
        # 长度上限**没显式给就不发**：把它交给模型自己（见 ``LLMConfig.max_tokens``）。
        # 发一个我们拍的数字，只会在某些模型上把回复预算掐死在思考阶段
        if self.config.max_tokens is not None:
            payload["max_tokens"] = self.config.max_tokens
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
            "模型只返回了思考过程、没有正文：这是推理模型，思考把回复预算用完了。"
            "请在输入框把「深度思考」调低或关掉，或换一个非推理模型"
        )
    # 两者都空：**不能**返回空串。返回空串的话上层只会得到一句"没有回答"，
    # 用户看不出是模型没配好、被限流还是提示词太长——所以在这里就给出可处置的原因。
    raise ChatError(
        "模型返回了空正文：常见原因是提示词过长被截断，或该模型不支持当前请求格式。"
        "请到设置 → 对话模型里检查后重试"
    )


def _empty_stream_hint(finish_reason: str) -> str:
    """流式一个字正文都没出来时的可处置提示。

    与非流式的 ``_content_of`` 同一口径：给"下一步做什么"，不给"参数非法"。
    """
    if finish_reason == "length":
        return (
            "模型到了长度上限就停住了，正文一个字都没留下——推理模型把预算全花在思考上"
            "就是这个现象。请在输入框把「深度思考」调低或关掉，或换一个非推理模型"
        )
    return (
        "模型没有返回任何正文（可能只返回了思考内容）。请把「深度思考」调低或关掉，"
        "或换一个非推理模型再试"
    )


def _message_wire(message: ChatMessage, *, echo_reasoning: bool = False) -> dict:
    """把一条消息转成 OpenAI 兼容的线上形状。

    **只有带工具位时才多发字段**：普通消息序列化出来与以前完全一样，
    不会因为升级客户端而改变既有请求（`content` 为空的助手消息仍发空串，
    而不是省略——省略会被某些端点当成非法消息）。

    ``echo_reasoning`` 见 ``thinking.ECHO_DIALECTS``：它是**端点级别的开关**，
    不是消息自己的属性——所以由调用方按这一轮的配置算好，这里只管把字段补上。
    """
    body: dict = {"role": message.role, "content": message.content}
    if message.tool_calls:
        body["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {"name": call.name, "arguments": call.arguments},
            }
            for call in message.tool_calls
        ]
        if echo_reasoning:
            # 端点要的是"字段在"，不是"内容对"：没有推理时**也必须发空串**
            # （实测缺字段 400、空串 200；只补一部分消息同样 400）
            body["reasoning_content"] = message.reasoning or ""
    if message.tool_call_id:
        body["tool_call_id"] = message.tool_call_id
    return body


@dataclass(frozen=True, slots=True)
class _Chunk:
    """SSE 一行的解析结果（见 ``_chunk_of``）。"""

    text: str = ""
    reasoning: str = ""
    finish_reason: str = ""
    tool_calls: tuple[ToolCallDelta, ...] = ()


def _chunk_of(line: str) -> _Chunk | None:
    """从一行 SSE 里取出（正文增量，思考增量，结束原因，工具调用碎片）。

    非数据行与 ``[DONE]`` 返回 ``None``。**结束原因也要取**：它是判断
    "为什么一个字都没出来"的唯一依据（``length`` = 被长度上限截断）。
    **思考增量单独取**：推理模型把它写在 ``delta.reasoning_content``，
    界面要把它与正文分两个区域显示（见 ``LLMDelta``）。

    工具调用碎片（``delta.tool_calls``）**原样转出、不在这里拼**：每块只带一部分
    （见 ``ToolCallDelta``），拼装要有"整条流"的视野，放在 ``assemble_tool_calls``。
    """
    if not line or not line.startswith("data:"):
        return None
    payload = line[5:].strip()
    if not payload or payload == "[DONE]":
        return None
    try:
        body = json.loads(payload)
        choice = body["choices"][0]
        delta = choice.get("delta", {}) or {}
        return _Chunk(
            text=str(delta.get("content") or ""),
            reasoning=str(delta.get("reasoning_content") or ""),
            finish_reason=str(choice.get("finish_reason") or ""),
            tool_calls=_call_deltas(delta.get("tool_calls")),
        )
    except (KeyError, IndexError, TypeError, ValueError):
        return None


def _call_deltas(raw_calls: object) -> tuple[ToolCallDelta, ...]:
    """取这一块里的工具调用碎片。

    **单块坏掉不能丢整行**：正文与碎片常常同在一块里，为一段拼不起来的碎片
    把正文也丢掉，等于让回答凭空少一句。所以这里逐块容错，坏的那块跳过。
    """
    if not isinstance(raw_calls, list):
        return ()
    fragments: list[ToolCallDelta] = []
    for raw in raw_calls:
        if not isinstance(raw, dict):
            continue
        function = raw.get("function") or {}
        try:
            index = int(raw.get("index") or 0)
        except (TypeError, ValueError):
            index = 0
        fragments.append(
            ToolCallDelta(
                index=index,
                id=str(raw.get("id") or ""),
                name=str(function.get("name") or ""),
                arguments=str(function.get("arguments") or ""),
            )
        )
    return tuple(fragments)


def assemble_tool_calls(fragments: Sequence[ToolCallDelta]) -> tuple[ToolCall, ...]:
    """把流式碎片按 ``index`` 拼成完整调用（见 ``ToolCallDelta``）。

    **容错与非流式那条路同一套**（``_reply_of``）：没名字的丢掉——无法执行，
    而模型下一轮通常还会正常再调一次；缺 id 的自己编一个稳定的，好让工具结果配对。

    参数是碎片拼起来的，这里**不判断 JSON 合不合法**：那是执行那一步的事，
    拼坏了会作为"工具参数不是合法 JSON"回给模型让它自己改
    （见 ``tool_loop._parse_arguments``）。
    """
    order: list[int] = []
    grouped: dict[int, list[ToolCallDelta]] = {}
    for fragment in fragments:
        if fragment.index not in grouped:
            grouped[fragment.index] = []
            order.append(fragment.index)
        grouped[fragment.index].append(fragment)

    calls: list[ToolCall] = []
    for index in order:
        parts = grouped[index]
        call = _call_or_none(
            index=index,
            ident=next((item.id for item in parts if item.id), ""),
            name=next((item.name for item in parts if item.name.strip()), ""),
            arguments="".join(item.arguments for item in parts),
        )
        if call is not None:
            calls.append(call)
    return tuple(calls)


def _call_or_none(*, index: int, ident: str, name: str, arguments: str) -> ToolCall | None:
    """拼一次调用，**两条路（流式拼接 / 非流式直读）共用这一份容错**。

    两处各写一份必然相漂，而它们该给出的是同一个判断：没名字的调用无法执行，
    丢掉比报错好（模型偶尔会吐一个空壳，而它下一轮通常还会正常再调一次）；
    id 可能缺失（少数实现不给），自己编一个稳定的，好让工具结果能配对。
    """
    cleaned = name.strip()
    if not cleaned:
        return None
    return ToolCall(
        id=ident or f"call_{index}",
        name=cleaned,
        arguments=arguments,
    )


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
