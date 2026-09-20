"""执行：把沙箱端点的那套闸接到**模型能调的工具**上（v0.33）。

`api/v1/sandbox.py` 那条路是"用户自己点一条命令去跑"；这一条是"模型想跑"。
三道闸一层不省，与端点同源：

| 闸 | 在哪 | 不通过时 |
| --- | --- | --- |
| 权限 | ``Caller.is_admin`` | 拒绝，并说明执行只对管理员开放 |
| 策略 | ``command_policy`` 的规则 + ``sandbox.exec_policy`` 总开关 | 拒绝，并说明怎么放开 |
| 内核隔离 | ``isolation.detect()`` / ``run_isolated`` | 拒绝——**不回退成裸跑** |

**与端点唯一实质的差别：``ask`` 这一档在这里是"拒绝并说清"而不是"停下来问"。**
对话是一条**拉取式**的生成器：事件由上层一个个取走，"问用户"要求在这一步先把
已发生的事件送出去、再阻塞等人回答，拉取式做不到（实测过那个死锁的形状，
见 ``agent_tools._call_mcp`` 里同一段说明）。所以这里的取舍与外部工具那层一致：
**宁可"这轮用不了、并说清怎么打开"，也不要静默执行**——用户给过的"允许"才是允许，
我们不会替他点这个头。默认档就是 ``ask``，所以"接上就能跑命令"这件事不会发生。
"""

from __future__ import annotations

import logging
import shlex
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from app.core.exceptions import InvalidRequestError
from app.services import isolation as isolation_service
from app.services.agent_files import Roots, describe_roots, resolve_roots
from app.services.api_key import Caller
from app.services.command_policy import (
    ACTION_ALLOW,
    ACTION_DENY,
    rules_from_runtime,
    suggest_rule,
    tool_arguments,
)
from app.services.sandbox import POLICY_ASK, POLICY_DENY, sandbox_for

if TYPE_CHECKING:
    # 只为类型标注：**运行时不导入**，免得与组合根（core.services）成环
    from app.core.services import Services

__all__ = ["MAX_TIMEOUT_SECONDS", "ExecOutcome", "run_command"]

logger = logging.getLogger(__name__)

#: 模型可以要求的超时上限（秒）。默认取隔离层自己的 20 秒。
#:
#: 为什么给到 60：跑一次构建、装一次依赖确实要更久。为什么**不给更多**：
#: 整轮还有墙钟闸（``tool_loop.DEFAULT_MAX_SECONDS`` = 300 秒），而同一批里的
#: 几条命令是并发的——允许单条跑几百秒，等于让这一轮的其余部分全被它拖住。
MAX_TIMEOUT_SECONDS = 60

#: 隔离探测的缓存时长（秒）。``detect()`` 在装了 docker 的机器上会**真的去问一次
#: daemon**（那是一次子进程调用），而它每个 run_command 都要用一次。缓存 30 秒是
#: 一个折中：一轮对话里不会重复探测，而"刚装完 docker"最迟半分钟就能用上，
#: 不必重启进程。设置页那个能力端点不走这里，它每次都真探（那是用户主动点"看看现在有什么"）。
_ISOLATION_TTL_SECONDS = 30.0

_cached_isolation: tuple[float, isolation_service.Isolation] | None = None


@dataclass(frozen=True, slots=True)
class ExecOutcome:
    """一次执行的结果（或"为什么没执行"）。"""

    ok: bool
    """真的跑起来了且退出码为 0。**没执行也是 False**——两者在界面上要分开显示。"""
    text: str
    """回给模型的文本（跑成了是输出，没跑成是原因 + 怎么放开）。"""
    summary: str
    """过程面板上那一行。"""
    ran: bool = False
    """是否真的起了进程。``False`` 时 ``exit_code`` 无意义。"""
    exit_code: int | None = None


def _detect(*, force: bool = False) -> isolation_service.Isolation:
    global _cached_isolation
    now = time.monotonic()
    if not force and _cached_isolation is not None:
        stamp, found = _cached_isolation
        if now - stamp < _ISOLATION_TTL_SECONDS:
            return found
    found = isolation_service.detect()
    _cached_isolation = (now, found)
    return found


def run_command(
    services: Services,
    caller: Caller,
    *,
    conversation_id: str | None,
    args: dict[str, object],
) -> ExecOutcome:
    """跑一条命令（或说清为什么不跑）。"""
    argv = _argv_of(args)
    timeout = _timeout_of(args)
    allow_network = bool(args.get("allow_network") is True)

    # 闸 1：权限。**与端点同一档**（require_admin）：它不是"读写知识库"级别的能力，
    # 而是"在这台机器上执行代码"。成员账号的模型不该绕过它。
    if not caller.is_admin:
        return ExecOutcome(
            ok=False,
            ran=False,
            text=(
                "执行命令只对管理员开放，当前是成员账号，这一轮没有执行。"
                "需要的话请把这件事告诉对方（换管理员账号，或者让他自己跑）。"
            ),
            summary="成员账号不能执行命令",
        )

    # 闸 2：策略。deny 优先（规则或总开关），命中 allow 才是放行；
    # 没命中规则就用总开关——与端点的判定顺序逐条对齐（那里有两段说明为什么）。
    decision = rules_from_runtime(services.runtime, source="执行").decide(
        "Bash", tool_arguments(argv)
    )
    global_mode = services.runtime.get("sandbox.exec_policy") or POLICY_ASK
    if decision.action == ACTION_DENY:
        return _refused(f"这条命令被拒绝规则拦下：{decision.reason}。换一条路，不要重试这条。")
    if global_mode == POLICY_DENY:
        return _refused(
            "执行的策略是「拒绝执行」（设置 → 沙箱执行）。"
            "请如实告诉对方：要让我能跑命令，得先把那一项改成「需要确认」或「允许」。"
        )
    # **命中规则时规则说了算，没命中才用总开关**（与端点逐条对齐）：
    # 少了这半句，"总开关设成允许"这件事会变成 no-op——用户改完照样被拒，
    # 而界面上写着"允许"，那种不一致最难查（第一版就是这么错的，用例抓住了）。
    mode = decision.action if decision.rule is not None else global_mode
    if mode != ACTION_ALLOW:
        rule = suggest_rule("Bash", tool_arguments(argv)).describe()
        return _refused(
            "执行需要对方先确认，**这一轮没有执行**。"
            "请如实告诉对方：要让我跑命令，得先把「设置 → 沙箱执行」的策略改成「允许」，"
            f"或者在放行清单里加一行 `{rule}`（加完只放行这一族命令，其它仍然要确认）。"
            "**不要假装执行过，也不要凭猜测编造命令的输出。**"
        )

    # 闸 3：内核隔离。没有可用后端就**拒绝**，不回退成裸跑（见 isolation 模块头）。
    found = _detect()
    if not found.available:
        return ExecOutcome(
            ok=False,
            ran=False,
            text=(
                "这台机器上没有可用的内核级隔离，按纪律拒绝执行（不会退化成不带隔离地裸跑）。"
                f"{found.detail}请把这一点如实告诉对方；需要跑命令的话，"
                "要在部署这台服务的机器上装 Docker（或 Linux 上的 bubblewrap）。"
            ),
            summary="这台机器没有隔离，拒绝执行",
        )

    roots = resolve_roots(services, conversation_id=conversation_id, caller=caller)
    box, root = _roots_for_run(services, roots, conversation_id)
    try:
        result = isolation_service.run_isolated(
            argv,
            workspace_root=root,
            sandbox_dir=box,
            timeout=timeout,
            allow_network=allow_network,
            isolation=found,
            bind_ro=isolation_service.bind_paths_from(services.runtime.get("sandbox.bind_ro")),
        )
    except Exception as exc:
        logger.info("隔离执行失败：%s", exc)
        return ExecOutcome(
            ok=False,
            ran=False,
            text=f"命令没能跑起来：{exc}",
            summary="命令没能跑起来",
        )

    return ExecOutcome(
        ok=result.ok,
        ran=True,
        exit_code=result.exit_code,
        text=_render(argv, result, roots=roots, allow_network=allow_network, timeout=timeout),
        summary=_summary(result),
    )


def _roots_for_run(
    services: Services, roots: Roots, conversation_id: str | None
) -> tuple[Path, Path]:
    """``(沙箱目录, 隔离里当"工作区"挂的那个根)``。

    **没挂工作区时根就是沙箱自己**，而不是 ``data/sandbox`` 这一层：那一层里
    装着**其它会话**的沙箱（端点的默认值是它，因为那条路没有会话），
    挂进去等于让这一轮的模型能读到别人的试错目录。
    """
    box = sandbox_for(services.runtime.data_dir, conversation_id or "adhoc").ensure()
    return box, (roots.workspace or box)


def _argv_of(args: dict[str, object]) -> list[str]:
    """取命令。``argv`` 优先（数组，不做任何解析）；只给了 ``command`` 字符串时
    用 ``shlex`` 拆一次，并把拆出来的结果回显给模型——拆错了它下一轮能自己改。

    执行侧用的一律是**数组**（``subprocess`` 不走 shell）：这是端点的口径，
    也是这里唯一的口径。字符串进来只是为了让模型少踩一次"参数形状不对"。
    """
    raw = args.get("argv")
    if isinstance(raw, list) and raw:
        argv = [str(item) for item in raw]
    else:
        text = str(args.get("command") or "").strip()
        if not text:
            raise InvalidRequestError("缺少参数：command（或用 argv 给一个数组）")
        try:
            argv = shlex.split(text)
        except ValueError as exc:
            raise InvalidRequestError(f"命令拆不开：{exc}") from exc
    if not argv or any(not item for item in argv):
        raise InvalidRequestError("命令是空的")
    if len(argv) > 64:
        raise InvalidRequestError("参数太多了（上限 64 个）")
    return argv


def _timeout_of(args: dict[str, object]) -> float:
    raw = args.get("timeout_seconds")
    try:
        value = float(raw) if raw is not None else isolation_service.DEFAULT_TIMEOUT_SECONDS
    except (TypeError, ValueError):
        raise InvalidRequestError("timeout_seconds 要是数字") from None
    if value <= 0:
        raise InvalidRequestError("timeout_seconds 要大于 0")
    return min(value, float(MAX_TIMEOUT_SECONDS))


def _refused(reason: str) -> ExecOutcome:
    return ExecOutcome(ok=False, ran=False, text=reason, summary="没有执行（策略拦下）")


def _summary(result: isolation_service.ExecutionResult) -> str:
    if result.timed_out:
        return "命令超时被终止"
    lines = len([item for item in result.stdout.splitlines() if item.strip()])
    head = "跑完了" if result.ok else f"退出码 {result.exit_code}"
    return f"{head} · 输出 {lines} 行" if lines else head


def _render(
    argv: list[str],
    result: isolation_service.ExecutionResult,
    *,
    roots: Roots,
    allow_network: bool,
    timeout: float,
) -> str:
    """给模型看的执行结果。

    **四样东西每次都要有**：命令（它自己写的，回显一遍便于它确认拆对了）、
    退出码、标准输出、标准错误。少了标准错误，"命令没输出"与"命令失败了"
    在它眼里就是同一件事。
    """
    parts = [
        f"$ {' '.join(argv)}",
        f"（在隔离里执行：{result.backend}；cwd = 沙箱目录；"
        f"工作区{'已挂载' if roots.workspace else '未挂载'}；"
        f"{'允许联网' if allow_network else '已断网'}；超时 {timeout:g} 秒）",
    ]
    if result.timed_out:
        parts.append(
            f"命令超过 {timeout:g} 秒被终止。要跑更久的事，请把它拆小，或者告诉对方改超时。"
        )
    parts.append(f"退出码：{result.exit_code}")
    parts.append(f"标准输出：\n{result.stdout}" if result.stdout.strip() else "标准输出：（空）")
    if result.stderr.strip():
        parts.append(f"标准错误：\n{result.stderr}")
    if result.truncated:
        parts.append(f"（输出超过 {isolation_service.MAX_OUTPUT_CHARS} 字已截断）")
    parts.append(describe_roots(roots))
    return "\n\n".join(parts)
