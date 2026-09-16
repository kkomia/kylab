"""内核级执行隔离（v0.16，设计见 ``docs/Agent-工作区与能力层设计-v0.1.md`` §4）。

``services/sandbox.py`` 管的是**路径与策略**（能不能碰、要不要确认）；
这个模块管的是**内核级隔离**（真跑起来之后，它到底能不能碰）。

三件事分层，缺一层都不够：

| 层 | 回答 | 在哪 |
| --- | --- | --- |
| 策略 | 要不要问用户 | ``sandbox.ExecutionPolicy`` |
| 路径 | 参数里能写哪些路径 | ``sandbox.resolve_in`` |
| **内核** | **进程真跑起来之后能碰什么** | 本模块 |

**为什么必须有第三层**：前两层都作用在"我们替它构造的参数"上。一条
``python -c "open('/etc/passwd').read()"`` 里没有任何路径参数要校验——
它会直接读到我们根本不知道它要读什么的地方。只有内核级的文件系统视图
（bwrap 的 bind mount、Seatbelt 的 profile、容器的 mount namespace）
能管住这一类。

**三个后端**（照 QwenPaw 的做法，一个平台一个）：

- Linux：**bubblewrap**——把整个 ``/`` 只读挂进来，再把工作区与沙箱**读写**挂上，
  ``/tmp`` 换成 tmpfs；需要断网时加 ``--unshare-net``。用户态、免 root、启动快；
- macOS：**sandbox-exec**——Seatbelt profile，``deny default`` 之后按目录放行读写；
- 任意平台：**Docker**——真正的内核隔离（namespace + cgroup），只要装了 docker 就能用。
  Windows 上没有前两个的原生等价物（AppContainer 要写一堆 Win32 调用，且不覆盖
  文件系统之外的边界），所以 **Docker 是 Windows 上唯一的真隔离路径**——
  这一点如实报出来，而不是假装"策略层就够了"。

**探测而不是假设**：``detect()`` 真去盘上找这些可执行文件（并检查 docker daemon
是否活着——装了 CLI 但 daemon 没起是最常见的假阳性）。界面与端点据此告诉用户
"这台机器上现在有什么"。**没有隔离时明确拒绝要隔离的执行**，不回退成裸跑：
回退会让"我们以为它在沙箱里"成为一个静默的假象，而这个假象比拒绝危险得多。
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from app.core.exceptions import InvalidRequestError, UnsupportedContentError

__all__ = [
    "BACKEND_BWRAP",
    "BACKEND_DOCKER",
    "BACKEND_NONE",
    "BACKEND_SEATBELT",
    "DEFAULT_BIND_RO",
    "ExecutionResult",
    "Isolation",
    "IsolationPlan",
    "bind_paths_from",
    "build_plan",
    "detect",
    "run_isolated",
]

logger = logging.getLogger(__name__)

BACKEND_BWRAP = "bwrap"
BACKEND_SEATBELT = "sandbox-exec"
BACKEND_DOCKER = "docker"
BACKEND_NONE = "none"

#: Linux 上**只读挂载**的目录：只挂"能把命令跑起来"的那些。
#:
#: 这是 QwenPaw 说的 *restricted filesystem view*：与其把整个 ``/`` 只读挂进来
#: （那样 ``/etc/passwd``、``~/.ssh`` 都还在视野里，只是不能写），
#: 不如**只挂运行时要用的**——没挂上的路径在沙箱里**根本不存在**。
#:
#: 抄这份清单时保留了"少而够用"的取舍：``/usr`` 与 ``/lib*`` 是解释器与依赖，
#: ``/bin`` ``/sbin`` 是系统命令，``/etc/ssl`` 给 TLS 证书（很多 CLI 起不来是因为它）。
#: **故意不含 ``/etc`` 整体**：口令文件、sudoers 都在那里，而它们与"跑一条命令"无关。
DEFAULT_BIND_RO: tuple[str, ...] = (
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc/ssl",
    "/etc/alternatives",
    "/etc/ld.so.cache",
)

#: Docker 镜像。**刻意用一个最小且可预测的**：隔离层不该顺带引入一个我们
#: 没审过的用户态环境。需要别的工具链时由部署方改这里。
DOCKER_IMAGE = "python:3.12-slim"

#: 单次执行的默认超时与输出上限。**两个都必须有**：
#: 一个 `yes` 能把内存吃光，一个死循环能挂到天荒地老。
DEFAULT_TIMEOUT_SECONDS = 20.0
MAX_OUTPUT_CHARS = 20_000


@dataclass(frozen=True, slots=True)
class Isolation:
    """这台机器上现在能用的隔离后端。"""

    backend: str
    available: bool
    detail: str
    """人话说明：为什么可用/不可用。界面直接显示它。"""

    @property
    def key(self) -> str:
        return self.backend


@dataclass(frozen=True, slots=True)
class IsolationPlan:
    """一次隔离执行的**命令行构造结果**（纯数据，可断言）。

    把它与"真的去跑"分开：argv 的构造是纯函数，能在任何平台上测——
    而"这台机器上真的隔离住了吗"只能在那台机器上测。
    """

    backend: str
    argv: list[str]
    workdir: str
    env: dict[str, str] = field(default_factory=dict)
    available: bool = True
    detail: str = ""


@dataclass(frozen=True, slots=True)
class ExecutionResult:
    exit_code: int
    stdout: str
    stderr: str
    truncated: bool
    backend: str
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out


def detect(*, prefer: str | None = None) -> Isolation:
    """探测可用的隔离后端。**真去盘上找，不假设**。

    ``prefer`` 可以指定优先用哪个（部署方知道自己的机器）；
    指定的那个不可用时**回落到自动探测**，而不是直接报"没有隔离"——
    但回落这件事要出现在 ``detail`` 里，好让界面能显示出来。
    """
    candidates = [prefer] if prefer else []
    candidates += [BACKEND_BWRAP, BACKEND_SEATBELT, BACKEND_DOCKER]
    tried: list[str] = []
    for name in candidates:
        if not name or name == BACKEND_NONE:
            continue
        if name in tried:
            continue
        tried.append(name)
        found = _probe(name)
        if found.available:
            return found
        logger.debug("隔离后端 %s 不可用：%s", name, found.detail)

    return Isolation(
        backend=BACKEND_NONE,
        available=False,
        detail=(
            "这台机器上没有可用的内核级隔离（Linux 需要 bubblewrap、macOS 需要 "
            "sandbox-exec、任意平台都可以用 Docker）。执行会被拒绝——"
            "不会退化成不带隔离地裸跑，那样「我们以为它在沙箱里」就成了一个假象。"
        ),
    )


def _probe(name: str) -> Isolation:
    if name == BACKEND_BWRAP:
        path = shutil.which("bwrap")
        if not path:
            return Isolation(name, False, "没有找到 bwrap（Linux 上装 bubblewrap 即可）")
        return Isolation(name, True, f"bubblewrap 就位：{path}")

    if name == BACKEND_SEATBELT:
        path = shutil.which("sandbox-exec")
        if not path:
            return Isolation(name, False, "没有找到 sandbox-exec（仅 macOS 有）")
        return Isolation(name, True, f"Seatbelt 就位：{path}")

    if name == BACKEND_DOCKER:
        path = shutil.which("docker")
        if not path:
            return Isolation(name, False, "没有找到 docker")
        # **装了 CLI 但 daemon 没起是最常见的假阳性**，所以真的问一次它。
        try:
            # S603：这里的 argv 是**我们自己拼的常量**（docker + 固定子命令），
            # 不含任何用户输入，也没有 shell=True —— bandit 只是看到 subprocess 就报。
            probe = subprocess.run(  # noqa: S603
                [path, "info", "--format", "{{.ServerVersion}}"],
                capture_output=True,
                text=True,
                timeout=8,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return Isolation(name, False, f"docker CLI 在，但连不上 daemon：{exc}")
        if probe.returncode != 0:
            reason = (probe.stderr or probe.stdout or "").strip().splitlines()
            return Isolation(
                name, False, f"docker daemon 没在跑：{reason[-1] if reason else '未知原因'}"
            )
        return Isolation(name, True, f"docker 就位（server {probe.stdout.strip()}）")

    return Isolation(name, False, f"未知的隔离后端：{name}")


def build_plan(
    argv: list[str],
    *,
    workspace_root: Path,
    sandbox_dir: Path,
    isolation: Isolation | None = None,
    allow_network: bool = False,
    bind_ro: tuple[str, ...] | None = None,
) -> IsolationPlan:
    """把一条命令包进隔离后端。

    **纯函数**（除了探测那一步），所以"argv 里到底有没有把工作区挂成读写、
    有没有断网"是能写成断言的——而这些恰恰是最容易写错、又最不容易发现的地方
    （少挂一个 ``--bind``，进程就只读；忘了 ``--unshare-net``，它就还能联网）。
    """
    chosen = isolation or detect()
    if not argv:
        raise InvalidRequestError("缺少要执行的命令")

    if chosen.backend == BACKEND_BWRAP:
        return _bwrap_plan(argv, workspace_root, sandbox_dir, allow_network, bind_ro)
    if chosen.backend == BACKEND_SEATBELT:
        return _seatbelt_plan(argv, workspace_root, sandbox_dir, allow_network)
    if chosen.backend == BACKEND_DOCKER:
        return _docker_plan(argv, workspace_root, sandbox_dir, allow_network)
    return IsolationPlan(
        backend=BACKEND_NONE,
        argv=list(argv),
        workdir=str(sandbox_dir),
        available=False,
        detail=chosen.detail,
    )


def _bwrap_plan(
    argv: list[str],
    workspace_root: Path,
    sandbox_dir: Path,
    allow_network: bool,
    bind_ro: tuple[str, ...] | None = None,
) -> IsolationPlan:
    """bubblewrap：**限定文件系统视图** + 工作区与沙箱读写 + ``/tmp`` 是 tmpfs。

    挂载策略是这一层最要紧的决定，而它有两种写法，差别很大：

    - ``--ro-bind / /``（整个根只读）：命令一定跑得起来，但 ``/etc/passwd``、
      ``~/.ssh``、别人的项目都**还在视野里**——只是不能写。而"能读"本身就可能
      是事故（读走凭据不需要写权限）。
    - **只挂运行所需的目录**（采用）：没挂上的路径在沙箱里**根本不存在**。
      代价是可能缺某个工具要的文件——那时命令跑不起来，用户看到的是
      "缺文件"，而不是"文件被读了"。**两害相权，取"跑不起来"**。

    这正是 QwenPaw 说的 *restricted filesystem view*。清单在
    ``DEFAULT_BIND_RO``，可通过设置扩展（见 ``sandbox.bind_ro``）。
    """
    paths = bind_ro if bind_ro is not None else DEFAULT_BIND_RO
    parts = ["bwrap", "--dev", "/dev", "--proc", "/proc"]
    # 只挂**存在**的那些：清单是跨发行版通用的，某个目录在某台机器上不存在很正常，
    # 而 bwrap 遇到不存在的源会直接失败（那会让整个沙箱不可用）。
    for path in paths:
        if Path(path).exists():
            parts += ["--ro-bind", path, path]
    parts += [
        "--tmpfs",
        "/tmp",  # noqa: S108 - 这是沙箱**里面**的 tmpfs，不是宿主机的临时目录
        # 工作区读写：这是"在哪儿干活"
        "--bind",
        str(workspace_root),
        str(workspace_root),
        # 沙箱读写：这是"试错的地方"
        "--bind",
        str(sandbox_dir),
        str(sandbox_dir),
        "--die-with-parent",
        "--chdir",
        str(sandbox_dir),
    ]
    if not allow_network:
        # 断网：默认就断。Agent 跑的命令绝大多数不需要网络，
        # 而"能联网"是数据外泄那条路上最省事的一环。
        parts.append("--unshare-net")
    parts += ["--", *argv]
    return IsolationPlan(
        backend=BACKEND_BWRAP,
        argv=parts,
        workdir=str(sandbox_dir),
        available=True,
        detail="bubblewrap：只挂运行所需目录（限定视图），工作区与沙箱读写"
        + ("，已断网" if not allow_network else "，允许联网"),
    )


def _seatbelt_plan(
    argv: list[str], workspace_root: Path, sandbox_dir: Path, allow_network: bool
) -> IsolationPlan:
    """macOS Seatbelt：``deny default`` 之后按目录放行。

    规则是**白名单**：默认全拒，逐条放行。写成黑名单（默认放行、禁掉几个目录）
    等于没有隔离——总会有没想到的路径。
    """
    allow = [
        "(allow file-read*)",
        f'(allow file-write* (subpath "{workspace_root}") (subpath "{sandbox_dir}"))',
        "(allow process-exec)",
        "(allow sysctl-read)",
        # 只读的 /dev 与 /tmp 下的临时文件：没有它们连解释器都起不来
        "(allow file-read* file-write* (subpath \"/private/tmp\"))",
    ]
    if allow_network:
        allow.append("(allow network*)")
    profile = "(version 1)(deny default)" + "".join(allow)
    return IsolationPlan(
        backend=BACKEND_SEATBELT,
        argv=["sandbox-exec", "-p", profile, *argv],
        workdir=str(sandbox_dir),
        available=True,
        detail="Seatbelt：默认全拒，只放行工作区与沙箱的写"
        + ("，允许联网" if allow_network else "，已断网"),
    )


def _docker_plan(
    argv: list[str], workspace_root: Path, sandbox_dir: Path, allow_network: bool
) -> IsolationPlan:
    """Docker：挂载工作区与沙箱，``--network none`` 断网。

    两处刻意的参数：

    - ``--read-only`` + ``--tmpfs``：容器根文件系统只读，可写的只有明确挂进来的
      两个目录与一个内存 tmpfs。不给 ``--read-only`` 的话，进程能在容器里乱写，
      虽然出不去，但"哪里是它该写的地方"就模糊了；
    - ``--network none``：与 bwrap 的 ``--unshare-net`` 同理。
    """
    parts = [
        "docker",
        "run",
        "--rm",
        "--read-only",
        "--tmpfs",
        "/tmp",  # noqa: S108 - 同上：容器内的 tmpfs
        # 工作区读写：与 bwrap 那份一一对应，三种后端的行为要一致
        "-v",
        f"{workspace_root}:{workspace_root}",
        "-v",
        f"{sandbox_dir}:{sandbox_dir}",
        "-w",
        str(sandbox_dir),
        "--network",
        "none" if not allow_network else "bridge",
        DOCKER_IMAGE,
        *argv,
    ]
    return IsolationPlan(
        backend=BACKEND_DOCKER,
        argv=parts,
        workdir=str(sandbox_dir),
        available=True,
        detail=f"docker（{DOCKER_IMAGE}）：根只读，工作区与沙箱读写"
        + ("，已断网" if not allow_network else "，允许联网"),
    )


def run_isolated(
    argv: list[str],
    *,
    workspace_root: Path,
    sandbox_dir: Path,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    allow_network: bool = False,
    isolation: Isolation | None = None,
    bind_ro: tuple[str, ...] | None = None,
) -> ExecutionResult:
    """在隔离里跑一条命令。

    **没有可用隔离时拒绝执行**（抛 ``UnsupportedContentError``），不回退成裸跑：
    回退会把"我们以为它在沙箱里"变成一个静默的假象，而那个假象比拒绝危险得多
    ——用户会放心地让 Agent 跑东西，而它其实能碰整台机器。
    """
    plan = build_plan(
        argv,
        workspace_root=workspace_root,
        sandbox_dir=sandbox_dir,
        isolation=isolation,
        allow_network=allow_network,
        bind_ro=bind_ro,
    )
    if not plan.available:
        raise UnsupportedContentError(
            f"这台机器上没有可用的内核级隔离，拒绝执行：{plan.detail}"
        )

    sandbox_dir.mkdir(parents=True, exist_ok=True)
    try:
        # S603：整条链路就是为了"在隔离里执行用户要跑的命令"而存在的，
        # 而且传的是**数组**（没有 shell 解析），并被隔离后端包着——
        # 这正是本模块的职责，不是注入面。见模块头的三层说明。
        finished = subprocess.run(  # noqa: S603
            plan.argv,
            cwd=str(sandbox_dir),
            capture_output=True,
            text=True,
            timeout=timeout,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(sandbox_dir)},
        )
    except subprocess.TimeoutExpired as exc:
        return ExecutionResult(
            exit_code=-1,
            stdout=_cap(exc.stdout),
            stderr=f"执行超过 {timeout:g} 秒，已终止" + _tail(exc.stderr),
            truncated=False,
            backend=plan.backend,
            timed_out=True,
        )
    except OSError as exc:
        raise UnsupportedContentError(f"起不了隔离进程（{plan.backend}）：{exc}") from exc

    stdout, cut_out = _clip(finished.stdout)
    stderr, cut_err = _clip(finished.stderr)
    return ExecutionResult(
        exit_code=finished.returncode,
        stdout=stdout,
        stderr=stderr,
        truncated=cut_out or cut_err,
        backend=plan.backend,
    )


def _cap(value: object) -> str:
    return value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value or "")


def _tail(value: object) -> str:
    text = _cap(value)
    return f"\n{text[-2000:]}" if text else ""


def _clip(text: str) -> tuple[str, bool]:
    """输出截断。**必须截**：一条 `ls -R /` 能产出几百 MB，
    而它们会原样进上下文（那是要按 token 付费的）。"""
    if len(text) <= MAX_OUTPUT_CHARS:
        return text, False
    return text[:MAX_OUTPUT_CHARS] + f"\n…（已截断，共 {len(text)} 字）", True


def bind_paths_from(raw: str) -> tuple[str, ...] | None:
    """把设置里那串逗号/换行分隔的路径解析成只读挂载清单。

    空字符串 → ``None``（用 :data:`DEFAULT_BIND_RO` 的默认清单）。
    **不给"挂整个 /"这个选项**：那正是这一层想避免的形态；
    真需要某个目录时把它加进来（如 ``/opt/toolchain``），
    那是一次明确的、看得见的放权。
    """
    if not raw or not raw.strip():
        return None
    parts = [item.strip() for item in re.split(r"[,\n]", raw) if item.strip()]
    return tuple(parts) or None
