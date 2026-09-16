"""内核级执行隔离（v0.16）。

镜像同构：``app/services/isolation.py`` → 本文件。

分成两半测，因为这两半的**可测性完全不同**：

- **argv 构造**是纯函数，任何平台都能断言。而它恰好是最容易写错、又最不容易发现的地方
  ——少挂一个 ``--bind`` 工作区就变成只读；忘了 ``--unshare-net`` 它就还能联网。
  这些错误在真机上也很难发现（"命令跑通了"和"命令在隔离里跑通了"看起来一样）。
- **能力探测与拒绝**要真去盘上看。这台 Windows 机器上没有 bwrap / sandbox-exec /
  docker，所以 `detect()` 应该如实报 none，而"要求隔离却不给"必须**拒绝执行**，
  不能退化成裸跑。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from app.core.exceptions import InvalidRequestError, UnsupportedContentError
from app.services import isolation as iso


def _fake(backend: str) -> iso.Isolation:
    return iso.Isolation(backend=backend, available=True, detail="测试用")


# ------------------------------------------------------------------ 探测


def test_detect_reports_something_without_raising() -> None:
    """探测**永远不能抛**：它在启动路径与接口上都被调用，
    一台没有任何隔离工具的机器是常见情况，不是异常情况。"""
    found = iso.detect()

    assert found.backend in (
        iso.BACKEND_BWRAP,
        iso.BACKEND_SEATBELT,
        iso.BACKEND_DOCKER,
        iso.BACKEND_NONE,
    )
    assert found.detail


def test_detect_with_none_backend_is_unavailable_but_explains() -> None:
    """没有任何后端时，``detail`` 要**说清怎么办**（装什么），
    而不只是"不可用"。用户看到那句话才知道下一步做什么。"""
    found = iso.detect()

    if found.backend == iso.BACKEND_NONE:
        assert found.available is False
        assert "bubblewrap" in found.detail or "docker" in found.detail


def test_detect_prefers_the_requested_backend_when_available() -> None:
    """``prefer`` 指定的后端不可用时要**回落**（而不是直接报没有隔离），
    但回落这件事得能从结果上看出来。"""
    found = iso.detect(prefer=iso.BACKEND_SEATBELT)

    # 在非 macOS 上它一定回落；在 macOS 上它就用 seatbelt
    assert found.backend in (
        iso.BACKEND_SEATBELT,
        iso.BACKEND_BWRAP,
        iso.BACKEND_DOCKER,
        iso.BACKEND_NONE,
    )


# -------------------------------------------------------------- argv 构造


def test_bwrap_plan_binds_a_restricted_view_and_both_writable_dirs(tmp_path: Path) -> None:
    r"""**挂载策略是这一层最要紧的决定**：

    - 只挂**运行所需的目录**（QwenPaw 说的 *restricted filesystem view*），
      **不挂整个 ``/``**：没挂上的路径在沙箱里根本不存在。挂整个根（哪怕只读）
      意味着 ``/etc/passwd``、``~/.ssh`` 还在视野里——而"能读"本身就可能
      是事故（读走凭据不需要写权限）；
    - 工作区与沙箱**各挂一次读写**（缺工作区 = 干不了活；缺沙箱 = 试错的地方写不了）。

    用 ``tmp_path`` 而不是字面量路径：断言不该只在某个平台上成立。
    """
    work = tmp_path / "work"
    box = tmp_path / "box"
    plan = iso.build_plan(
        ["python", "-c", "print(1)"],
        workspace_root=work,
        sandbox_dir=box,
        isolation=_fake(iso.BACKEND_BWRAP),
    )

    argv = plan.argv
    joined = " ".join(argv)
    assert argv[0] == "bwrap"
    # 不再有"整个 / 只读"这一条
    assert "--ro-bind / /" not in joined
    assert f"--bind {work} {work}" in joined
    assert f"--bind {box} {box}" in joined
    assert "--tmpfs /tmp" in joined
    # 命令本身必须原样跟在 `--` 之后（否则会被 bwrap 当成自己的参数吃掉）
    assert argv[-5:] == ["--unshare-net", "--", "python", "-c", "print(1)"]


def test_default_bind_list_excludes_etc_and_home() -> None:
    """默认清单**故意不含 ``/etc`` 整体与家目录**：口令文件、sudoers、``~/.ssh``
    都在那里，而它们与"跑一条命令"无关。需要时由部署方显式加。"""
    assert "/etc" not in iso.DEFAULT_BIND_RO
    assert not any(
        path.startswith("/home") or path.startswith("/root") for path in iso.DEFAULT_BIND_RO
    )
    assert "/usr" in iso.DEFAULT_BIND_RO


def test_bind_list_can_be_overridden(tmp_path: Path) -> None:
    """部署方可以显式放权（如某个工具链目录）：那是一次**看得见的**动作，
    而不是"默认就什么都能看"。

    用一个**真的存在**的临时目录：不存在的路径会被跳过（bwrap 遇到不存在的源会
    直接失败，那会让整个沙箱不可用），所以拿一个字面量路径断言会因为平台而红。
    """
    toolchain = tmp_path / "toolchain"
    toolchain.mkdir()

    plan = iso.build_plan(
        ["ls"],
        workspace_root=tmp_path / "w",
        sandbox_dir=tmp_path / "s",
        isolation=_fake(iso.BACKEND_BWRAP),
        bind_ro=(str(toolchain),),
    )

    assert f"--ro-bind {toolchain} {toolchain}" in " ".join(plan.argv)


def test_nonexistent_bind_is_skipped(tmp_path: Path) -> None:
    """清单是跨发行版通用的，某个目录在某台机器上不存在很正常——
    跳过它，而不是让整个沙箱起不来。"""
    plan = iso.build_plan(
        ["ls"],
        workspace_root=tmp_path / "w",
        sandbox_dir=tmp_path / "s",
        isolation=_fake(iso.BACKEND_BWRAP),
        bind_ro=(str(tmp_path / "不存在"),),
    )

    assert "--ro-bind" not in " ".join(plan.argv)


def test_bind_paths_from_settings_text() -> None:
    assert iso.bind_paths_from("/opt/a, /opt/b") == ("/opt/a", "/opt/b")
    assert iso.bind_paths_from("/a\n/b") == ("/a", "/b")
    # 空 = 用默认清单（**不给"挂整个 /"这个选项**：那正是要避免的形态）
    assert iso.bind_paths_from("") is None
    assert iso.bind_paths_from("   ") is None


def test_bwrap_disables_network_by_default(tmp_path: Path) -> None:
    """**默认断网**：Agent 跑的命令绝大多数不需要网络，
    而"能联网"是数据外泄那条路上最省事的一环。"""
    plan = iso.build_plan(
        ["ls"],
        workspace_root=tmp_path / "w",
        sandbox_dir=tmp_path / "s",
        isolation=_fake(iso.BACKEND_BWRAP),
    )

    assert "--unshare-net" in plan.argv


def test_bwrap_can_opt_into_network(tmp_path: Path) -> None:
    """要联网时必须**显式**要，而且只在这一次调用上生效。"""
    plan = iso.build_plan(
        ["curl", "https://example.test"],
        workspace_root=tmp_path / "w",
        sandbox_dir=tmp_path / "s",
        allow_network=True,
        isolation=_fake(iso.BACKEND_BWRAP),
    )

    assert "--unshare-net" not in plan.argv
    assert "允许联网" in plan.detail


def test_seatbelt_profile_denies_by_default(tmp_path: Path) -> None:
    """Seatbelt 的规则必须是**白名单**：``deny default`` 之后逐条放行。

    写成黑名单（默认放行、禁掉几个目录）等于没有隔离——总会有没想到的路径。
    """
    work = tmp_path / "proj"
    box = tmp_path / "box"
    plan = iso.build_plan(
        ["python", "x.py"],
        workspace_root=work,
        sandbox_dir=box,
        isolation=_fake(iso.BACKEND_SEATBELT),
    )

    profile = plan.argv[2]
    assert plan.argv[:2] == ["sandbox-exec", "-p"]
    assert "(deny default)" in profile
    assert f'(subpath "{work}")' in profile
    assert f'(subpath "{box}")' in profile
    assert "network" not in profile  # 默认不放开网络


def test_docker_plan_readonly_root_and_no_network(tmp_path: Path) -> None:
    """容器：根文件系统只读、只挂两个可写目录、默认断网。

    ``--read-only`` 不能省：不给它的话进程能在容器里乱写——虽然出不去，
    但"哪里是它该写的地方"就模糊了，而那道界线正是沙箱要划出来的东西。
    """
    work = tmp_path / "w"
    box = tmp_path / "s"
    plan = iso.build_plan(
        ["ls"],
        workspace_root=work,
        sandbox_dir=box,
        isolation=_fake(iso.BACKEND_DOCKER),
    )

    argv = plan.argv
    assert argv[:2] == ["docker", "run"]
    assert "--read-only" in argv
    assert "--network" in argv and argv[argv.index("--network") + 1] == "none"
    assert "-v" in argv
    joined = " ".join(argv)
    assert f"{work}:{work}" in joined and f"{box}:{box}" in joined
    # 镜像要在命令之前（docker 的语法：镜像后面才是容器里跑的命令）
    assert argv.index(iso.DOCKER_IMAGE) < argv.index("ls")


def test_docker_allows_network_when_asked(tmp_path: Path) -> None:
    plan = iso.build_plan(
        ["ls"],
        workspace_root=tmp_path / "w",
        sandbox_dir=tmp_path / "s",
        allow_network=True,
        isolation=_fake(iso.BACKEND_DOCKER),
    )

    assert plan.argv[plan.argv.index("--network") + 1] == "bridge"


def test_empty_command_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(InvalidRequestError):
        iso.build_plan(
            [],
            workspace_root=tmp_path / "w",
            sandbox_dir=tmp_path / "s",
            isolation=_fake(iso.BACKEND_BWRAP),
        )


def test_none_backend_plan_is_marked_unavailable(tmp_path: Path) -> None:
    """没有隔离时**照样构造出计划**，但标着不可用——
    调用方据此拒绝，而不是拿到一个看起来能跑的命令行。"""
    plan = iso.build_plan(
        ["ls"],
        workspace_root=tmp_path / "w",
        sandbox_dir=tmp_path / "s",
        isolation=iso.Isolation(iso.BACKEND_NONE, False, "没有隔离"),
    )

    assert plan.available is False
    assert plan.argv == ["ls"]  # 原样，没有隔离包装
    assert plan.detail == "没有隔离"


# -------------------------------------------------------------- 真的执行


def test_run_refuses_without_isolation(tmp_path: Path) -> None:
    """**没有隔离就拒绝执行**，不回退成裸跑。

    这条是整个模块的立场：回退会把"我们以为它在沙箱里"变成一个静默的假象，
    而那个假象比拒绝危险得多——用户会放心地让 Agent 跑东西，而它其实能碰整台机器。
    """
    with pytest.raises(UnsupportedContentError) as excinfo:
        iso.run_isolated(
            ["python", "-c", "print(1)"],
            workspace_root=tmp_path,
            sandbox_dir=tmp_path / "box",
            isolation=iso.Isolation(iso.BACKEND_NONE, False, "这台机器上没有隔离"),
        )

    assert "拒绝执行" in str(excinfo.value)


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="这台机器（Windows + 无 docker）没有可用的隔离后端，真跑那一条由 CI 的 Linux 覆盖",
)
def test_run_executes_inside_the_sandbox(tmp_path: Path) -> None:
    """有隔离时真跑一条命令，并确认它**看得见沙箱目录**（挂载生效了）。"""
    box = tmp_path / "box"
    box.mkdir()

    result = iso.run_isolated(
        ["python", "-c", "print('hello from sandbox')"],
        workspace_root=tmp_path,
        sandbox_dir=box,
        timeout=30,
    )

    assert result.ok, result
    assert "hello from sandbox" in result.stdout
    assert result.backend in (iso.BACKEND_BWRAP, iso.BACKEND_SEATBELT, iso.BACKEND_DOCKER)


def test_timeout_is_reported_not_raised() -> None:
    """超时要变成**结果**（``timed_out=True``）而不是异常：
    它是"这条命令跑太久"这个事实，调用方要能拿到半截输出。"""
    result = iso.ExecutionResult(
        exit_code=-1, stdout="", stderr="执行超过 20 秒，已终止", truncated=False,
        backend=iso.BACKEND_BWRAP, timed_out=True,
    )

    assert result.ok is False
    assert result.timed_out is True


def test_clip_truncates_long_output() -> None:
    """输出必须截断：一条 `ls -R /` 能产出几百 MB，而它们会原样进上下文
    （那是要按 token 付费的）。"""
    text, cut = iso._clip("x" * (iso.MAX_OUTPUT_CHARS + 100))

    assert cut is True
    assert len(text) < iso.MAX_OUTPUT_CHARS + 200
    assert "已截断" in text


def test_clip_keeps_short_output_untouched() -> None:
    text, cut = iso._clip("short")

    assert (text, cut) == ("short", False)
