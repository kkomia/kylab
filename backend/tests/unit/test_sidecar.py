"""边车（P3）的用例：**假的两端** ✓（P1 的协议正是为这个 ✓），测试里不打真网络 ✗。

三条硬要求：
1. `/turn` 能用假模型跑通一轮 ✓（回答落回 `answer` ✓）；
2. **工具真的在本机执行** ✓：模型要求调工具 → 本地跑 → 结果回灌 → 再作答 ✓（完整链路 ✓）；
3. `/health` 在远端**不可达时如实报不可达** ✗（不许假装健康 ✓）。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import sidecar
from app.services.llm import ChatMessage, LLMDelta, ToolCallDelta
from app.services.remote_clients import RemoteUnavailableError


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


def _client(tmp_path, monkeypatch, model, *, health_ok: bool = True) -> TestClient:  # type: ignore[no-untyped-def]
    # 装配点整体换成"真 Clients + 假模型/假 KB" ✓ —— **必须在 create_app 之前打补丁** ✗：
    # `create_app` 内部就调 `build_clients` ✓，晚一步它就把真客户端装进去了 ✓
    # （那会让用例打真网络 ✗ —— 第一次就是这么假红的）。
    #
    # 注意：这里**不再**替换整个装配点 ✗ —— 本地那一侧（runtime / 审批 / 工具表 /
    # `build_runner`）要**真的**建起来 ✓，否则"工具真的执行"这条验不到 ✓。
    def _build(base: str, token: str, *, workspace: Path, data_dir: Path):  # type: ignore[no-untyped-def]
        return sidecar.Clients(
            base,
            token,
            workspace=workspace,
            data_dir=data_dir,
            knowledge=object(),
            model=model,
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
    """装配出来的两端**就是 P2 的远端实现** ✓（"循环本地、KB 与模型远端"落在这一行 ✓）。

    同时钉住本地那一侧的三条口径：`require_isolation` 仍是 `true` ✓（闸不许绕 ✗）、
    审批注册表**带过来了** ✓、KB 接缝指向的**是远端实现** ✓（不是进程内检索 ✗）。
    """
    clients = sidecar.build_clients(
        "http://server.test/api/v1", "t", workspace=tmp_path / "ws", data_dir=tmp_path / "data"
    )

    assert isinstance(clients.knowledge, sidecar.RemoteKnowledgeClient)
    assert isinstance(clients.model, sidecar.RemoteModelClient)
    assert clients.base_url == "http://server.test/api/v1"
    # 探活打的是后端自己的 health（不花模型额度 ✓）
    assert clients.health_url == "http://server.test/api/v1/health"
    # 本地那一侧：严格档没被绕 ✓、审批整套在 ✓
    assert clients.runtime.get("sandbox.require_isolation") == "true"
    assert clients.approvals is clients.services.approvals


def test_the_kb_seam_goes_to_the_remote_client(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """**KB 接缝打的是远端** ✓：`services.chat.retrieve_sources` → P2 的实现 ✓。

    服务器模式下同一个方法名打的是进程内检索 ✓；边车这一侧换的只是实现 ✓
    （`build_runner` 的 `search` 那一支只认这个方法名 ✓，所以"循环不改"成立 ✓）。
    """
    calls: list[dict[str, Any]] = []

    class _FakeKnowledge:
        def retrieve_sources(self, **kwargs: Any) -> list[str]:
            calls.append(kwargs)
            return ["远端命中的一段"]

    clients = sidecar.Clients(
        "http://server.test/api/v1",
        "t",
        workspace=tmp_path / "ws",
        data_dir=tmp_path / "data",
        knowledge=_FakeKnowledge(),
    )

    found = clients.services.chat.retrieve_sources(query="问一句", kb_ids=["kb1"], top_k=3)

    assert found == ["远端命中的一段"]
    assert calls == [{"query": "问一句", "kb_ids": ["kb1"], "top_k": 3}]


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
    assert [event["text"] for event in events if event["type"] == "thinking"] == ["先看看", "再想想"]
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
    answer_steps = [event for event in events if event["type"] == "step" and event["phase"] == "answer"]

    assert answer_steps, f"没有回答步：{events}"
    assert answer_steps[-1]["status"] == "done", answer_steps

