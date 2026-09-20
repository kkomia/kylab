"""工作区端点（v0.15，设计见 ``docs/设计/Agent-工作区与能力层设计-v0.1.md``）。

工作区是 **Agent 的项目**：一个用户指定的根目录 + 一组知识库。
它把"这个 Agent 在哪儿干活、能查哪些资料"这两件事绑在一起。

**归属口径与知识库 / 会话完全一致**（``api/auth.py`` 的 ``check_kb_scope`` 同一套）：
普通成员只看得到自己的工作区，越权与不存在都回 **404**——403 会暴露"这个 id 存在"。

`root_path` 是这一组端点里唯一的安全边界（Agent 的文件操作会落在那里），
它的校验在 ``services/workspace.py::validate_root_path``，这里只做协议层转发。
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from app.api.auth import require_admin, require_read, require_write
from app.api.v1.schemas import (
    DirectoryEntryOut,
    WorkspaceBrowseOut,
    WorkspaceCreateIn,
    WorkspaceListOut,
    WorkspaceOut,
    WorkspaceUpdateIn,
)
from app.core.services import Services, get_services
from app.services.api_key import Caller

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


def _owner(caller: Caller) -> str | None:
    """归属过滤用：只有**普通成员**会话才有归属；管理员与 API Key 通道没有。

    与 ``api/v1/notes.py::_owner``、``api/v1/conversations.py::_caller_owner``
    同一口径。三处各写一份是因为它们分属三个模块，但判定必须一致——
    `test_visibility_api` 那组用例正是钉这件事。
    """
    if caller.user is not None and not caller.is_admin:
        return caller.user.id
    return None


def _out(record, conversation_count: int) -> WorkspaceOut:  # type: ignore[no-untyped-def]
    return WorkspaceOut(
        id=record.id,
        name=record.name,
        root_path=record.root_path,
        description=record.description,
        kb_ids=list(record.kb_ids),
        conversation_count=conversation_count,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


@router.get("", response_model=WorkspaceListOut, summary="工作区列表")
def list_workspaces(
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
) -> WorkspaceListOut:
    views = services.workspaces.list(user_id=_owner(caller))
    return WorkspaceListOut(items=[_out(view.record, view.conversation_count) for view in views])


@router.get(
    "/browse",
    response_model=WorkspaceBrowseOut,
    summary="浏览服务器上的目录（选工作区根目录用）",
)
def browse_directories(
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_admin)],
    path: str | None = Query(default=None, description="要看哪个目录；留空 = 从家目录开始"),
) -> WorkspaceBrowseOut:
    """**管理员专属**：它列的是**服务器上**的目录树。

    这条与"设置页只认管理员"同一档：目录名本身就是信息（谁的项目叫什么、
    备份放在哪、有哪些账号的家目录），而成员建工作区本来就只需要填一个路径。
    换句话说是**不给它扩权**——能浏览不改变"能不能当工作区"的判定，
    那条判定只有一份（``workspaces.root_path_problem``）。

    只列**目录**；数据目录会出现在列表里但标着不可选与原因（不藏起来：
    静默省略会让人以为"这里没有它"，而他找的可能正是它旁边那个）。
    """
    view = services.workspaces.browse(path)
    return WorkspaceBrowseOut(
        path=view.path,
        current=DirectoryEntryOut(**asdict(view.current)),
        parent=view.parent,
        # `dataclasses.asdict` 而不是 `vars`：`DirectoryEntry` 是 slots 数据类，没有 `__dict__`
        entries=[DirectoryEntryOut(**asdict(item)) for item in view.entries],
        roots=[DirectoryEntryOut(**asdict(item)) for item in view.roots],
        note=view.note,
    )


@router.post(
    "",
    response_model=WorkspaceOut,
    status_code=status.HTTP_201_CREATED,
    summary="新建工作区（指定根目录）",
)
def create_workspace(
    payload: WorkspaceCreateIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_write)],
) -> WorkspaceOut:
    """`root_path` 必须是**已存在的目录**，且不能指向数据目录或文件系统根
    （见 ``validate_root_path`` 的三道校验）。"""
    record = services.workspaces.create(
        name=payload.name,
        root_path=payload.root_path,
        description=payload.description,
        kb_ids=payload.kb_ids,
        user_id=_owner(caller),
    )
    return _out(record, 0)


@router.get("/{workspace_id}", response_model=WorkspaceOut, summary="工作区详情")
def get_workspace(
    workspace_id: str,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
) -> WorkspaceOut:
    record = services.workspaces.get(workspace_id, user_id=_owner(caller))
    return _out(record, services.workspaces.conversation_count(workspace_id))


@router.patch("/{workspace_id}", response_model=WorkspaceOut, summary="改工作区")
def update_workspace(
    workspace_id: str,
    payload: WorkspaceUpdateIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_write)],
) -> WorkspaceOut:
    """名字 / 根目录 / 描述 / 知识库都可选，只改传了的那些。

    **归属不可改**：把一个工作区转给别人，连带的是"里头会话的 Agent 行为"，
    那是另一个功能，不该顺手做掉。
    """
    record = services.workspaces.update(
        workspace_id,
        user_id=_owner(caller),
        name=payload.name,
        root_path=payload.root_path,
        description=payload.description,
        kb_ids=payload.kb_ids,
    )
    return _out(record, services.workspaces.conversation_count(workspace_id))


@router.delete(
    "/{workspace_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除工作区（里面的会话退回未归档）",
)
def delete_workspace(
    workspace_id: str,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_write)],
) -> None:
    """**不删会话**：它们变成未归档，在侧栏的"未归档会话"那一栏继续存在。

    这是刻意的：会话里有用户问过的内容，误删不可恢复；而"失去归属"是可恢复的
    （重新挂一个工作区就行）。
    """
    services.workspaces.delete(workspace_id, user_id=_owner(caller))
