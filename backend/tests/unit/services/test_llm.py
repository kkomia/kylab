"""对话客户端（``app/services/llm.py``）：请求载荷里思考字段的方言。

HTTP 用 ``httpx.MockTransport`` 拦掉——要验的是"发出去的那个 JSON 长什么样"，
真打网络既慢又不稳定。方言翻译本身在 ``test_thinking.py`` 里测，这里只确认
``_payload`` 确实把它接了进来、并且没有别的字段把开关覆盖回去。
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.services.llm import (
    ChatError,
    ChatMessage,
    LLMConfig,
    OpenAICompatChat,
    ToolCall,
    ToolSpec,
)

_MESSAGES = [ChatMessage(role="user", content="你好")]


def _capture(config: LLMConfig) -> dict:
    """跑一次 complete，返回实际发出去的请求体。"""
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"role": "assistant", "content": "好"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    OpenAICompatChat(config, client=client).complete(_MESSAGES)
    return captured


def _config(**overrides) -> LLMConfig:  # type: ignore[no-untyped-def]
    base = {
        "base_url": "https://api.deepseek.com",
        "api_key": "sk-test",
        "model_id": "deepseek-flash",
    }
    base.update(overrides)
    return LLMConfig(**base)


def test_deepseek_payload_carries_thinking_and_effort() -> None:
    body = _capture(_config(enable_thinking=True, thinking_effort="high"))
    assert body["thinking"] == {"type": "enabled"}
    assert body["reasoning_effort"] == "high"
    # 采样参数照旧
    assert body["model"] == "deepseek-flash"
    assert body["stream"] is False


def test_deepseek_disable_sends_disabled() -> None:
    body = _capture(_config(enable_thinking=False))
    assert body["thinking"] == {"type": "disabled"}
    assert "reasoning_effort" not in body


def test_dialect_override_is_honoured() -> None:
    """注册模型写了 thinking_dialect 时，按它走而不是按地址猜。"""
    body = _capture(
        _config(
            base_url="https://api.deepseek.com",
            enable_thinking=True,
            thinking_effort="low",
            thinking_dialect="qwen",
        )
    )
    assert body["enable_thinking"] is True
    assert body["thinking_budget"] == 1024
    assert "thinking" not in body


def test_content_error_mentions_budget_and_strength() -> None:
    """只回思考不回正文时，错误文案要给出**可处置**的两条路。"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"role": "assistant", "content": "", "reasoning_content": "想…"}}
                ]
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        OpenAICompatChat(_config(), client=client).complete(_MESSAGES)
    except Exception as exc:
        text = str(exc)
        # 可处置的两条路：调低/关掉思考，或换个非推理模型。
        # **不再提「最大回复长度」**——那个设置项已经去掉了（不再替模型决定长度）
        assert "思考" in text
        assert "非推理模型" in text
    else:  # pragma: no cover - 走到这里说明行为变了
        raise AssertionError("空正文应当抛错")


# ------------------------------------------------- 长度上限与"一个字都没出来"


def _stream_client(chunks: list[dict], status: int = 200) -> httpx.Client:
    """把若干 SSE 行按顺序吐出来，模拟端点的流式响应。"""

    def handler(request: httpx.Request) -> httpx.Response:
        # 用 chr(10) 拼换行：SSE 的空行是"事件结束"的标记，这里要的是真的换行符
        nl = chr(10)
        body = "".join(f"data: {json.dumps(c)}{nl}{nl}" for c in chunks)
        body += f"data: [DONE]{nl}{nl}"
        return httpx.Response(status, content=body.encode("utf-8"))

    return httpx.Client(transport=httpx.MockTransport(handler))


def _delta(text: str, finish: str | None = None) -> dict:
    return {"choices": [{"delta": {"content": text}, "finish_reason": finish}]}


# ------------------------------------------------- 出站客户端（共享，见 core/http.py）


def test_no_client_is_built_per_call(monkeypatch: pytest.MonkeyPatch) -> None:
    """不注入 client 时走**进程级共享**的那个。

    以前这里是 `httpx.Client(timeout=...)`，用完即关——一轮默认的 Agent 对话要发出
    十几次模型调用，那就是十几次 TCP + TLS 握手（内网 5–20ms、公网 100–300ms，
    全是白花的固定开销）。

    判据是硬的：把 `httpx.Client` 换成"一构造就炸"的替身，
    被测代码只要自己新建，这条用例立刻红。
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"role": "assistant", "content": "好"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    fake = httpx.Client(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.services.llm.shared_client", lambda: fake)

    def explode(*args: object, **kwargs: object) -> None:
        raise AssertionError("不该每次调用都新建 httpx.Client（见 app/core/http.py）")

    monkeypatch.setattr(httpx, "Client", explode)

    # 不注入 client：走共享那条路
    assert OpenAICompatChat(_config()).complete(_MESSAGES) == "好"


def test_payload_omits_max_tokens_unless_explicitly_set() -> None:
    """**默认不发长度上限**：上限是模型自己的事。

    我们拍过的那个 2048 会把回复预算掐死在思考阶段，正文一个字都出不来
    （实测，而且时好时坏）。不传时端点会生成到模型自然收尾。
    """
    captured = _capture(_config())
    assert "max_tokens" not in captured
    # 但显式给了就得发——有些端点"不传就退化成很小的默认值"（走模型注册的 options）
    assert _capture(_config(max_tokens=4096))["max_tokens"] == 4096


def test_stream_passes_through_content_deltas() -> None:
    client = _stream_client([_delta("你"), _delta("好"), _delta("", "stop")])
    chunks = list(OpenAICompatChat(_config(), client=client).stream(_MESSAGES))
    assert chunks == ["你", "好"]


def test_stream_raises_when_not_a_single_character_came_back() -> None:
    """**一个字正文都没出来就报错**，不能静默收尾。

    静默的后果是上层存下一条空回答，用户看到"只有问题、没有回答"，却没有任何
    可处置的线索——非流式那条路一直有这道判断，两条路必须一个口径。
    推理模型把预算全花在思考上时正是这个现象（只吐 reasoning_content）。
    """
    reasoning_only = {
        "choices": [{"delta": {"reasoning_content": "想了很久……"}, "finish_reason": "length"}]
    }
    client = _stream_client([reasoning_only])
    chat = OpenAICompatChat(_config(), client=client)

    with pytest.raises(ChatError) as caught:
        list(chat.stream(_MESSAGES))

    message = str(caught.value)
    assert "长度上限" in message
    # 给的是"下一步做什么"，不是"参数非法"
    assert "深度思考" in message


def test_stream_raises_without_length_reason_too() -> None:
    """结束原因是 stop 但同样一个字都没有：也要报错，只是措辞不同。"""
    client = _stream_client([_delta("", "stop")])
    with pytest.raises(ChatError) as caught:
        list(OpenAICompatChat(_config(), client=client).stream(_MESSAGES))
    assert "没有返回任何正文" in str(caught.value)


# ------------------------------------------------- 思考的回传（v0.27 实测的 400）


_TOOL_SPEC = ToolSpec(name="search", description="查", parameters={"type": "object"})

_TOOL_MESSAGES = [
    ChatMessage(role="user", content="查一下"),
    ChatMessage(
        role="assistant",
        content="",
        tool_calls=(ToolCall(id="c1", name="search", arguments="{}"),),
        reasoning="先想清楚要查什么。",
    ),
    ChatMessage(role="tool", content="结果", tool_call_id="c1"),
]


def _capture_tools(config: LLMConfig, messages=None):  # type: ignore[no-untyped-def]
    """跑一次 complete_with_tools，返回（实际发出去的请求体, 解析出来的回复）。"""
    captured: dict = {}
    body = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "端点的思考",
                    "tool_calls": [
                        {
                            "id": "c1",
                            "type": "function",
                            "function": {"name": "search", "arguments": "{}"},
                        }
                    ],
                }
            }
        ]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, json=body)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    reply = OpenAICompatChat(config, client=client).complete_with_tools(
        messages or _TOOL_MESSAGES, [_TOOL_SPEC]
    )
    return captured, reply


def test_deepseek_thinking_echoes_the_reasoning_back() -> None:
    """思考模式下，带工具调用的助手消息**必须把推理传回去**。

    实测（2026-09-19，api.deepseek.com / deepseek-flash）：缺 ``reasoning_content``
    这个字段整条请求 400（"must be passed back to the API"），补空串就 200。
    这条链路在**工具循环**上：一次工具调用就多一轮请求，而每一轮都要把上一轮的
    助手消息发出去——不补这个字段的话，用户看到的是"工具都调完了、然后对话失败"。
    """
    captured, _ = _capture_tools(_config(enable_thinking=True))

    assistant = captured["messages"][1]
    assert assistant["reasoning_content"] == "先想清楚要查什么。"
    # 字段只加在带工具调用的助手消息上：系统 / 用户 / 工具结果都没有推理
    assert "reasoning_content" not in captured["messages"][0]
    assert "reasoning_content" not in captured["messages"][2]


def test_an_empty_reasoning_is_still_sent() -> None:
    """没有推理时**也要发这个字段**（空串合法）。

    端点要的是"字段在"：**每一个**带工具调用的助手消息都得有，
    只补前几条、漏掉最后一条同样 400（实测）。而"带着工具调用却没有推理"的消息
    是会出现的——模型某一轮就是没给 ``reasoning_content``，或者这条消息是从
    别处拼进来的；补一个空串的成本是零，漏掉的成本是整轮对话失败。
    """
    messages = [
        _TOOL_MESSAGES[0],
        ChatMessage(
            role="assistant",
            content="",
            tool_calls=(ToolCall(id="c1", name="search", arguments="{}"),),
        ),
        _TOOL_MESSAGES[2],
    ]

    captured, _ = _capture_tools(_config(enable_thinking=True), messages)

    assert captured["messages"][1]["reasoning_content"] == ""


def test_no_reasoning_field_when_thinking_is_off_or_the_dialect_differs() -> None:
    """**只对认这个字段的方言发**：思考关着时不需要，别的供应商也没有证据要它。

    给不认识的端点多发一个字段是有代价的（可能被严格网关打成 400），
    而这条要求只有 DeepSeek 实测过（见 thinking.ECHO_DIALECTS）。
    """
    off, _ = _capture_tools(_config(enable_thinking=False))
    assert "reasoning_content" not in off["messages"][1]

    other, _ = _capture_tools(
        _config(base_url="https://api.siliconflow.cn/v1", model_id="Qwen/Qwen3.5-4B")
    )
    assert "reasoning_content" not in other["messages"][1]


def test_the_reply_carries_the_reasoning_for_the_next_round() -> None:
    """解析侧：``reasoning_content`` 要留在 ``LLMReply`` 上，工具循环才带得回去。

    丢了它不会当场报错——错在下一轮请求上，而那时离起因已经很远了。
    """
    _, reply = _capture_tools(_config(enable_thinking=True))

    assert reply.reasoning == "端点的思考"
    assert reply.wants_tools
