"""沙箱端点（v0.16，设计见 ``docs/Agent-工作区与能力层设计-v0.1.md`` §4）。

两件事：**告诉界面这台机器上有什么隔离**、以及**在隔离里跑一条命令**。

**跑命令是这个产品里权限最大的一个动作**——它按设计就是"在你的机器上执行东西"。
所以三道闸一层不省：

1. **管理员专属**（``require_admin``）：它不是"读写知识库"级别的能力，
   而是"在这台机器上执行代码"。与设置页同一档；
2. **策略闸**（``ExecutionPolicy``）：``ask`` 时未确认回 409，界面确认后带
   ``approved=true`` 重调；``deny`` 直接 403；
3. **内核隔离**（``services/isolation.py``）：没有可用隔离后端时**拒绝执行**，
   不回退成裸跑。

第 3 条是最容易被"优化掉"的一条（"先让它能跑起来"），但它不能省：
没有它，前两道闸保护的只是"用户点了同意"，而用户同意的是"在一个沙箱里跑"。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.auth import require_admin
from app.api.v1.schemas import (
    SandboxCapabilityOut,
    SandboxExecIn,
    SandboxExecOut,
    SandboxPlanOut,
)
from app.core.services import Services, get_services
from app.services import isolation as isolation_service
from app.services.api_key import Caller
from app.services.sandbox import POLICY_ASK, ExecutionPolicy, sandbox_for

router = APIRouter(prefix="/sandbox", tags=["sandbox"])


@router.get("", response_model=SandboxCapabilityOut, summary="这台机器上的隔离能力")
def get_capability(
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_admin)],
) -> SandboxCapabilityOut:
    """**探测而不是假设**：真去盘上找 bwrap / sandbox-exec / docker，
    并检查 docker daemon 是否活着（装了 CLI 但 daemon 没起是最常见的假阳性）。

    界面据此显示当前状态；没有隔离时明说"执行会被拒绝"，
    而不是等用户点了执行再报错——那时他已经以为它能跑了。
    """
    found = isolation_service.detect()
    return SandboxCapabilityOut(
        backend=found.backend,
        available=found.available,
        detail=found.detail,
        max_output_chars=isolation_service.MAX_OUTPUT_CHARS,
        default_timeout_seconds=isolation_service.DEFAULT_TIMEOUT_SECONDS,
    )


@router.post("/plan", response_model=SandboxPlanOut, summary="看这条命令会被怎么隔离")
def preview_plan(
    payload: SandboxExecIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_admin)],
) -> SandboxPlanOut:
    """**只算不跑**：把隔离后的 argv 显示出来。

    给用户一条"我能核对"的路：他说不准要不要同意执行时，最需要的不是我们替他判断，
    而是看清楚到底会发生什么——`--unshare-net` 在不在、工作区有没有被挂成读写。
    """
    root, box = _paths(services, payload)
    plan = isolation_service.build_plan(
        payload.argv,
        workspace_root=root,
        sandbox_dir=box,
        allow_network=payload.allow_network,
    )
    return SandboxPlanOut(
        backend=plan.backend,
        available=plan.available,
        detail=plan.detail,
        argv=plan.argv,
        workdir=plan.workdir,
    )


@router.post("/exec", response_model=SandboxExecOut, summary="在隔离里执行一条命令")
def exec_command(
    payload: SandboxExecIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_admin)],
) -> SandboxExecOut:
    """策略闸 + 内核隔离都过了才真跑。

    ``ask`` 策略下第一次会拿到 **409**（"要先确认"）：界面据此弹确认框，
    确认后带 ``approved=true`` 再调一次。409 不是错误，是流程的一步。
    """
    root, box = _paths(services, payload)
    policy = ExecutionPolicy(mode=services.runtime.get("sandbox.exec_policy") or POLICY_ASK,
                             workspace_root=root)
    policy.require_allowed(approved=payload.approved, what="在沙箱里执行命令")

    result = isolation_service.run_isolated(
        payload.argv,
        workspace_root=root,
        sandbox_dir=box,
        timeout=payload.timeout_seconds or isolation_service.DEFAULT_TIMEOUT_SECONDS,
        allow_network=payload.allow_network,
    )
    return SandboxExecOut(
        exit_code=result.exit_code,
        stdout=result.stdout,
        stderr=result.stderr,
        truncated=result.truncated,
        timed_out=result.timed_out,
        backend=result.backend,
    )


def _paths(services: Services, payload: SandboxExecIn):  # type: ignore[no-untyped-def]
    """``(工作区根, 沙箱目录)``。

    - 给了 ``workspace_id`` → 用它登记的 ``root_path``（**Agent 干活的地方**），
      沙箱仍按会话/请求分（**试错的地方**）。两者的区分见设计文档 §4；
    - 没给 → 根取数据目录下的 ``sandbox`` 父目录，也就是"只在沙箱里跑，
      不碰任何真实工作区"。这是更保守的默认。
    """
    box = sandbox_for(services.runtime.data_dir, payload.session_id or "adhoc").ensure()
    if payload.workspace_id:
        workspace = services.workspaces.get(payload.workspace_id, user_id=None)
        return workspace_root_of(workspace.root_path), box
    return box.parent, box


def workspace_root_of(raw: str):  # type: ignore[no-untyped-def]
    """工作区记录里存的是**字符串**（创建时已规范化过），这里转回 ``Path``。"""
    from pathlib import Path

    return Path(raw)
