"""执行工具（v0.33）：三道闸一层不省。

镜像同构：``app/services/agent_exec.py`` → 本文件。

`api/v1/sandbox.py` 是"用户自己点一条命令去跑"，这里是"模型想跑"。
两者的闸是同一套（权限 / 策略 / 内核隔离），差别只有一处，而那一处是本文件的重点：

**``ask`` 这一档在这里是"拒绝并说清"，不是"停下来问用户"。**
对话是一条拉取式生成器，做不到"先把已发生的事件送出去、再阻塞等人回答"
（见模块头）。所以这里必须钉住两件事：**默认档下不许执行**、
**拒绝时必须告诉模型怎么放开**——否则模型只会反复重试同一条命令，
而用户看到的是"它一直在试一个被禁的事"。

另外三条：不是管理员就拒绝（与端点同一档）、没有隔离就拒绝（**不回退成裸跑**）、
命令拆得出 argv（``command`` 字符串也认，但不走 shell）。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.exceptions import InvalidRequestError
from app.services import agent_exec
from app.services import isolation as isolation_service
from app.services.agent_exec import MAX_TIMEOUT_SECONDS, run_command
from app.services.api_key import Caller
from app.storage.base import UserRecord


class _FakeRuntime:
    """运行期配置的假形状（只用到 ``get``）。"""

    def __init__(self, **values: object) -> None:
        self._values = {key: str(value) for key, value in values.items()}
        self.data_dir = Path(self._values.get("data_dir", "."))

    def get(self, key: str) -> str:
        return self._values.get(key, "")

    def get_bool(self, key: str, default: bool = False) -> bool:
        return bool(self._values.get(key, default))


class _FakeServices:
    def __init__(self, **values: object) -> None:
        self.runtime = _FakeRuntime(**values)


def _admin() -> Caller:
    return Caller(is_admin=True)


def _member() -> Caller:
    return Caller(is_admin=False, user=UserRecord(id="u_1", name="甲", username="jia"))


@pytest.fixture
def workspace(tmp_path, monkeypatch):  # type: ignore[no-untyped-def]
    """一个真实的工作区目录 + 一个假的数据目录（沙箱落在它下面）。"""
    root = tmp_path / "project"
    root.mkdir()
    (root / "a.txt").write_text("hi", encoding="utf-8")
    data = tmp_path / "data"
    data.mkdir()
    services = _FakeServices(data_dir=str(data))
    monkeypatch.setattr(
        agent_exec, "resolve_roots", lambda *a, **k: agent_exec.Roots(root, data / "sandbox")
    )
    return services


def _allow_all(services: _FakeServices) -> None:
    services.runtime._values["sandbox.exec_policy"] = "allow"


def _available(monkeypatch, *, backend: str = "bwrap") -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(
        agent_exec,
        "_detect",
        lambda force=False: isolation_service.Isolation(backend, True, "测试里假装就位"),
    )


# ------------------------------------------------------------------ 闸 0：权限


def test_members_cannot_run_commands(workspace) -> None:  # type: ignore[no-untyped-def]
    """执行是"在这台机器上跑代码"，与端点同属管理员档——成员账号的模型不该绕过它。"""
    outcome = run_command(workspace, _member(), conversation_id=None, args={"command": "ls"})
    assert outcome.ran is False
    assert "只对管理员开放" in outcome.text


# ------------------------------------------------------------------ 闸 1：策略


def test_default_policy_refuses_and_explains_how_to_open(workspace) -> None:  # type: ignore[no-untyped-def]
    """**默认档是 ask**：没配置过就执行，等于替用户点了那个头。"""
    outcome = run_command(workspace, _admin(), conversation_id=None, args={"command": "ls"})
    assert outcome.ran is False
    assert "需要对方先确认" in outcome.text
    # 必须给两条出路（改总开关 / 加放行规则），否则模型只能反复重试
    assert "sandbox.exec_policy" not in outcome.text  # 给用户看的是界面路径，不是配置键
    assert "设置 → 沙箱执行" in outcome.text
    assert "Bash(ls" in outcome.text


def test_deny_rule_beats_a_broader_allow(workspace) -> None:  # type: ignore[no-untyped-def]
    workspace.runtime._values["sandbox.rules_allow"] = "Bash(git:*)"
    workspace.runtime._values["sandbox.rules_deny"] = "Bash(git push:*)"
    outcome = run_command(
        workspace, _admin(), conversation_id=None, args={"command": "git push origin main"}
    )
    assert outcome.ran is False
    assert "拒绝规则" in outcome.text


def test_deny_policy_switch_stops_everything(workspace) -> None:  # type: ignore[no-untyped-def]
    workspace.runtime._values["sandbox.exec_policy"] = "deny"
    outcome = run_command(workspace, _admin(), conversation_id=None, args={"command": "ls"})
    assert outcome.ran is False
    assert "拒绝执行" in outcome.text


# ------------------------------------------------------------------ 闸 2：隔离


def test_without_isolation_it_refuses_instead_of_running_naked(workspace, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**不回退成裸跑**：回退会把"我们以为它在沙箱里"变成一个静默的假象。"""
    _allow_all(workspace)
    monkeypatch.setattr(
        agent_exec, "_detect", lambda force=False: isolation_service.detect(prefer="none")
    )
    outcome = run_command(workspace, _admin(), conversation_id=None, args={"command": "ls"})
    assert outcome.ran is False
    assert "没有可用的内核级隔离" in outcome.text


def test_runs_when_policy_and_isolation_are_both_ready(workspace, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _allow_all(workspace)
    _available(monkeypatch)
    seen: dict[str, object] = {}

    def _fake_run(argv, **kwargs):  # type: ignore[no-untyped-def]
        seen["argv"] = argv
        seen.update(kwargs)
        return isolation_service.ExecutionResult(
            exit_code=0, stdout="hello\n", stderr="", truncated=False, backend="bwrap"
        )

    monkeypatch.setattr(isolation_service, "run_isolated", _fake_run)
    outcome = run_command(
        workspace,
        _admin(),
        conversation_id=None,
        args={"command": "python -c 'print(1)'", "timeout_seconds": 5},
    )
    assert outcome.ok and outcome.ran
    assert seen["argv"] == ["python", "-c", "print(1)"]
    assert seen["timeout"] == 5
    assert seen["allow_network"] is False
    # 结果里必须有**命令原文、退出码、标准输出**：少了任何一样，模型就没法判断
    # 这次到底发生了什么（"没输出"与"失败了"在它眼里会变成同一件事）
    assert "python -c print(1)" in outcome.text or "python -c 'print(1)'" in outcome.text
    assert "退出码：0" in outcome.text
    assert "hello" in outcome.text
    # 它得知道自己在哪跑（下一步要让命令去碰那些文件）
    assert str(workspace.runtime.data_dir) in outcome.text


def test_network_is_off_unless_asked(workspace, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _allow_all(workspace)
    _available(monkeypatch)
    seen: dict[str, object] = {}
    monkeypatch.setattr(
        isolation_service,
        "run_isolated",
        lambda argv, **kwargs: (
            seen.update(kwargs) or isolation_service.ExecutionResult(0, "", "", False, "bwrap")
        ),
    )
    run_command(
        workspace, _admin(), conversation_id=None, args={"command": "ls", "allow_network": True}
    )
    assert seen["allow_network"] is True


def test_failure_is_reported_not_hidden(workspace, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _allow_all(workspace)
    _available(monkeypatch)
    monkeypatch.setattr(
        isolation_service,
        "run_isolated",
        lambda argv, **kwargs: isolation_service.ExecutionResult(2, "", "boom", False, "bwrap"),
    )
    outcome = run_command(workspace, _admin(), conversation_id=None, args={"command": "false"})
    assert outcome.ran is True and outcome.ok is False
    assert "退出码：2" in outcome.text
    assert "boom" in outcome.text


# ------------------------------------------------------------------ 参数


def test_argv_array_is_preferred_and_untouched(workspace, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _allow_all(workspace)
    _available(monkeypatch)
    seen: dict[str, object] = {}
    monkeypatch.setattr(
        isolation_service,
        "run_isolated",
        lambda argv, **kwargs: (
            seen.update(argv=argv) or isolation_service.ExecutionResult(0, "", "", False, "bwrap")
        ),
    )
    run_command(workspace, _admin(), conversation_id=None, args={"argv": ["ls", "-la", "my dir"]})
    assert seen["argv"] == ["ls", "-la", "my dir"]


def test_empty_command_is_rejected(workspace) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(InvalidRequestError, match="缺少参数"):
        run_command(workspace, _admin(), conversation_id=None, args={})


def test_timeout_is_clamped(workspace, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """超时给到上限为止：一轮里同一批命令是并发的，一条跑几百秒会拖住整轮。"""
    _allow_all(workspace)
    _available(monkeypatch)
    seen: dict[str, object] = {}
    monkeypatch.setattr(
        isolation_service,
        "run_isolated",
        lambda argv, **kwargs: (
            seen.update(kwargs) or isolation_service.ExecutionResult(0, "", "", False, "bwrap")
        ),
    )
    run_command(
        workspace,
        _admin(),
        conversation_id=None,
        args={"command": "sleep 999", "timeout_seconds": 9999},
    )
    assert seen["timeout"] == MAX_TIMEOUT_SECONDS


def test_non_numeric_timeout_is_rejected(workspace) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(InvalidRequestError, match="要是数字"):
        run_command(
            workspace,
            _admin(),
            conversation_id=None,
            args={"command": "ls", "timeout_seconds": "很久"},
        )
