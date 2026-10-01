"""边车（P3）的用例：**假的两端** ✓（P1 的协议正是为这个 ✓），测试里不打真网络 ✗。

三条硬要求：
1. `/turn` 能用假模型跑通一轮 ✓（回答落回 `answer` ✓）；
2. **工具真的在本机执行** ✓：模型要求调工具 → 本地跑 → 结果回灌 → 再作答 ✓（完整链路 ✓）；
3. `/health` 在远端**不可达时如实报不可达** ✗（不许假装健康 ✓）。

**M2 阶段 3 起整份用例标 `local`**：边车现在跑的是**本机档**（会话 / 产物 / 笔记 /
记忆全落本机 SQLite 与本机文件系统，见 `app/sidecar.py` 模块头那张表），所以它
**只依赖本机 SQLite 与文件系统** ✓ —— 那正是 `local` 这个 marker 的定义。
不标的话，没有 PG 的机器上整份文件会被 `conftest.py` 静默跳过，而"断 NAS 也跑得起来"
恰恰是这一步要证明的事 ✗。
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import sidecar
from app.services import remote_clients
from app.services.approvals import ALLOW_ONCE, DENY, UNAVAILABLE, ApprovalRegistry, ApprovalRequest
from app.services.chat import ChatService
from app.services.knowledge_client import KnowledgeClient
from app.services.knowledge_provider import (
    SETTING_ENABLED,
    STATE_READY,
    STATE_UNAVAILABLE,
    STATE_UNCONFIGURED,
    KnowledgeProviderClient,
)
from app.services.llm import ChatMessage, LLMDelta, ToolCallDelta, ToolSpec
from app.services.remote_clients import RemoteUnavailableError
from app.services.tool_loop import ToolLoop, ToolOutcome

pytestmark = pytest.mark.local

#: 边车钉档会改的环境变量，由 `conftest.py` 的兜底夹具登记好（用例之间不会互相污染）；
#: 这一份只是给读者一个索引，别在这里再 `monkeypatch.setenv` 一遍。
_PINNED_ENV = ("KYLAB_DEPLOYMENT", "KYLAB_DATABASE_URL", "KYLAB_DATA_DIR", "KYLAB_SERVER_URL")


class _FakeModel:
    """假的模型端：只回一段文本 ✓（协议三方法之一就够这条用例 ✓）。"""

    def __init__(self, reply: str = "边车假回答") -> None:
        self.reply = reply
        self.seen: list[list[ChatMessage]] = []
        self.tools_seen: list[list[Any]] = []

    def complete(self, messages):  # type: ignore[no-untyped-def]
        return self.reply

    def stream(self, messages):  # type: ignore[no-untyped-def]
        yield self.reply

    def stream_events(self, messages, tools=None):  # type: ignore[no-untyped-def]
        self.seen.append(list(messages))
        self.tools_seen.append(list(tools or []))
        yield LLMDelta(text=self.reply)


class _ToolCallingModel:
    """**先要工具、再作答**的假模型 ✓：与真模型同形（`LLMDelta.tool_calls` ✓）。

    第一轮回一次工具调用（碎片形式 ✓，与流式那条路一致 ✓），第二轮回正文。
    这样"模型要求调工具 → 本地执行 → 结果回灌 → 出答案"整条链在用例里跑得到 ✓。
    """

    def __init__(self, tool: str, arguments: str, reply: str) -> None:
        self.tool = tool
        self.arguments = arguments
        self.reply = reply
        self.rounds: list[list[ChatMessage]] = []
        self.called = False

    def complete(self, messages):  # type: ignore[no-untyped-def]
        return self.reply

    def stream(self, messages):  # type: ignore[no-untyped-def]
        yield self.reply

    def stream_events(self, messages, tools=None):  # type: ignore[no-untyped-def]
        self.rounds.append(list(messages))
        if not self.called:
            self.called = True
            yield LLMDelta(
                tool_calls=(
                    ToolCallDelta(index=0, id="call_1", name=self.tool, arguments=self.arguments),
                )
            )
            return
        yield LLMDelta(text=self.reply)


class _ThinkingOnlyModel:
    """**只流思考、不给正文**的假模型（2026-09-29 烟测现场那条真形态 ✓）。

    真机证据：`[DIAG] 事件序列 [ThinkingEvent ×33, DoneEvent]；answer=''；steps=0` ✗ ——
    推理模型把话都说在 reasoning 通道里，而旧代码把它判成 `answered` ✓ 于是回了
    `answer:""` + `steps:[]` + HTTP 200 ✓ = **空成功** ✗✗。

    假端喂的是**客户端那一层的形状**（`LLMDelta(reasoning=…)` ✓，与
    `RemoteModelClient` 解析出来的东西同形 ✓）——那个 `ThinkingEvent` 是**循环自己发的**
    （照"假两端"的老实做法：喂进来的东西必须与真客户端同形 ✓，否则测的是不存在的分支 ✗）。
    """

    def complete(self, messages):  # type: ignore[no-untyped-def]
        return ""

    def stream(self, messages):  # type: ignore[no-untyped-def]
        return iter(())

    def stream_events(self, messages, tools=None):  # type: ignore[no-untyped-def]
        yield LLMDelta(reasoning="先看看")
        yield LLMDelta(reasoning="再想想")


class _BrokenModel:
    def complete(self, messages):  # type: ignore[no-untyped-def]
        raise RemoteUnavailableError("模型代理连不上：boom")

    def stream(self, messages):  # type: ignore[no-untyped-def]
        raise RemoteUnavailableError("模型代理连不上：boom")

    def stream_events(self, messages, tools=None):  # type: ignore[no-untyped-def]
        raise RemoteUnavailableError("模型代理连不上：boom")


def _client(  # type: ignore[no-untyped-def]
    tmp_path, monkeypatch, model, *, health_ok: bool = True, provider_factory=None
) -> TestClient:
    # 装配点整体换成"真 Clients + 假模型/假 KB" ✓ —— **必须在 create_app 之前打补丁** ✗：
    # `create_app` 内部就调 `build_clients` ✓，晚一步它就把真客户端装进去了 ✓
    # （那会让用例打真网络 ✗ —— 第一次就是这么假红的）。
    #
    # 注意：这里**不再**替换整个装配点 ✗ —— 本地那一侧（本机档的服务图 / runtime /
    # 审批 / 工具表 / `build_runner`）要**真的**建起来 ✓，否则"工具真的执行"与
    # "这一轮落本机库"两条都验不到 ✓。只有模型那一头是假的（不然就打真网络了）。
    #
    # `provider_factory` 是给"选了库"的用例备的（M3 阶段 2：工具表按提供者状态门控）✓：
    # 它**在 `_build` 里现建** —— 那时 `create_app` 已经把档位钉好了，提供者读到的
    # 引导级配置才是这一档的（在用例体里先建会读到上一条用例的 Settings ✗）。
    def _build(base: str, token: str, *, workspace: Path, data_dir: Path):  # type: ignore[no-untyped-def]
        return sidecar.Clients(
            base,
            token,
            workspace=workspace,
            data_dir=data_dir,
            model=model,
            provider=provider_factory() if provider_factory is not None else None,
        )

    monkeypatch.setattr(sidecar, "build_clients", _build)
    # `_probe_health` 现在回 `(可达?, 说明)` ✓ —— 说明要**如实带出来** ✗（别吞成一句"不可达" ✗）
    monkeypatch.setattr(
        sidecar,
        "_probe_health",
        lambda url, timeout=5.0: (
            health_ok,
            "" if health_ok else "网络不可达：ConnectError（测试）",
        ),
    )

    app = sidecar.create_app("http://server.test/api/v1", "t", tmp_path / "ws")
    return TestClient(app)


def _no_network(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """这一轮的用例**一次网络都不许发**：把 `_httpx()` 换成会炸的那个 ✓。

    M2 阶段 3 的判据之一就是这个 —— "写回服务器那一半删掉了"：把传输换掉之后再跑一轮，
    整轮照旧成功，就说明**没有任何一步在出网**（会话、产物、笔记、记忆现在都在本机）✓。
    """

    def _boom():  # type: ignore[no-untyped-def]
        raise AssertionError("这个用例不该发任何 HTTP 请求（本机档的账全在本机）")

    monkeypatch.setattr(sidecar, "_httpx", _boom)


def _handshake_body() -> dict[str, Any]:
    """一个**过得去**的握手响应（字段照方案 §1.2 的契约，能力集这里不必填满）。

    只给用例用：`Clients.tool_specs` 在"这一轮选了库"时要问一次提供者状态
    （M3 阶段 2 的门控），而状态只认**真的握手过一遍**。
    """
    return {
        "provider": "knowledge",
        "protocol_version": 1,
        "app_version": "0.1.1",
        "api_version": "v1",
        "capabilities": {},
        "caller": {
            "kind": "api_key",
            "permission": "readwrite",
            "is_admin": False,
            "can_write": True,
            "knowledge_base_ids": [],
        },
        "knowledge_bases": [],
        "server_time": "2026-10-03T00:00:00Z",
    }


def _ready_provider(handler=None):  # type: ignore[no-untyped-def]
    """一个**握手成功**的提供者客户端（假传输 —— 用例里不打真网络 ✓）。

    为什么"选了库"的用例必须显式给一个：`Clients.tool_specs` 会在那个分支上问一次
    提供者状态，`state != ready` 时 `search` / `attach_note_to_kb` / `ingest_file`
    **一个都不摆**（方案 §3.2 的失败降级）。要验"这三个真的能用"，就得先让它 ready ✓。

    ``handler`` 收下**非握手**的请求（例如上传那份 multipart）；不给就说明这个用例
    只打算喂握手，别的请求一律报错（静默放过会让"多打了一个请求"看不出来 ✗）。
    """

    def _dispatch(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/provider/handshake"):
            return httpx.Response(200, json=_handshake_body())
        if handler is not None:
            return handler(request)
        raise AssertionError(f"这个用例没准备这个请求：{request.method} {request.url}")

    return KnowledgeProviderClient(transport=httpx.MockTransport(_dispatch))


def _dead_provider():  # type: ignore[no-untyped-def]
    """一个**连不上**的提供者（假传输：所有请求都以 `ConnectError` 收场）✓。"""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("NAS 连不上（这个用例要的就是这个）")

    return KnowledgeProviderClient(transport=httpx.MockTransport(handler))


def _disabled_provider():  # type: ignore[no-untyped-def]
    """提供者被**显式关掉**（`provider.knowledge.enabled=0`）→ `unconfigured` ✓。"""
    return KnowledgeProviderClient(get_setting=lambda key: "0" if key == SETTING_ENABLED else "")


def _clients_with(tmp_path, provider_factory=None):  # type: ignore[no-untyped-def]
    """一条**真的**本机档 `Clients`：先钉档位，再建提供者（与 `build_clients` 同一个顺序 ✓）。

    提供者在**钉档之后**现建很重要：它读的是引导级配置（`get_settings()`），
    早一步建就会拿到上一条用例留下的那份（`--server` 还没钉上）。
    """
    data_dir = tmp_path / "data"
    sidecar.pin_local_deployment(data_dir, server_url="http://server.test/api/v1", token="t")
    return sidecar.Clients(
        "http://server.test/api/v1",
        "t",
        workspace=tmp_path / "ws",
        data_dir=data_dir,
        provider=provider_factory() if provider_factory is not None else None,
    )


def _new_conversation(client: TestClient, **body: Any) -> str:
    """本机后端建一条会话（**不带凭据**：本机档走"本机主人"短路 ✓）。"""
    response = client.post("/api/v1/conversations", json=body)
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def _messages(client: TestClient, conversation_id: str) -> list[dict[str, Any]]:
    """回读这条会话的消息（本机库里的那一份）。"""
    response = client.get(f"/api/v1/conversations/{conversation_id}")
    assert response.status_code == 200, response.text
    return list(response.json()["messages"])


def test_turn_runs_a_round_with_a_fake_model(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    model = _FakeModel("你好，这是边车回答")
    client = _client(tmp_path, monkeypatch, model)

    response = client.post("/turn", json={"message": "在吗"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["answer"] == "你好，这是边车回答"
    # 消息真的送到了模型那一端 ✓（内容与角色 ✓）。
    # `[-1]` 而不是 `[0]`：现在前面还有一条 `system`（`SIDECAR_SYSTEM_PROMPT` ✓ ——
    # 那条是"直接动手、别只宣布意图" ✓），用户那条**在最后** ✓。
    assert model.seen and model.seen[0][-1].role == "user"
    assert model.seen[0][-1].content == "在吗"
    # **工具表也真的发过去了** ✓（不是"只走模型"✗）：至少带上本机能服务的那些 ✓
    assert model.tools_seen and {spec.name for spec in model.tools_seen[0]} >= {
        "read_file",
        "list_files",
        "run_command",
    }
    # 步骤现在来自 `ToolLoop` ✓（组织回答那一步 ✓）——不再是"恒为空"✗
    assert any(step["phase"] == "answer" for step in payload["steps"])
    # **如实说明**：本机没有技能目录 ✓
    assert any("技能目录" in note for note in payload["notes"])
    assert payload["sse"] is False


def test_a_thinking_only_turn_is_a_reported_failure_not_an_empty_success(  # type: ignore[no-untyped-def]
    tmp_path, monkeypatch
) -> None:
    """**空答案绝不算作答** ✗✗（2026-09-29 烟测现场那条真形态）。

    真机证据：`[DIAG] 事件序列 [ThinkingEvent ×33, DoneEvent]；answer=''；steps=0` ✓ ——
    推理模型把话都说在**思考通道**里、正文一个字没有 ✓，而旧代码把它判成
    `answered`（"模型自己判断做完了"）✓ → HTTP 200 + `answer:""` + `steps:[]` ✗
    = **调用方以为成功、用户拿到空白** ✗✗。

    这条同时补上假端的盲区：**假模型必须按真实事件顺序吐 `ThinkingEvent`** ✓
    （真链路第一条事件就是它 ✓；不覆盖就永远照不到这条分支 ✓ —— 上一版正是这样漏掉了
    一个 `NameError` ✗）。
    """
    client = _client(tmp_path, monkeypatch, _ThinkingOnlyModel())

    payload = client.post("/turn", json={"message": "跑一条命令"}).json()

    assert payload["answer"].strip(), "不许回空答案（那是最危险的形态）"
    assert "思考" in payload["answer"] or "没有返回" in payload["answer"]
    assert payload["error"], "要有一个可判定的失败标记（调用方据此区分成功与空）"


def test_turn_really_runs_a_tool_in_the_local_workspace(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**完整链路** ✓：模型要调工具 → 本地工作区真的读到 → 结果回灌 → 再作答 ✓。

    用 `read_file` 而不是 `run_command`：这台机器上没有内核级隔离，而
    `require_isolation` 默认是 true ✓ —— 命令会被**如实拒绝** ✓（那条另有专测 ✓），
    而"工具真的在本机执行"这件事用文件工具验最干净 ✓（不依赖隔离后端 ✓）。
    """
    workspace = tmp_path / "ws"
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "hello.txt").write_text("边车本地文件的内容", encoding="utf-8")
    model = _ToolCallingModel(
        "read_file",
        '{"where": "workspace", "path": "hello.txt"}',
        "读到了：边车本地文件的内容",
    )
    client = _client(tmp_path, monkeypatch, model)

    payload = client.post("/turn", json={"message": "读一下工作区里的 hello.txt"}).json()

    # 1) 工具步骤真的出现在 `steps` 里 ✓（名字是稳定标识 ✓，不是给人看的中文 ✓）。
    #    每一步有**两行**（`running` 起头、`done` 收尾 ✓）——结果在收尾那一行 ✓。
    tool_steps = [
        step
        for step in payload["steps"]
        if step["tool"] == "read_file" and step["status"] == "done"
    ]
    assert tool_steps, payload["steps"]
    assert tool_steps[0]["outcome"] == ""
    # 2) 工具**真的读到了本机文件** ✓（结果在步骤里，也回灌给了模型 ✓）
    assert "边车本地文件的内容" in tool_steps[0]["result"]
    # 3) 结果回灌模型 → 第二次调用的消息里带着工具结果 ✓
    assert len(model.rounds) == 2
    fed_back = "\n".join(message.content for message in model.rounds[1])
    assert "边车本地文件的内容" in fed_back
    # 4) 最终回答来自模型（收尾那条 `DoneEvent` ✓）
    assert payload["answer"] == "读到了：边车本地文件的内容"


def test_run_command_is_refused_without_isolation_instead_of_pretending(
    tmp_path, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    """**闸不许绕** ✗：本地不许跑命令时，`run_command` 如实拒绝 ✓（不是"跑了但没输出"✗）。

    两种机器、两条诚实路径，都是 `blocked` ✓：

    - **这台机器**（没有 Docker/bwrap ✓）：`require_isolation` 默认 `"true"` ✓ → 隔离闸拒绝 ✓；
    - **装了 Docker 的机器**：走到"问一句"那一档 ✓，而边车还没有确认入口 ✗ → 超时按"没批准"✓。

    这条同时钉住"边车没有偷偷把严格档关掉"✓ —— 断言里说明了理由来自哪一道闸 ✓。
    """
    model = _ToolCallingModel("run_command", '{"command": "echo 你好"}', "命令没能跑")
    client = _client(tmp_path, monkeypatch, model)

    payload = client.post("/turn", json={"message": "跑一条命令"}).json()

    tool_steps = [
        step
        for step in payload["steps"]
        if step["tool"] == "run_command" and step["status"] == "done"
    ]
    assert tool_steps, payload["steps"]
    assert tool_steps[0]["outcome"] == "blocked"
    assert any(word in tool_steps[0]["result"] for word in ("隔离", "许可", "确认"))


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
    # `default_workspace` 现在会**跳过仓库根之下**的落点 ✗；pytest 的 tmp_path 就在仓库里 ✓，
    # 所以这条用例要把那道判断关掉（它另有专测 ✓），否则它会一直回退到别处 ✗
    monkeypatch.setattr(sidecar, "_inside_repo", lambda path: False)

    resolved = sidecar.default_workspace()

    assert resolved == tmp_path / "home" / ".kylab" / "workspace"
    assert resolved.is_dir()


def test_workspace_fallbacks_never_land_inside_the_repo(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**任何回退落点都不得在仓库根之下** ✗（烟测现场：TEMP 被指到 `backend/` ✗）。

    判据直接打在守卫上 ✓：把"是不是在仓库里"一律判真 ✗ → 每个候选都被跳过 ✓ →
    应当**如实抛错**（而不是硬在某处建目录 ✓）。这样不必依赖 pytest 的临时目录
    到底在不在仓库里（本机它就在仓库里 ✓，拿它当"仓库外"的样本会假红 ✗）。
    """
    monkeypatch.setattr(sidecar, "DEFAULT_WORKSPACE", Path(sidecar.__file__).parent / "nope")
    monkeypatch.setattr(sidecar, "_inside_repo", lambda path: True)

    with pytest.raises(RuntimeError) as excinfo:
        sidecar.default_workspace()

    assert "仓库根之下" in str(excinfo.value)


def test_knowledge_client_is_the_remote_one(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """装配出来的两端**就是远端实现** ✓（"循环本地、KB 与模型远端"落在这一行 ✓）。

    同时钉住本地那一侧的三条口径：默认**无隔离时直接执行**（`require_isolation` 默认 `false` ✓，
    不装 Docker 也要能跑 ✓），但**用户显式要求严格时必须被尊重** ✓（闸可开、不可被偷偷绕 ✗）、
    审批注册表**带过来了** ✓、KB 接缝指向的**是远端实现** ✓（不是进程内检索 ✗）。

    M3 阶段 2 起 KB 那一件是**提供者客户端**（`KnowledgeProviderClient`）✓ —— 它同时是
    `KnowledgeClient` 协议的一份实现（`retrieve_sources` 签名逐字一致 ✓），所以
    "循环本地"那条链一个字不用改 ✓。
    """
    clients = sidecar.build_clients(
        "http://server.test/api/v1", "t", workspace=tmp_path / "ws", data_dir=tmp_path / "data"
    )

    assert isinstance(clients.knowledge, KnowledgeProviderClient)
    assert isinstance(clients.knowledge, KnowledgeClient)
    assert clients.knowledge is clients.provider
    assert isinstance(clients.model, sidecar.RemoteModelClient)
    assert clients.base_url == "http://server.test/api/v1"
    # 探活打的是后端自己的 health（不花模型额度 ✓）
    assert clients.health_url == "http://server.test/api/v1/health"
    # 本地那一侧：严格档没被绕 ✓、审批整套在 ✓
    # 2026-09-30 用户裁定：默认**无隔离时直接执行**（"不装 Docker 也要能跑命令"）——
    # 所以默认值钉 `false` ✓；但下面这一步同样必须成立：**用户打开严格档后，值就得是 true** ✓
    # （闸可以开、也可以关，但**不能被偷偷绕** ✗ —— 那才是这条用例真正守的东西 ✓）
    assert clients.runtime.get("sandbox.require_isolation") == "false"
    clients.runtime.set({"sandbox.require_isolation": "true"})
    assert clients.runtime.get("sandbox.require_isolation") == "true"
    assert clients.approvals is clients.services.approvals


def test_the_kb_seam_is_delegated_when_given(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """**KB 接缝给了就整段委托**（M2 §2.2，落在 `ChatService.retrieve_sources`）✓。

    边车这一侧换的只是实现 ✓（`build_runner` 的 `search` 那一支只认这个方法名 ✓，
    所以"循环不改"成立 ✓）；服务器档**不传** knowledge，走进程内检索（一位不变 ✓）。
    """
    calls: list[dict[str, Any]] = []

    class _FakeKnowledge:
        def retrieve_sources(self, **kwargs: Any) -> list[str]:
            calls.append(kwargs)
            return ["远端命中的一段"]

    # `retrieval` / `runtime` 给个占位对象即可：委托那一支**碰都不碰它们** ✓
    # （这正是"整段委托"的意思——本机连向量仓储都没有）。
    chat = ChatService(object(), object(), knowledge=_FakeKnowledge())  # type: ignore[arg-type]

    found = chat.retrieve_sources(query="问一句", kb_ids=["kb1"], top_k=3)

    assert found == ["远端命中的一段"]
    # 参数**原样**过去（含默认值），调用点一个字不用改 ✓
    assert calls == [
        {"query": "问一句", "kb_ids": ["kb1"], "top_k": 3, "candidate_k": 40, "reader": None}
    ]
    # 一个库都没给 = 这一轮不查库：**在委托之前就返回空** ✓（空范围不该变成一次网络往返）
    assert chat.retrieve_sources(query="问一句", kb_ids=[]) == []
    assert len(calls) == 1


def test_search_in_a_turn_goes_to_the_nas(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**边车的检索真的打 NAS**（`POST /api/v1/search`）✓ —— 接缝整条链的行为证据。

    单看"组合根塞了 `RemoteKnowledgeClient`"不够 ✗：模型真要查资料时走的是
    `build_runner` → `services.chat.retrieve_sources` → 远端客户端这一整条，
    中间哪一环接错都会表现成"检索总说没有命中"（而那是看不出来的）。
    这里用假传输接住请求：**URL、鉴权头、请求体**三样都要对 ✓。
    """
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.read().decode())
        return httpx.Response(
            200,
            json={
                "hits": [
                    {
                        "index": 1,
                        "chunk_id": "chunk_1",
                        "document_id": "doc_1",
                        "document_name": "资料.md",
                        "heading_path": "一、开头",
                        "page": 2,
                        "score": 0.9,
                        "preview": "NAS 上命中的那一段",
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)

    def _fake_httpx():  # type: ignore[no-untyped-def]
        def _client(**kwargs: Any) -> httpx.Client:
            # 远端客户端自己会传 transport=None，这里把它换成假的（用例不打真网络 ✓）
            kwargs["transport"] = transport
            return httpx.Client(**kwargs)

        return SimpleNamespace(Client=_client, HTTPError=httpx.HTTPError)

    monkeypatch.setattr(remote_clients, "_httpx", _fake_httpx)
    model = _ToolCallingModel(
        "search",
        json.dumps({"query": "问一句", "knowledge_base_ids": ["kb_1"]}),
        "资料里说：NAS 上命中的那一段",
    )
    # 选了库 → 工具表要问一次提供者状态：给一个**握手成功**的（`search` 才摆得出来 ✓）。
    # 检索本身仍走组合根那个 `RemoteKnowledgeClient`（上面那个假传输接住它 ✓）。
    client = _client(tmp_path, monkeypatch, model, provider_factory=_ready_provider)

    payload = client.post("/turn", json={"message": "查一下资料", "kb_ids": ["kb_1"]}).json()

    # ① 打的是 NAS 的检索口，带着这把钥匙
    assert seen["url"] == "http://server.test/api/v1/search", seen
    assert seen["auth"] == "Bearer t"
    assert seen["body"]["query"] == "问一句"
    assert seen["body"]["kb_ids"] == ["kb_1"]
    # ② 命中原文进了工具结果（模型据此作答 ✓）
    done = [
        step
        for step in payload["steps"]
        if step.get("tool") == "search" and step.get("status") == "done"
    ]
    assert done, payload["steps"]
    assert "NAS 上命中的那一段" in done[0]["result"], done[0]["result"]
    assert payload["answer"] == "资料里说：NAS 上命中的那一段"


def test_search_reports_an_unreachable_nas_instead_of_pretending(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """NAS 连不上时**如实失败** ✗（不是"没命中" ✓）—— 而且这一轮照旧跑完 ✓。"""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope")

    transport = httpx.MockTransport(handler)

    def _fake_httpx():  # type: ignore[no-untyped-def]
        def _client(**kwargs: Any) -> httpx.Client:
            kwargs["transport"] = transport
            return httpx.Client(**kwargs)

        return SimpleNamespace(Client=_client, HTTPError=httpx.HTTPError)

    monkeypatch.setattr(remote_clients, "_httpx", _fake_httpx)
    model = _ToolCallingModel(
        "search",
        json.dumps({"query": "问一句", "knowledge_base_ids": ["kb_1"]}),
        "查不到资料，我按已知的说",
    )
    # **握手是好的、这一次检索连不上**：单次调用失败**不改状态**（方案 §3.2），
    # 所以 `search` 照旧在工具表里（模型也照旧会调它）——这一步如实失败即可 ✓。
    client = _client(tmp_path, monkeypatch, model, provider_factory=_ready_provider)

    payload = client.post("/turn", json={"message": "查一下", "kb_ids": ["kb_1"]}).json()

    # 这一步**失败了**（不是"没有命中"），原因上屏幕（`summary` 那一栏）✓
    failed = [
        step
        for step in payload["steps"]
        if step.get("tool") == "search" and step.get("status") == "done"
    ]
    assert failed, payload["steps"]
    assert failed[0]["outcome"] == "failed", failed[0]
    assert "连不上" in failed[0]["detail"], failed[0]["detail"]
    # 但这一轮**照旧跑完**：模型拿到失败结论，答了话，没有 error
    assert payload["answer"] == "查不到资料，我按已知的说"
    assert payload["error"] == ""


def test_probe_health_is_false_on_network_error() -> None:
    """探活失败一律当"不可达" ✓（用例里用假传输，不打真网络 ✗）。"""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope")

    transport = httpx.MockTransport(handler)
    original = httpx.get

    httpx.get = lambda url, **kwargs: httpx.Client(transport=transport).get(url, **kwargs)  # type: ignore[assignment]
    try:
        # **返回 (可达?, 说明)** ✓：说明里要有异常原文 ✗（别吞成一句"不可达" ✗）
        ok, reason = sidecar._probe_health("http://server.test/api/v1/health")
        assert ok is False
        assert "网络不可达" in reason and "ConnectError" in reason
    finally:
        httpx.get = original  # type: ignore[assignment]


# ------------------------------------------------------------------ 流式（P4）

def _events(response) -> list[dict[str, Any]]:  # type: ignore[no-untyped-def]
    """把 SSE 响应拆成事件载荷（**按线上形状解析** ✓，不猜内部对象 ✗）。"""
    out: list[dict[str, Any]] = []
    for line in response.text.splitlines():
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload:
            out.append(json.loads(payload))
    return out


# ------------------------------------------------- ASK 的通道（P4-4：确认条真的弹出来）

class _NeedsApprovalRunner:
    """假执行器：**第一次要用户点头** ✓（登记一条待确认），拿到决定之后才**真的执行** ✓。

    为什么不直接拿真 `run_command` 去撞审批：那要看 `chat.permission`、隔离后端、
    规则匹配三件事的脸色 ✗（本机没隔离后端时命令在执行前就被拒了 ✓），用例会随环境时红时绿 ✗。
    这里只把**执行器**换成假的 ✓ —— `ToolLoop`、`ApprovalRegistry`、SSE 这三层全是真的 ✓，
    验的正是"通道"这一段 ✓（照本文件"假两端"的老实做法 ✓）。
    """

    def __init__(self, registry: Any, *, timeout: float = 20.0) -> None:
        self.registry = registry
        #: 等待上限**故意比默认的 120 秒短** ✓：用例写错时会在 20 秒内收场 ✓（不挂住 CI ✗）；
        #: 但又必须比"TestClient 流式的开销"宽裕 ✓ —— 给 1.5 秒时实测到过"事件刚读到、
        #: 决定还没发出去就超时了" ✗（那是用例自己的时序，不是通道有问题 ✓）。
        self.timeout = timeout
        self.tool = "run_command"
        self.args = '{"command": "echo hi > 工作区外的文件.txt"}'
        #: 执行器收到的**取值**（`None` 档不在里面 —— 那一次压根不执行 ✓）。
        self.decisions: list[str] = []
        #: 真的执行了几次（批准才 1 ✓；拒绝 / 待确认都是 0 ✓）。
        self.ran = 0

    def __call__(self, name, args, approval=None):  # type: ignore[no-untyped-def]
        if approval is None:
            request = self.registry.open(
                tool=name,
                label="执行命令",
                args=str(args),
                detail="这条命令要写工作区外的文件",
                rule="Bash(echo:*)",
                timeout=self.timeout,
            )
            return ToolOutcome(content="这一步要先确认", summary="待确认", approval=request)
        self.decisions.append(str(approval))
        if approval in (DENY, UNAVAILABLE):
            # **不执行**，并且如实说清是哪一种"没批准"（措辞归另一条 lane ✓，取值是本用例的判据 ✓）
            return ToolOutcome(
                content=f"没有执行（{approval}）", summary="没执行", outcome="blocked"
            )
        self.ran += 1
        return ToolOutcome(content=f"执行完成（{approval}）", summary="执行完成", outcome="ok")


def _approval_app(tmp_path, monkeypatch, model):  # type: ignore[no-untyped-def]
    """装配一个**真的**边车 app，只把执行器与工具表换成"要审批的那个" ✓。"""
    holder: dict[str, Any] = {}

    def _build(base: str, token: str, *, workspace: Path, data_dir: Path):  # type: ignore[no-untyped-def]
        clients = sidecar.Clients(
            base,
            token,
            workspace=workspace,
            data_dir=data_dir,
            knowledge=object(),
            model=model,
        )
        holder["clients"] = clients
        return clients

    monkeypatch.setattr(sidecar, "build_clients", _build)
    monkeypatch.setattr(sidecar, "_probe_health", lambda url, timeout=5.0: (True, ""))
    app = sidecar.create_app("http://server.test/api/v1", "t", tmp_path / "ws")
    runner = _NeedsApprovalRunner(holder["clients"].approvals)
    monkeypatch.setattr(sidecar.agent_tools, "build_runner", lambda *a, **k: runner)
    monkeypatch.setattr(
        sidecar.Clients,
        "tool_specs",
        lambda self, kb_ids=(): [
            ToolSpec(name=runner.tool, description="在这台机器上跑一条命令", parameters={})
        ],
    )
    return app, holder["clients"], runner


def _loop_with_approval(model, runner, registry):  # type: ignore[no-untyped-def]
    """真的 `ToolLoop` + 真的 `ApprovalRegistry` ✓，只把模型与执行器换成假的 ✓。"""
    return ToolLoop(
        client_factory=lambda: model,
        tools=[ToolSpec(name=runner.tool, description="在这台机器上跑一条命令", parameters={})],
        runner=runner,
        approvals=registry,
    )


def _drive(loop, messages):  # type: ignore[no-untyped-def]
    """在**另一个线程**里驱动循环 ✓，返回 (线程, 事件列表, 收到询问的信号) ✓。

    为什么要另起线程：`/turn/stream` 那条链就是"生成器停在等确认上" ✓（真界面也是这个时序 ✓）。
    测试这条时序只有两种写法：真起一个服务器连 SSE ✗（`TestClient` 会把整段响应缓冲下来，
    于是"先收事件、再点按钮"根本发生不了 ✗ —— 实测决定要等 20 秒超时才被处理 ✓），
    或者**直接驱动那个生成器** ✓。这里选后者：`ToolLoop` + `ApprovalRegistry` 全是真的 ✓，
    少掉的只有 HTTP 那层包装 ✓（那层另有端点用例 ✓）。
    """
    events: list[object] = []
    seen = threading.Event()
    state: dict[str, BaseException | None] = {"error": None}

    def _run() -> None:
        try:
            for event in loop.run(messages=messages):
                events.append(event)
                if isinstance(event, sidecar.ApprovalEvent):
                    seen.set()
        except BaseException as exc:
            state["error"] = exc
            seen.set()

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return thread, events, seen, state


def test_ask_raises_an_approval_and_allow_once_reruns_the_step() -> None:
    """ASK 真的**问出来** ✓：事件带齐那七个字段 ✓，点「允许一次」后那一步**重跑并成功** ✓。

    `SSE` 那个载荷本身另有 `_approval_payload` 的用例 ✓（这里是循环这一段 ✓）。
    """
    model = _ToolCallingModel("run_command", '{"command": "echo hi"}', "已经处理好了")
    registry = ApprovalRegistry()
    runner = _NeedsApprovalRunner(registry)
    loop = _loop_with_approval(model, runner, registry)

    thread, events, seen, state = _drive(
        loop, [ChatMessage(role="user", content="在工作区外写个文件")]
    )
    # **先收到询问** ✓（循环那边已经停在 `wait_decision` 上了 ✓）—— 这一步不出现就是死锁 ✓
    assert seen.wait(10), "循环没有发出「要用户点头」的询问"
    assert state["error"] is None, state["error"]

    request = next(item for item in events if isinstance(item, sidecar.ApprovalEvent))
    assert request.tool == "run_command"
    assert "echo hi" in request.args
    assert request.label and request.detail and request.rule
    assert request.timeout_seconds > 0
    # 还没人点之前**一步都没执行** ✗（这正是"停下来问"的意思 ✓）
    assert runner.ran == 0 and runner.decisions == []

    # 点「允许一次」✓ —— 决定交回正在等它的那一步 ✓
    assert registry.decide(request.approval_id, ALLOW_ONCE) is True
    thread.join(timeout=10)
    assert not thread.is_alive(), "决定送到了，循环却没醒"

    assert runner.decisions == [ALLOW_ONCE]
    assert runner.ran == 1, "允许之后那一步**重跑并成功** ✓"
    done = next(item for item in events if isinstance(item, sidecar.DoneEvent))
    assert done.answer == "已经处理好了"


def test_deny_with_a_reason_reaches_the_model() -> None:
    """点「拒绝」+ 理由 → **模型收到那句话** ✓，而且那一步**没有执行** ✗。

    为什么专钉"理由进模型"：只回一句"被拒了"，模型多半把同一条命令原样再试一次 ✓
    （那是 `tool_loop._with_reason` 存在的原因 ✓）；理由是在**循环那一层**拼进回灌文本的 ✓，
    所以判据打在"模型下一轮看到的工具消息里有没有那句话"上 ✓。
    """
    model = _ToolCallingModel("run_command", '{"command": "rm -rf /"}', "那我换个做法")
    registry = ApprovalRegistry()
    runner = _NeedsApprovalRunner(registry)
    loop = _loop_with_approval(model, runner, registry)

    thread, events, seen, state = _drive(
        loop, [ChatMessage(role="user", content="帮我清一下盘")]
    )
    assert seen.wait(10)
    request = next(item for item in events if isinstance(item, sidecar.ApprovalEvent))
    assert registry.decide(request.approval_id, DENY, "别删，换成清理临时目录") is True
    thread.join(timeout=10)

    assert state["error"] is None, state["error"]
    assert runner.decisions == [DENY]
    assert runner.ran == 0, "拒绝之后**不许执行** ✗"
    tool_messages = [item for item in model.rounds[-1] if item.role == "tool"]
    assert tool_messages, "结果照旧回灌给模型 ✓"
    assert any("别删，换成清理临时目录" in str(item.content) for item in tool_messages)


def test_the_sse_approval_payload_matches_the_server_field_for_field() -> None:
    """`type=approval` 的载荷与服务器那条链**逐字对齐** ✓（少一个字段前端就得另做推断 ✗）。"""
    request = ApprovalRequest(
        approval_id="appr_1",
        tool="run_command",
        label="执行命令",
        args="echo hi",
        detail="在工作区外写文件",
        rule="Bash(echo:*)",
        timeout_seconds=120.0,
    )

    payload = sidecar._approval_payload(
        sidecar.ApprovalEvent(
            approval_id=request.approval_id,
            tool=request.tool,
            label=request.label,
            args=request.args,
            detail=request.detail,
            rule=request.rule,
            timeout_seconds=request.timeout_seconds,
        )
    )

    assert payload == {
        "approval_id": "appr_1",
        "tool": "run_command",
        "label": "执行命令",
        "args": "echo hi",
        "detail": "在工作区外写文件",
        "rule": "Bash(echo:*)",
        "timeout_seconds": 120.0,
    }


def test_the_decision_endpoint_hands_the_answer_to_the_waiting_step(
    tmp_path, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    """`POST /turn/approvals/{id}` 把决定交给**正在等它的那一步** ✓；失效的确认 → **409** ✓。

    判据打在**同一个登记表**上 ✓：端点调的就是 `Clients.approvals` ✓（不另造一套 ✗），
    所以"端点收下了"与"那一头拿到了"是同一件事 ✓ —— `wait_decision` 立刻返回 ✓，不等满超时 ✓。
    """
    app, clients, _runner = _approval_app(tmp_path, monkeypatch, _FakeModel())
    registry = clients.approvals
    request = registry.open(
        tool="run_command", label="执行命令", args="echo hi", rule="Bash(echo:*)"
    )

    with TestClient(app) as client:
        accepted = client.post(
            f"/turn/approvals/{request.approval_id}", json={"decision": "allow_once"}
        )
        assert accepted.status_code == 200, accepted.text
        assert accepted.json() == {"accepted": True, "detail": "已经交给正在等它的那一步"}

        # **那一头真的拿到了** ✓（同一个登记表 ✓，立刻返回 ✓）
        assert registry.wait_decision(request.approval_id).decision == ALLOW_ONCE

        # 再点一次：已经没有这条了 → **409** ✓（不是回一句"已记录" ✗，照服务器口径 ✓）
        again = client.post(
            f"/turn/approvals/{request.approval_id}", json={"decision": "deny"}
        )
        assert again.status_code == 409, again.text
        # 错误信封是**统一那个**（`{code, message}`，与服务器一字不差）✓ ——
        # 边车挂上 `register_exception_handlers` 之前这里是 FastAPI 默认的 `detail`，
        # 而前端 `client.ts::unwrap` 读的是 `message`：那一处正是"桌面端只看到
        # 『请求失败（HTTP 409）』"的成因（阶段 3 一并修好）。
        assert "失效" in again.json()["message"], again.text

        # 不存在的 id 也是 409 ✓
        unknown = client.post("/turn/approvals/deadbeef", json={"decision": "deny"})
        assert unknown.status_code == 409, unknown.text

        # 取值只有三个 ✓：别的值是 **422** ✓（不是静默当拒绝 ✗）
        assert client.post("/turn/approvals/x", json={"decision": "maybe"}).status_code == 422
        assert client.post("/turn/approvals/x", json={}).status_code == 422


def test_the_non_streaming_turn_has_no_channel_and_never_pretends_a_denial(
    tmp_path, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    """⑤ **没有通道**那条路：结果是"待确认"（`UNAVAILABLE`）✓，**不是**"用户拒绝了" ✗。

    `/turn`（非流式）是**整段**返回的 ✓ —— 询问发不出去（调用方在拿到响应之前不知道
    `approval_id` ✗），所以它按"这条链路上没人可以问"处理 ✓；让人干等 120 秒才是错的 ✗
    （那条路要走 `/turn/stream` ✓）。判据打在**执行器收到的取值**上 ✓：
    措辞归另一条 lane ✓，而"是 `UNAVAILABLE` 还是 `DENY`"是这条语义的硬边 ✓
    （把它们混起来，模型会以为用户看过并否了，下一轮就说错话 ✓）。
    """
    model = _ToolCallingModel("run_command", '{"command": "echo hi"}', "那我换个说法")
    app, _clients, runner = _approval_app(tmp_path, monkeypatch, model)

    with TestClient(app) as client:
        payload = client.post("/turn", json={"message": "帮我跑一下"}).json()

    assert runner.decisions == [UNAVAILABLE], "没有通道时必须是「待确认」这一档 ✓"
    assert runner.ran == 0, "没批准就不执行 ✓"
    # 而这一轮照旧答完 ✓（"待确认"不影响本轮把话说完 ✓）
    assert payload["answer"] == "那我换个说法"


def test_turn_stream_runs_a_tool_and_streams_the_answer(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**流式那条完整链** ✓：模型要工具 → 本地真执行 → 结果回灌 → 分块出正文 ✓。

    这是派单点名的那条用例 ✓ —— 它同时钉住四件事：
    ① 有**工具步**（且本地真的执行了：`result` 是文件内容 ✓）；
    ② 有**正文增量**，且增量拼起来 == `done.answer` ✓（前端兜底不会与流打架 ✓）；
    ③ `done` 是最后一条 ✓（收尾 ✓）；
    ④ 事件形状与服务器那条链同一套（`type` 字段 ✓）。
    """
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "hello.txt").write_text("流式读到你了", encoding="utf-8")

    model = _ToolCallingModel("read_file", '{"path": "hello.txt"}', "文件里写着：流式读到你了")
    client = _client(tmp_path, monkeypatch, model)

    response = client.post("/turn/stream", json={"message": "读 hello.txt"})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = _events(response)
    kinds = [event["type"] for event in events]

    # ① 工具步：本地真的执行了（结果里有文件内容 ✓，不是"宣布要读" ✗）
    tool_steps = [event for event in events if event["type"] == "step" and event.get("tool")]
    assert tool_steps, f"没有工具步：{events}"
    assert any("流式读到你了" in str(step.get("result") or "") for step in tool_steps), tool_steps
    # ② 正文增量：拼起来等于 done 里那份全文 ✓
    deltas = "".join(event["text"] for event in events if event["type"] == "delta")
    done = [event for event in events if event["type"] == "done"]
    assert deltas == "文件里写着：流式读到你了"
    assert done and done[-1]["answer"] == deltas
    # ③ 收尾形状与服务器同一套 ✓（最后一条就是 done ✓）
    assert kinds[-1] == "done"
    assert set(kinds) <= {"step", "thinking", "delta", "done", "error"}
    # ④ 没有失败事件 ✓（这一轮是成功的 ✓）
    assert "error" not in kinds


def test_turn_stream_reports_empty_answer_as_failure(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**正文为空绝不当成功** ✗✗：只流思考的模型 → `error` + 如实的 `done` ✓。

    与 `/turn` 的护栏同一套措辞 ✓（`empty-answer: …` ✓）。这条是派单点名的第 5 条 ✓。
    """
    client = _client(tmp_path, monkeypatch, _ThinkingOnlyModel())

    events = _events(client.post("/turn/stream", json={"message": "在吗"}))
    kinds = [event["type"] for event in events]

    assert "error" in kinds, f"空正文没有报失败：{events}"
    error = next(event for event in events if event["type"] == "error")
    assert error["message"].startswith("empty-answer:")
    assert "思考" in error["message"]
    done = [event for event in events if event["type"] == "done"]
    assert done and "边车报告" in done[-1]["answer"]
    # 思考照发 ✓（前端过程面板要用），但它**不是** answer ✗
    thinking = [event["text"] for event in events if event["type"] == "thinking"]
    assert thinking == ["先看看", "再想想"]
    assert not [event for event in events if event["type"] == "delta"]


def test_turn_stream_reports_remote_failure_instead_of_pretending(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """远端不可用 → `error` + 如实 `done` ✓（不许伪装成成功 ✗）。"""
    client = _client(tmp_path, monkeypatch, _BrokenModel())

    events = _events(client.post("/turn/stream", json={"message": "在吗"}))

    error = next(event for event in events if event["type"] == "error")
    assert "boom" in error["message"]
    done = [event for event in events if event["type"] == "done"]
    assert done and "边车报告" in done[-1]["answer"]


def test_turn_stream_closes_the_trailing_answer_step(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """收尾的"组织回答"步必须**再发一次且是 `done`** ✓（否则前端一直显示"正在回答" ✗）。"""
    client = _client(tmp_path, monkeypatch, _FakeModel("就这样"))

    events = _events(client.post("/turn/stream", json={"message": "在吗"}))
    answer_steps = [
        event for event in events if event["type"] == "step" and event["phase"] == "answer"
    ]

    assert answer_steps, f"没有回答步：{events}"
    assert answer_steps[-1]["status"] == "done", answer_steps


# ------------------------------------------------------------------ 写回服务器

def _patch_post(monkeypatch, handler) -> None:  # type: ignore[no-untyped-def]
    """把写回那个 `httpx.post` 换成假传输（**用例里不打真网络** ✓）。

    P4-3 之后 `sidecar` **不再在模块级 import httpx**（那会把 click/pygments/rich
    拖进客户端运行时的导入闭包 ✗）→ 用例改打**新的接缝**：`sidecar._httpx()` ✓
    （它是个惰性取值器，`monkeypatch` 换掉它就等于换掉这一侧的传输 ✓）。

    `get` 也一并假掉（2026-10-01，`list_notes` 用 `GET /notes` 起）——同一个 handler，
    按方法/路径分流（名字保持 `_patch_post` 不改：十来个用例都引它，改名只是噪音）。
    """
    transport = httpx.MockTransport(handler)

    def fake_post(url, **kwargs):  # type: ignore[no-untyped-def]
        return httpx.Client(transport=transport).post(url, **kwargs)

    def fake_get(url, **kwargs):  # type: ignore[no-untyped-def]
        return httpx.Client(transport=transport).get(url, **kwargs)

    fake_httpx = SimpleNamespace(post=fake_post, get=fake_get, HTTPError=httpx.HTTPError)
    monkeypatch.setattr(sidecar, "_httpx", lambda: fake_httpx)


def test_turn_records_the_turn_into_the_local_db(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**这一轮落本机库**（M2 阶段 3）：消息 + 步骤 + 思考都在自己这台机器上 ✓。

    同时钉住"**写回服务器那一半真的删掉了**"✗✗：`_httpx()` 被换成会炸的那个，
    整轮照旧跑完 —— 只要还有一步在出网，这条用例立刻红（这比"断言没打某个 URL"
    更强：它连"隐性的第二次请求"也挡得住）。
    """
    client = _client(tmp_path, monkeypatch, _FakeModel("答案在这里"))
    _no_network(monkeypatch)
    conversation_id = _new_conversation(client)

    payload = client.post(
        "/turn",
        json={"message": "问一句", "conversation_id": conversation_id, "turn_id": "t1"},
    ).json()

    assert payload["answer"] == "答案在这里"
    assert payload["recorded"] is True
    assert payload["turn_id"] == "t1"
    assert payload["error"] == ""
    # 库里的两条消息：提问与回答（正文、步骤都在）
    messages = _messages(client, conversation_id)
    assert [item["role"] for item in messages] == ["user", "assistant"]
    assert messages[0]["content"] == "问一句"
    assert messages[1]["content"] == "答案在这里"
    assert any(step["phase"] == "answer" for step in messages[1]["steps"])
    # 首轮提问顺手定了标题（`ensure_title` 只在没标题时动手 ✓）
    detail = client.get(f"/api/v1/conversations/{conversation_id}").json()
    assert detail["title"], detail


def test_turn_for_a_missing_conversation_is_reported_without_touching_the_answer(  # type: ignore[no-untyped-def]
    tmp_path, monkeypatch
) -> None:
    """**落库失败绝不许影响回答**：answer 仍在 ✓、notes 里如实写明 ✓、`recorded=false` ✓。

    最典型的一种失败是"这条会话本机没有"（前端拿着别的机器的会话 id）——
    它必须**报出来**而不是静默当成功（静默丢掉一轮是这一类里最糟的形态）。
    """
    client = _client(tmp_path, monkeypatch, _FakeModel("答案照旧"))
    _no_network(monkeypatch)

    payload = client.post(
        "/turn",
        json={"message": "问一句", "conversation_id": "conv_不存在", "turn_id": "t2"},
    ).json()

    assert payload["answer"] == "答案照旧", "落库失败把答案弄丢了"
    assert payload["recorded"] is False
    assert any("没能落本机库" in note for note in payload["notes"]), payload["notes"]
    # 失败**不算这一轮失败**：error 仍然只表示"没有正常作答"
    assert payload["error"] == ""


def test_turn_without_conversation_id_skips_the_write_but_says_so(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """没带会话 id → **不落库**，但 `notes` 里如实说明（不许静默丢一轮）✓。"""
    client = _client(tmp_path, monkeypatch, _FakeModel("答案"))
    _no_network(monkeypatch)

    payload = client.post("/turn", json={"message": "问一句"}).json()

    assert payload["recorded"] is None
    assert any("未落库" in note for note in payload["notes"]), payload["notes"]


def test_the_local_write_has_no_idempotency_key_yet(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """本机这条路**没有幂等键**：同一个 `turn_id` 再发一次就是**新的一轮** ✓。

    这是与服务器那条链**有意不同**的一处，所以要用例钉着它（不然下一个人会以为
    服务器那条的幂等在这里也成立）✗：
    - 服务器：`turn_id` 是幂等键，"标记与两条消息同一事务" → 重放不落第二条；
    - 本机：直接写库，没有那一步 → 同一轮重发 = 再问一遍（4 条消息）。

    要幂等就得给 `chat_messages` 加一列并落一次 schema 迁移 —— M2 **不做**，
    差别如实登记在阶段 3 的偏离点里（`_record_turn` 的 docstring 也写着这一条）。
    """
    client = _client(tmp_path, monkeypatch, _FakeModel("答案"))
    _no_network(monkeypatch)
    conversation_id = _new_conversation(client)

    for _ in range(2):
        payload = client.post(
            "/turn",
            json={"message": "问一句", "conversation_id": conversation_id, "turn_id": "same"},
        ).json()
        assert payload["answer"] == "答案"
        assert payload["error"] == ""
        assert payload["recorded"] is True

    assert len(_messages(client, conversation_id)) == 4, "同一轮重发在本机落了两轮"


def test_turn_stream_notes_a_failed_write_without_touching_the_answer(
    tmp_path, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    """流式那条也一样：落库失败只发一条 `phase="note"` 的 step，`done.answer` 不变 ✓。"""
    client = _client(tmp_path, monkeypatch, _FakeModel("流式答案"))
    _no_network(monkeypatch)

    events = _events(
        client.post("/turn/stream", json={"message": "问一句", "conversation_id": "conv_没有"})
    )

    notes = [event for event in events if event["type"] == "step" and event["phase"] == "note"]
    assert notes and "没能落本机库" in notes[0]["detail"], events
    done = [event for event in events if event["type"] == "done"]
    assert done and done[-1]["answer"] == "流式答案"
    # 落不了库**不是**这一轮的失败：没有 error 事件
    assert not [event for event in events if event["type"] == "error"]


def test_cors_allows_the_desktop_page_origin(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """壳的页面（`http://app.localhost`）要能**跨源直连**边车。

    没有这几个响应头，浏览器会在预检那一步就把请求掐掉（页面里只留一条
    `TypeError: Failed to fetch`），`resolveTurnTarget()` 于是永远回退到服务器——
    "对话在本机跑"这条会在界面上**静默**失效（2026-09-30 实测到的坑）。
    """
    client = _client(tmp_path, monkeypatch, _FakeModel())

    allowed = client.get("/health", headers={"Origin": "http://app.localhost"})
    assert allowed.headers.get("access-control-allow-origin") == "http://app.localhost"

    # 预检：真的 `fetch` 一个 JSON POST 之前，浏览器会先发这一条
    preflight = client.options(
        "/turn",
        headers={
            "Origin": "http://app.localhost",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert preflight.status_code == 200
    assert preflight.headers.get("access-control-allow-origin") == "http://app.localhost"

    # 不是"对所有源开放"：别的源照旧拿不到头
    other = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in other.headers


def test_export_lands_in_the_local_file_area(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**导出三件在边车这一侧也交付得出去**，而且**落在本机**（M2 阶段 3）✓。

    没有这条之前实测的后果：同一句"生成 sales.xlsx"，网页（服务器跑）交得了、
    桌面（本机跑）交不了 ✗ —— 模型只能回"要跑命令才能落盘"（命令又被隔离闸挡着）✗。

    阶段 3 之前它是"上传到服务器的会话文件区"；现在**产物记录与本机那份文件都在本机**
    （`ArtifactService.save`：挂了工作区就落用户的真实目录，没挂就落本机对象存储）✓，
    所以这条用例同时钉住"**一次网都不出**"（`_httpx` 被换成会炸的那个）。
    """
    model = _ToolCallingModel(
        "export_table",
        json.dumps({"filename": "sales.xlsx", "rows": [["月份", "销售额"], ["3月", 128]]}),
        "已交付：sales.xlsx",
    )
    client = _client(tmp_path, monkeypatch, model)
    _no_network(monkeypatch)
    conversation_id = _new_conversation(client)

    payload = client.post(
        "/turn", json={"message": "给我一份 xlsx", "conversation_id": conversation_id}
    ).json()

    # ① 卡片形状在步骤里（界面靠 `artifacts` 画那张可点的卡片）
    done = [
        step
        for step in payload["steps"]
        if step["tool"] == "export_table" and step["status"] == "done"
    ]
    assert done, payload["steps"]
    assert "本会话" in done[0]["result"], done[0]["result"]
    artifact = done[0]["artifacts"][0]
    assert artifact["artifact_id"].startswith("art_"), artifact
    assert artifact["where"] == "本会话"
    # ② 产物**记在本机库**里（界面那页文件区读的就是它）
    listed = client.get(f"/api/v1/conversations/{conversation_id}/artifacts")
    assert listed.status_code == 200, listed.text
    names = [item["name"] for item in listed.json()["items"]]
    assert names == ["sales.xlsx"], listed.text
    # ③ 字节也在本机（对象存储）——而且是一份**真的** xlsx（zip 头 PK）
    #    （文件区那两条下载路由要签名，用例直接看本机对象存储里落下来的那一份 ✓）
    stored = list((tmp_path / "data" / "conversations" / conversation_id).glob("*.xlsx"))
    assert len(stored) == 1, stored
    assert stored[0].read_bytes()[:2] == b"PK", stored[0]
    assert stored[0].stem == artifact["artifact_id"], stored[0]


def test_sidecar_exposes_the_export_family_but_not_the_server_only_ones() -> None:
    """导出三件、笔记两件、记忆两件 **在**表里；服务端专属那几件**不在**（2026-10-01）。"""
    assert {"export_document", "export_table", "export_deck"} <= sidecar.SIDECAR_TOOL_NAMES
    assert {"create_note", "attach_note_to_kb"} <= sidecar.SIDECAR_TOOL_NAMES
    assert {"recall", "remember"} <= sidecar.SIDECAR_TOOL_NAMES
    assert not {"ingest_artifact", "read_memory", "write_memory"} & sidecar.SIDECAR_TOOL_NAMES


def test_note_lands_in_the_local_db(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**笔记落本机库**（M2 阶段 3）：`create_note` → `services.notes.create` ✓。

    与导出同一类问题："帮我记一条笔记"在网页交得了、在桌面（本机跑）交不了 ✗ ——
    现在两边的账都是本机这一份，而且**一次网都不出** ✓（`_no_network`）。
    """
    model = _ToolCallingModel(
        "create_note",
        json.dumps({"title": "会议纪要", "content_md": "- 决定：周五发版", "tags": ["会议"]}),
        "记好了",
    )
    client = _client(tmp_path, monkeypatch, model)
    _no_network(monkeypatch)

    payload = client.post("/turn", json={"message": "帮我记一条笔记"}).json()

    # ① 工具结果就是那句"笔记已保存（不是交付）"，模型据此作答
    done = [
        step
        for step in payload["steps"]
        if step.get("tool") == "create_note" and step.get("status") == "done"
    ]
    assert done, payload["steps"]
    assert "笔记已保存" in done[0]["result"], done[0]["result"]
    assert payload["answer"] == "记好了"
    # ② 本机后端那页笔记读得到它（**同一个库**，不是两处账）
    listed = client.get("/api/v1/notes")
    assert listed.status_code == 200, listed.text
    titles = [item["title"] for item in listed.json()["items"]]
    assert titles == ["会议纪要"], listed.text


def test_attach_note_reports_the_missing_knowledge_base(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**`attach_note_to_kb` 在本机档如实报"知识库不可用"**（M2 §4.2 / R9）✓。

    它入的是**知识库**，而知识库整条（解析 / 切块 / 嵌入 / 向量）都在 NAS 上、
    本机连表都没有 —— 所以这条路现在的答案是**503 那句**（"知识库在 NAS 服务器上，
    本机档没有它的数据源，M3 接知识库提供者"），而不是"假装入上了" ✗。

    这与 `ingest_file`（保留远端、照旧能传）**有意不同** ✗：那一件只差一个上传口，
    字节又恰好在本机；笔记这条要从本机库里读正文再往 NAS 的知识库塞，
    那正是 M3 的提供者要统一管的事（不再为它单独开一条绕过服务层的直连）。
    """
    model = _ToolCallingModel("attach_note_to_kb", "{}", "这一步没能做成")
    client = _client(tmp_path, monkeypatch, model)
    _no_network(monkeypatch)
    created = client.post(
        "/api/v1/notes",
        json={"title": "会议纪要", "content_md": "- 决定：周五发版"},
    )
    assert created.status_code == 201, created.text
    # 模型这一步要带的参数在这里补上：`note_id` 得是真的 —— 归属那条先判，
    # 看不到的笔记是 404（"笔记不存在"），那就验不到"知识库不可用"这条分支了。
    # 此刻模型还没被调用（`_client` 只装配），所以补参数是安全的 ✓
    model.arguments = json.dumps(
        {"note_id": created.json()["id"], "knowledge_base_id": "kb_1"}
    )

    payload = client.post("/turn", json={"message": "把那条笔记加进知识库"}).json()

    step = [
        item
        for item in payload["steps"]
        if item.get("tool") == "attach_note_to_kb" and item.get("status") == "done"
    ]
    assert step, payload["steps"]
    # 如实失败：这一步没做成，原因上屏幕（`detail` 那一栏）✓
    assert step[0]["outcome"] == "failed", step[0]
    assert "知识库在 NAS" in step[0]["detail"], step[0]


def test_remember_is_forwarded_to_the_server(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**记忆写在本机**（M2 阶段 3）：`remember` → `MemoryService.remember` ✓。

    "记住我喜欢 X"这条链的落点是 `data_dir/memory/MEMORY.md` —— **本机那份**
    （记忆本体本来就在数据目录下，边车现在读写的正是自己这一份）✓，
    而且**一次网都不出** ✓。
    """
    model = _ToolCallingModel(
        "remember",
        json.dumps({"content": "用户偏好深色模式", "tags": ["偏好"]}),
        "记住了",
    )
    client = _client(tmp_path, monkeypatch, model)
    _no_network(monkeypatch)

    payload = client.post("/turn", json={"message": "记住我偏好深色模式"}).json()

    # ① 工具结果就是那句"已写入核心长期记忆"，模型据此作答
    done = [
        step
        for step in payload["steps"]
        if step.get("tool") == "remember" and step.get("status") == "done"
    ]
    assert done, payload["steps"]
    assert "已写入核心长期记忆" in done[0]["result"], done[0]["result"]
    assert payload["answer"] == "记住了"
    # ② 内容真的写进了本机那份 MEMORY.md
    memory_file = tmp_path / "data" / "memory" / "MEMORY.md"
    assert memory_file.is_file(), memory_file
    assert "用户偏好深色模式" in memory_file.read_text(encoding="utf-8")


def test_recall_reads_the_local_memory(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**记忆读也在本机**（M2 阶段 3）：`recall` → `MemoryService.recall` ✓。

    三件事一起钉住：

    1. **开关的权威在本机了** ✗：`recall` 受 `memory.enabled` 门控（默认关），
       关着时它**明确报错**而不是回空 —— 所以先用本机后端那页设置把它打开
       （`PATCH /api/v1/settings`），证明"改的是同一个库、对边车立刻生效" ✓；
    2. 命中真的从 `data_dir/memory/` 出来（本轮不联网 ✓，靠 `_no_network` + 假模型）；
    3. **召回池是 `daily/` 与 `digest/`**（`memory_files._INDEXED_KINDS`）：
       `MEMORY.md` 走**注入**不进召回（同一段内容进上下文两次是设计上要避免的），
       所以这一条把内容放进 `daily/`。

    ⚠️ 现场事实（阶段 3 发现，未修）：这份用例跑的是**开发 venv**（装了 jieba ✓），
    而打出来的客户端运行时里**没有 jieba**（`requirements-sidecar.txt` 明写不打包，
    实测 `build/sidecar-runtime/Lib/site-packages` 里没有它）—— 也就是"打包后的桌面端"
    调 `recall` 会在**调用那一刻**抛 `ModuleNotFoundError`（惰性导入，见
    `services/retrieval/coverage._jieba`）。阶段 3 之前这条路走 NAS（那边有 jieba），
    收编到本机之后才露出来。两条出路留给架构师定：往客户端运行时加 jieba（+约 41 MB），
    或让记忆召回在缺 jieba 时只用"相邻字对"那条通道（`_word_pairs` 不依赖分词）。
    """
    model = _ToolCallingModel("recall", json.dumps({"query": "深色模式"}), "你偏好深色模式")
    client = _client(tmp_path, monkeypatch, model)
    _no_network(monkeypatch)
    opened = client.patch(
        "/api/v1/settings", json={"values": [{"key": "memory.enabled", "value": "true"}]}
    )
    assert opened.status_code == 200 and opened.json()["updated"] == 1, opened.text
    # 往召回池里放一条（`daily/`，不是 `MEMORY.md` —— 那两份走注入，见 docstring 第 3 条）
    daily = tmp_path / "data" / "memory" / "daily" / "2026-10-01.md"
    daily.parent.mkdir(parents=True, exist_ok=True)
    daily.write_text("# 2026-10-01\n\n- 用户偏好深色模式 #偏好\n", encoding="utf-8")

    payload = client.post("/turn", json={"message": "我之前说过什么偏好？"}).json()

    done = [
        step
        for step in payload["steps"]
        if step.get("tool") == "recall" and step.get("status") == "done"
    ]
    assert done, payload["steps"]
    # 命中的正文与来源路径都在（`tools.py::_recall` 那份读法 ✓）
    assert "深色模式" in done[0]["result"], done[0]["result"]
    assert "daily/2026-10-01.md" in done[0]["result"], done[0]["result"]
    assert payload["answer"] == "你偏好深色模式"


def test_recall_says_so_when_the_memory_switch_is_off(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**默认关着 → 如实报错** ✗（不是回空结果："它不记得"与"记忆没开"是两件事 ✓）。"""
    model = _ToolCallingModel("recall", json.dumps({"query": "深色模式"}), "记忆没开着")
    client = _client(tmp_path, monkeypatch, model)
    _no_network(monkeypatch)

    payload = client.post("/turn", json={"message": "我之前说过什么偏好？"}).json()

    step = [
        item
        for item in payload["steps"]
        if item.get("tool") == "recall" and item.get("status") == "done"
    ]
    assert step, payload["steps"]
    assert step[0]["outcome"] == "failed", step[0]
    assert "记忆" in step[0]["result"] or "记忆" in step[0]["detail"], step[0]


def test_list_notes_reads_the_local_db(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**笔记列表也走本机**（M2 阶段 3）：`list_notes` → `services.notes.list` ✓。

    这条以前测的是"两处翻译"（服务器列表项不带正文、`updated_at` 是 ISO 串）；
    现在列表就是本机库里的记录（正文与 datetime 都齐），翻译那两处不再需要 ——
    要钉的是**同一份账**：本机后端建一条、工具就看得见 ✓。
    """
    model = _ToolCallingModel("list_notes", json.dumps({"query": "会议"}), "你有 1 条会议笔记")
    client = _client(tmp_path, monkeypatch, model)
    _no_network(monkeypatch)
    created = client.post(
        "/api/v1/notes",
        json={"title": "会议纪要", "content_md": "- 决定：周五发版", "tags": ["会议"]},
    )
    assert created.status_code == 201, created.text

    payload = client.post("/turn", json={"message": "看看我记过哪些会议笔记"}).json()

    done = [
        step
        for step in payload["steps"]
        if step.get("tool") == "list_notes" and step.get("status") == "done"
    ]
    assert done, payload["steps"]
    result = done[0]["result"]
    assert "会议纪要" in result, result
    assert "决定：周五发版" in result, result
    assert "in_knowledge_base" in result, result
    assert payload["answer"] == "你有 1 条会议笔记"


def test_ingest_file_reads_local_and_uploads(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**本机文件入库**：`ingest_file` 在边车侧 = 读本机 → multipart 上传 ✓。

    M3 阶段 2 起这条路走的是**提供者客户端**（`KnowledgeProviderClient.submit`，
    收编了 M2 那份 `sidecar._LocalIngest`）——所以这条用例现在同时是
    "上传的形状照旧对" 与 "换实现没有改行为" 两份证据。

    验证四件事：① 工具只在**选了库**（kb_ids 非空）**且提供者 ready** 时摆出来；
    ② 字节从**本机工作区**读出来（不是从服务器文件区）；③ 上传打到
    `POST /knowledge-bases/{kb_id}/documents`，multipart 字段按服务器那份契约；
    ④ `start=true` 与 `X-Kylab-Operator` 归都是提供者客户端带的（NAS 自己入队）。
    """
    seen: dict[str, Any] = {}
    workspace = tmp_path / "ws"
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "notes.txt").write_text("hello from local", encoding="utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/knowledge-bases/kb_1/documents"):
            seen["url"] = str(request.url)
            seen["body"] = request.read()  # multipart 原始字节
            seen["operator"] = request.headers.get("x-kylab-operator")
            return httpx.Response(
                202,
                json={
                    "document": {"id": "doc_9", "name": "notes.txt"},
                    "is_duplicate": False,
                    "task_id": "task_1",
                },
            )
        # 写回那一轮（`POST /chat/turns/record`）
        return httpx.Response(200, json={"recorded": True})

    _patch_post(monkeypatch, handler)
    model = _ToolCallingModel(
        "ingest_file",
        json.dumps({"knowledge_base_id": "kb_1", "path": "notes.txt"}),
        "已经放进知识库了",
    )
    # ① 提供者 ready（握手走假传输 ✓）+ 上传那份请求交给上面的 handler ✓
    client = _client(
        tmp_path, monkeypatch, model, provider_factory=lambda: _ready_provider(handler)
    )

    # ② 带上选中的库跑一轮（`ingest_file` 受 `_LOCAL_KB_TOOLS` 门控：kb_ids 非空才摆）
    payload = client.post(
        "/turn", json={"message": "把 notes.txt 放进知识库", "kb_ids": ["kb_1"]}
    ).json()

    # ③ 上传真的打到了文档上传口，multipart 里是**本机那份的字节**
    url = seen.get("url", "")
    assert "/api/v1/knowledge-bases/kb_1/documents" in url, seen
    # **`start=true` 由提供者客户端带**：NAS 那一侧据此自己入队（本机没有队列）
    assert "start=true" in url, seen
    assert b"hello from local" in seen["body"], seen["body"][:400]
    assert b'filename="notes.txt"' in seen["body"], seen["body"][:400]
    # ④ 工具结果按 `_ingest_file` 的口径（文档 id + 入队说明）
    done = [
        step
        for step in payload["steps"]
        if step.get("tool") == "ingest_file" and step.get("status") == "done"
    ]
    assert done, payload["steps"]
    assert "doc_9" in done[0]["result"], done[0]["result"]
    assert "已入队处理" in done[0]["result"], done[0]["result"]
    assert payload["answer"] == "已经放进知识库了"


# ------------------------------------------- 提供者状态门控工具表（M3 阶段 2）


def test_kb_tools_are_gated_by_the_provider_state(tmp_path) -> None:
    """**非 ready 就不摆那三个要知识库的工具**（方案 §3.2 的失败降级）。

    三态各验一遍（`ready` / `unavailable` / `unconfigured`）——判据是它们在**工具表**
    里在不在（`search` / `attach_note_to_kb` / `ingest_file`），而不是"调起来会报错"：
    给了又拒只会白花一个来回（与 `_KB_TOOLS` 的"关了就不摆"同一条纪律）。
    别的工具（本机那批）**一件都不该受影响** —— 知识库断了不是这台机器断了。
    """
    kb_tools = {"search", "attach_note_to_kb", "ingest_file"}

    ready = _clients_with(tmp_path, _ready_provider)
    assert ready.provider.status().state == STATE_READY
    assert kb_tools <= {spec.name for spec in ready.tool_specs(kb_ids=["kb_1"])}

    dead = _clients_with(tmp_path, _dead_provider)
    assert dead.provider.status().state == STATE_UNAVAILABLE
    names = {spec.name for spec in dead.tool_specs(kb_ids=["kb_1"])}
    assert not (kb_tools & names), names
    assert "read_file" in names and "create_note" in names

    off = _clients_with(tmp_path, _disabled_provider)
    assert off.provider.status().state == STATE_UNCONFIGURED
    assert not (kb_tools & {spec.name for spec in off.tool_specs(kb_ids=["kb_1"])})


def test_no_knowledge_base_selected_means_no_handshake_at_all(tmp_path) -> None:
    """**没选库 = 一次都不探**（R1：交互路径不被握手拖慢）。

    那三个工具在没有 `kb_ids` 时本来就已经被库开关摘掉了（`_KB_TOOLS` /
    `_LOCAL_KB_TOOLS`），所以这一层不该再为一次用不到的结论去等一趟 NAS 往返 ——
    判据是"探过几次"（记录假传输的调用），而不是"没报错"。
    """
    probed: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        probed.append(str(request.url))
        return httpx.Response(200, json=_handshake_body())

    clients = _clients_with(
        tmp_path,
        lambda: KnowledgeProviderClient(transport=httpx.MockTransport(handler)),
    )

    names = {spec.name for spec in clients.tool_specs()}

    assert probed == []
    assert not {"search", "attach_note_to_kb", "ingest_file"} & names
    assert "read_file" in names

