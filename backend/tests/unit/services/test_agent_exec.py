"""执行工具（v0.33）：三道闸一层不省。

镜像同构：``app/services/agent_exec.py`` → 本文件。

`api/v1/sandbox.py` 是"用户自己点一条命令去跑"，这里是"模型想跑"。
两者的闸是同一套（权限 / 策略 / 内核隔离），差别只有一处，而那一处是本文件的重点：

**``ask`` 这一档在这里是"真的会问"**（v0.41）：登记一条待确认、把决定交给
工具循环去问，拿到 ``approval=…`` 之后**再跑一遍**同一个函数。所以这里必须钉住：

- 默认档下**一次都不执行**（`run_isolated` 一次都不能被调用）；
- 拿到 ``allow_once`` 才执行、``allow_always`` 还要写下放行规则、
  ``deny`` / ``timeout`` / 没有人可问时**不执行并说清是哪一种**——
  三者的措辞不一样，因为模型下一轮该讲的话不一样；
- 回给模型的"怎么放开"那两条出路**在任何一条拒绝对话里都要在**，
  否则模型只能反复重试同一条命令。

另外三条：不是管理员就拒绝（与端点同一档）、没有隔离就拒绝（**不回退成裸跑**，
且**排在"问用户"之前**——问了也跑不了的事不该让对方白点一次）、
命令拆得出 argv（``command`` 字符串也认，但不走 shell）。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.exceptions import InvalidRequestError
from app.services import agent_exec
from app.services import approvals as approval_service
from app.services import isolation as isolation_service
from app.services.agent_exec import MAX_TIMEOUT_SECONDS, run_command
from app.services.api_key import Caller
from app.services.approvals import ApprovalRegistry
from app.storage.base import UserRecord


class _FakeRuntime:
    """运行期配置的假形状（只用到 ``get`` / ``set``）。"""

    def __init__(self, **values: object) -> None:
        self._values = {key: str(value) for key, value in values.items()}
        self.data_dir = Path(self._values.get("data_dir", "."))
        self.writes: list[dict[str, str]] = []

    def get(self, key: str) -> str:
        return self._values.get(key, "")

    def get_bool(self, key: str, default: bool = False) -> bool:
        return bool(self._values.get(key, default))

    def set(self, values: dict[str, str], **_kwargs: object) -> None:
        """与真实实现同一个语义：**写完立刻生效**（它那边是清掉读缓存）。"""
        self.writes.append(dict(values))
        self._values.update({key: str(value) for key, value in values.items()})


class _FakeServices:
    def __init__(self, **values: object) -> None:
        self.runtime = _FakeRuntime(**values)
        # 真实那条链路里它挂在 Services 上（见 core/services.py），
        # 执行器通过 ``services.approvals`` 登记待确认
        self.approvals = ApprovalRegistry()


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


def _no_run(monkeypatch) -> list[list[str]]:  # type: ignore[no-untyped-def]
    """盯着"有没有真的起进程"。返回一个列表，每真跑一次就多一条 argv。"""
    calls: list[list[str]] = []
    monkeypatch.setattr(
        isolation_service,
        "run_isolated",
        lambda argv, **kwargs: (
            calls.append(list(argv))
            or isolation_service.ExecutionResult(0, "ok\n", "", False, "bwrap")
        ),
    )
    return calls


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


def test_default_policy_asks_instead_of_running(workspace, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**默认档是 ask**：没配置过就执行，等于替用户点了那个头。

    v0.41 起这一档不再"拒绝并说清"，而是**登记一条待确认**停下来问用户；
    所以这里钉的是"什么都没跑，只多了一条等答案的登记"。
    """
    _available(monkeypatch)
    calls = _no_run(monkeypatch)
    outcome = run_command(workspace, _admin(), conversation_id=None, args={"command": "ls"})
    assert calls == [], "没有许可时一次都不许执行"
    assert outcome.ran is False
    request = outcome.approval
    assert request is not None, "ask 档要交给工具循环去问（见 tool_loop._resolve_approvals）"
    # 界面上要看见的：命令原文、写清在哪跑、以及"这类都允许"会落下哪条规则
    assert request.args == "ls"
    assert request.rule == "Bash(ls:*)"
    assert "隔离" in request.detail
    assert request.tool == "run_command"
    # 登记表里真的有这一条（端点会按这个 id 把决定送回来）
    assert workspace.approvals.decide(request.approval_id, approval_service.ALLOW_ONCE) is True


def test_allow_once_runs_the_command(workspace, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """用户点了「允许一次」：这一条真的跑起来，结果照常回给模型。"""
    _available(monkeypatch)
    calls = _no_run(monkeypatch)
    outcome = run_command(
        workspace, _admin(), conversation_id=None, args={"argv": ["ls", "-la"]},
        approval=approval_service.ALLOW_ONCE,
    )
    assert calls == [["ls", "-la"]]
    assert outcome.ran is True and outcome.ok is True
    assert "退出码：0" in outcome.text
    # 「允许一次」不该往清单里写任何东西：那正是它与「这类都允许」的区别
    assert workspace.runtime.writes == []


def test_allow_always_remembers_the_rule_and_stops_asking(workspace, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """「这类都允许」：**规则落进放行清单**，之后同类命令不再问。

    下半段（"不再问"）才是这个按钮的意义所在——只跑这一次的话它与「允许一次」没差别。
    """
    _available(monkeypatch)
    calls = _no_run(monkeypatch)
    first = run_command(
        workspace, _admin(), conversation_id=None,
        args={"command": "git status --short"},
        approval=approval_service.ALLOW_ALWAYS,
    )
    assert first.ran is True
    # 建议的是"这一族"而不是完整命令：下次参数不同也该认出它（suggest_rule 的口径）
    assert workspace.runtime._values["sandbox.rules_allow"] == "Bash(git:*)"
    # 第二条同类命令：**没有 approval，也不会冒出待确认**
    second = run_command(
        workspace, _admin(), conversation_id=None, args={"command": "git status --porcelain"}
    )
    assert second.approval is None
    assert second.ran is True
    assert len(calls) == 2
    # 别的族照旧要问（规则是"这一族"，不是"这个工具"）
    other = run_command(workspace, _admin(), conversation_id=None, args={"command": "rm -rf x"})
    assert other.approval is not None


def test_deny_refuses_with_the_same_doorway_out(workspace, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """用户点了「拒绝」：不执行，回给模型的话**仍要带那两条出路**。

    与老行为一致的部分：`_refused` 的摘要（"没有执行（策略拦下）"）、
    「设置 → 沙箱执行」这个人话路径、以及建议的放行规则。
    多出来的只有一句"对方拒绝了"——那句话必须准确，模型才知道别再重试这条。
    """
    _available(monkeypatch)
    calls = _no_run(monkeypatch)
    outcome = run_command(
        workspace, _admin(), conversation_id=None, args={"command": "ls"},
        approval=approval_service.DENY,
    )
    assert calls == []
    assert outcome.ran is False
    assert outcome.summary == "没有执行（策略拦下）"
    assert "拒绝" in outcome.text
    assert "sandbox.exec_policy" not in outcome.text  # 给用户看的是界面路径，不是配置键
    assert "设置 → 沙箱执行" in outcome.text
    assert "Bash(ls" in outcome.text


def test_timeout_is_a_refusal_and_says_nobody_answered(workspace, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**等不到人就按拒绝处理，而且要如实说是"没有回应"**。

    说成"对方拒绝了"会让模型以为对方看过并否了——它下一轮就会用完全错的措辞
    向用户复述（"你拒绝了这条命令"），而用户根本没看到那个问题。
    """
    _available(monkeypatch)
    calls = _no_run(monkeypatch)
    outcome = run_command(
        workspace, _admin(), conversation_id=None, args={"command": "ls"},
        approval=approval_service.TIMEOUT,
    )
    assert calls == []
    assert outcome.ran is False
    assert "没有回应" in outcome.text
    assert "拒绝" not in outcome.text  # 不把"没等到"说成"对方拒绝了"
    assert "Bash(ls" in outcome.text


def test_a_link_without_a_ui_keeps_the_old_behaviour(workspace, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """没有人可以问的链路（定时任务）：仍然是"拒绝并说清"，且**不说成对方拒绝了**。"""
    _available(monkeypatch)
    calls = _no_run(monkeypatch)
    outcome = run_command(
        workspace, _admin(), conversation_id=None, args={"command": "ls"},
        approval=approval_service.UNAVAILABLE,
    )
    assert calls == []
    assert "没有人可以确认" in outcome.text
    assert "设置 → 沙箱执行" in outcome.text


def test_unknown_decision_never_means_allow(workspace, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """没见过的取值**一律当没许可**：这条路放行必须是明确的。"""
    _available(monkeypatch)
    calls = _no_run(monkeypatch)
    outcome = run_command(
        workspace, _admin(), conversation_id=None, args={"command": "ls"}, approval="yes-please"
    )
    assert calls == []
    assert outcome.ran is False


def test_isolation_is_checked_before_asking(workspace, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """没有隔离就**不问了**：问了也跑不了的事不该让对方白点一次。

    这一条钉的是顺序（隔离排在"问用户"之前）——反过来的话用户会点一次同意，
    然后拿到的还是"这台机器上跑不了"。
    """
    monkeypatch.setattr(
        agent_exec, "_detect", lambda force=False: isolation_service.detect(prefer="none")
    )
    outcome = run_command(workspace, _admin(), conversation_id=None, args={"command": "ls"})
    assert outcome.approval is None
    assert "没有可用的内核级隔离" in outcome.text


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
