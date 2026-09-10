"""云端解析器的可靠性边界（不打网络：注入假的 httpx 客户端）。

镜像同构：``app/parsers/mineru_cloud.py`` → ``tests/unit/parsers/test_mineru_cloud.py``。

这份用例盯的是**巡检报告点出的那个缺口**：两个云端解析器的轮询都是
``while True`` + ``sleep``，云端任务若永远停在 running，摄入线程就永久阻塞——
心跳继续续租，任务永远占着队列，worker 看起来活着却再也消费不了别的任务。
``ParseError`` 的抛出路径因此必须被钉住。

构造函数已预留 ``client=`` 与 ``poll_interval=``，所以这里不需要网络、也不需要真的等待。
"""

from __future__ import annotations

import pytest

from app.parsers.base import ParseError
from app.parsers.mineru_cloud import POLL_DEADLINE_SECONDS, MinerUCloudParser, MinerUConfig

RUNNING = {"code": 0, "data": {"extract_result": [{"state": "running"}]}}
DONE = {
    "code": 0,
    "data": {"extract_result": [{"state": "done", "full_zip_url": "https://example.test/z.zip"}]},
}


class _Response:
    def __init__(self, payload, status_code: int = 200, content: bytes = b"") -> None:
        self._payload = payload
        self.status_code = status_code
        self.content = content
        self.text = ""

    def json(self):  # type: ignore[no-untyped-def]
        return self._payload


class _FakeClient:
    """按 URL 分派响应：查询接口回 ``payload``，结果包地址回 zip 内容。"""

    def __init__(self, payload) -> None:  # type: ignore[no-untyped-def]
        self._payload = payload
        self.calls = 0

    def get(self, url: str, **kwargs):  # type: ignore[no-untyped-def]
        self.calls += 1
        if url.endswith("z.zip"):
            return _Response({}, content=b"zip-bytes")
        return _Response(self._payload)


def _parser(client: _FakeClient) -> MinerUCloudParser:
    # poll_interval=0 让循环全速跑；安全性完全由 deadline 兜住
    return MinerUCloudParser(MinerUConfig(token="sk-test"), client=client, poll_interval=0)


def _advancing_clock(step: float):  # type: ignore[no-untyped-def]
    """假时钟：每被问一次就前进 ``step`` 秒。"""
    clock = {"now": 0.0}

    def monotonic() -> float:
        clock["now"] += step
        return clock["now"]

    return monotonic


def test_mineru_polling_gives_up_after_the_deadline(monkeypatch) -> None:
    """云端永远 running 时必须抛 ParseError，而不是无限等下去。"""
    client = _FakeClient(RUNNING)
    monkeypatch.setattr(
        "app.parsers.mineru_cloud.time.monotonic",
        _advancing_clock(POLL_DEADLINE_SECONDS / 4),  # 问四次就超时
    )

    with pytest.raises(ParseError) as excinfo:
        _parser(client)._poll_zip(client, "batch-1")  # type: ignore[arg-type]

    assert "放弃等待" in str(excinfo.value)
    # 确实轮询过（不是一上来就报错），而且有界
    assert client.calls >= 1
    assert client.calls < 100


def test_mineru_polling_returns_normally_when_done(monkeypatch) -> None:
    """正常完成不受上限影响——上限只挡"永远不结束"，不挡慢。"""
    client = _FakeClient(DONE)
    monkeypatch.setattr("app.parsers.mineru_cloud.time.monotonic", _advancing_clock(1.0))

    assert _parser(client)._poll_zip(client, "batch-2") == b"zip-bytes"  # type: ignore[arg-type]
