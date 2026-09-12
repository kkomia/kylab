"""对话客户端（``app/services/llm.py``）：请求载荷里思考字段的方言。

HTTP 用 ``httpx.MockTransport`` 拦掉——要验的是"发出去的那个 JSON 长什么样"，
真打网络既慢又不稳定。方言翻译本身在 ``test_thinking.py`` 里测，这里只确认
``_payload`` 确实把它接了进来、并且没有别的字段把开关覆盖回去。
"""

from __future__ import annotations

import json

import httpx

from app.services.llm import ChatMessage, LLMConfig, OpenAICompatChat

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
        assert "最大回复长度" in text
        assert "思考" in text
    else:  # pragma: no cover - 走到这里说明行为变了
        raise AssertionError("空正文应当抛错")
