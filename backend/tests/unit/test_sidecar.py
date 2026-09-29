"""边车（P3）的用例：**假的两端** ✓（P1 的协议正是为这个 ✓），测试里不打真网络 ✗。

两条硬要求：
1. `/turn` 能用假模型跑通一轮 ✓（回答落回 `answer` ✓）；
2. `/health` 在远端**不可达时如实报不可达** ✗（不许假装健康 ✓）。
"""

from __future__ import annotations

import os

import httpx
import pytest
from fastapi.testclient import TestClient

from app import sidecar
from app.services.llm import ChatMessage, LLMDelta
from app.services.remote_clients import RemoteUnavailableError


class _FakeModel:
    """假的模型端：只回一段文本 ✓（协议三方法之一就够这条用例 ✓）。"""

    def __init__(self, reply: str = "边车假回答") -> None:
        self.reply = reply
        self.seen: list[list[ChatMessage]] = []

    def complete(self, messages):  # type: ignore[no-untyped-def]
        return self.reply

    def stream(self, messages):  # type: ignore[no-untyped-def]
        yield self.reply

    def stream_events(self, messages, tools=None):  # type: ignore[no-untyped-def]
        self.seen.append(list(messages))
        yield LLMDelta(text=self.reply)


class _BrokenModel:
    def complete(self, messages):  # type: ignore[no-untyped-def]
        raise RemoteUnavailableError("模型代理连不上：boom")

    def stream(self, messages):  # type: ignore[no-untyped-def]
        raise RemoteUnavailableError("模型代理连不上：boom")

    def stream_events(self, messages, tools=None):  # type: ignore[no-untyped-def]
        raise RemoteUnavailableError("模型代理连不上：boom")


def _client(tmp_path, monkeypatch, model, *, health_ok: bool = True) -> TestClient:  # type: ignore[no-untyped-def]
    # 装配点整体换成假的 ✓ —— **必须在 create_app 之前打补丁** ✗：
    # `create_app` 内部就调 `build_clients` ✓，晚一步它就把真客户端装进去了 ✓
    # （那会让用例打真网络 ✗ —— 第一次就是这么假红的）。
    class _FakeClients:
        knowledge = object()
        health_url = "http://server.test/api/v1/health"

    _FakeClients.model = model  # type: ignore[attr-defined]  # 类体里取不到闭包变量 ✗，出来再挂 ✓
    monkeypatch.setattr(sidecar, "build_clients", lambda base, token: _FakeClients())
    monkeypatch.setattr(sidecar, "_probe_health", lambda url, timeout=5.0: health_ok)

    app = sidecar.create_app("http://server.test/api/v1", "t", tmp_path / "ws")
    return TestClient(app)


def test_turn_runs_a_round_with_a_fake_model(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    model = _FakeModel("你好，这是边车回答")
    client = _client(tmp_path, monkeypatch, model)

    response = client.post("/turn", json={"message": "在吗"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["answer"] == "你好，这是边车回答"
    # 消息真的送到了模型那一端 ✓（内容与角色 ✓）
    assert model.seen and model.seen[0][0].content == "在吗"
    # **为 SSE 留位** ✓：结构里有两个字段（本轮恒为空 / false ✓）
    assert payload["steps"] == []
    assert payload["sse"] is False


def test_turn_reports_a_remote_failure_instead_of_pretending(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """远端不可用要**如实说** ✗（不是"空回答" ✓ —— 失败分档那条）。"""
    client = _client(tmp_path, monkeypatch, _BrokenModel())

    payload = client.post("/turn", json={"message": "在吗"}).json()

    assert "边车报告" in payload["answer"]
    assert "连不上" in payload["answer"]


def test_health_reports_unreachable_when_the_server_is_down(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    client = _client(tmp_path, monkeypatch, _FakeModel(), health_ok=False)

    payload = client.get("/health").json()

    assert payload["kb_reachable"] is False
    assert payload["model_reachable"] is False
    assert "不可达" in payload["note"]


def test_health_is_honest_when_everything_is_up(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    client = _client(tmp_path, monkeypatch, _FakeModel(), health_ok=True)

    payload = client.get("/health").json()

    assert payload["kb_reachable"] is True
    assert payload["note"] == ""
    assert payload["version"] == sidecar.SIDECAR_VERSION


def test_workspace_refuses_system_directories() -> None:
    """**绝不写系统目录** ✗（宁可报错，也不在 `C:\\Windows` / `/etc` 下面跑工具 ✓）。

    平台各挑各的：Windows 上 `E:\\etc` 只是盘符下的相对路径 ✗（不是 POSIX 的 `/etc` ✓），
    拿它当"系统目录"断言会假红 ✗。
    """
    bad = ["C:/Windows"] if os.name == "nt" else ["/etc", "/usr/lib"]
    for path in bad:
        with pytest.raises(ValueError) as excinfo:
            sidecar._check_workspace(path)
        assert "系统目录" in str(excinfo.value)


def test_workspace_defaults_under_the_user_home(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(sidecar, "DEFAULT_WORKSPACE", tmp_path / "home" / ".kylab" / "workspace")

    resolved = sidecar.default_workspace()

    assert resolved == tmp_path / "home" / ".kylab" / "workspace"
    assert resolved.is_dir()


def test_knowledge_client_is_the_remote_one(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """装配出来的 KB 端**就是 P2 的远端实现** ✓（边车的"循环本地、KB 远端"落在这一行 ✓）。"""
    clients = sidecar.build_clients("http://server.test/api/v1", "t")

    assert isinstance(clients.knowledge, sidecar.RemoteKnowledgeClient)
    assert isinstance(clients.model, sidecar.RemoteModelClient)
    assert clients.base_url == "http://server.test/api/v1"
    # 探活打的是后端自己的 health（不花模型额度 ✓）
    assert clients.health_url == "http://server.test/api/v1/health"


def test_probe_health_is_false_on_network_error() -> None:
    """探活失败一律当"不可达" ✓（用例里用假传输，不打真网络 ✗）。"""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope")

    transport = httpx.MockTransport(handler)
    original = httpx.get

    httpx.get = lambda url, **kwargs: httpx.Client(transport=transport).get(url, **kwargs)  # type: ignore[assignment]
    try:
        assert sidecar._probe_health("http://server.test/api/v1/health") is False
    finally:
        httpx.get = original  # type: ignore[assignment]
