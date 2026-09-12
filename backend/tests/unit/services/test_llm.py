"""对话客户端（``app/services/llm.py``）：请求载荷里思考字段的方言。

HTTP 用 ``httpx.MockTransport`` 拦掉——要验的是"发出去的那个 JSON 长什么样"，
真打网络既慢又不稳定。方言翻译本身在 ``test_thinking.py`` 里测，这里只确认
``_payload`` 确实把它接了进来、并且没有别的字段把开关覆盖回去。
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.services.llm import ChatError, ChatMessage, LLMConfig, OpenAICompatChat

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
