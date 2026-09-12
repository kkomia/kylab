"""笔记端点（v20）。

**为什么单独一组 `/notes`**：笔记是"写"的一侧，与知识库的"读"、对话的"问"并列，
混进任何一边都会让那一边的状态机变复杂。前端的信息架构也照此收敛——
侧栏一个入口、页面一个视图（列表 → 编辑），相关操作全收在页内。

**归属**：与对话同口径。普通成员只能读写自己的笔记（越主 404，不暴露存在性）；
管理员会话与 API Key 通道归属为空，可以看到全部并在列表里不带归属过滤。
"""

from __future__ import annotations

import re
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from app.api.auth import check_kb_scope, require_read, require_write
from app.api.v1.schemas import (
    NoteAttachIn,
    NoteCreateIn,
    NoteListItemOut,
    NoteListOut,
    NoteOut,
    NoteTagListOut,
    NoteTagOut,
    NoteUpdateIn,
)
from app.core.services import Services, get_services
from app.services.api_key import WRITE, Caller

router = APIRouter(prefix="/notes", tags=["notes"])

#: 列表项正文预览的界面截断（与对话引用同一个量级）。
PREVIEW_CHARS = 120


def _owner(caller: Caller) -> str | None:
    """归属过滤用：只有**普通成员**会话才有归属；管理员与 API Key 通道没有。"""
    if caller.user is not None and not caller.is_admin:
        return caller.user.id
    return None


#: 行首的 Markdown 结构性记号：标题井号、引用、列表符号、有序列表序号、待办框。
_LINE_PREFIX = re.compile(r"^\s*(?:[-*+]\s*\[[ xX]\]|[#>]+|[-*+]|\d+[.)])\s*")
#: 行内的行内记号：强调、行内/围栏代码、链接（保留链接文字）。``|`` 分隔两个分支：
#: 链接分支把文字放在 group(1)，其余分支没有 group，替换时取空串。
_INLINE = re.compile(r"!?\[([^\]]*)\]\([^)]*\)|\*\*|__|`{1,3}")


def _preview(content_md: str) -> str:
    """列表预览：压平空白、去掉 Markdown 记号，再截断。

    列表页只给"这条讲什么"的一眼印象；原样带 Markdown 标记会满屏 ``##``、
    ``- [ ]``、``**``，读起来像源码而不是摘要（实测列表就是这个观感）。
    """
    lines: list[str] = []
    for line in content_md.splitlines():
        text = _LINE_PREFIX.sub("", line).strip()
        if text:
            lines.append(text)
    body = " ".join(" ".join(lines).split())
    body = _INLINE.sub(lambda match: match.group(1) or "", body)
    return body[:PREVIEW_CHARS] + ("…" if len(body) > PREVIEW_CHARS else "")


def _list_item(record) -> NoteListItemOut:  # type: ignore[no-untyped-def]
    item = NoteListItemOut.model_validate(record)
    item.content_md = ""
    item.preview = _preview(record.content_md)
    return item


@router.get("", response_model=NoteListOut, summary="笔记列表（置顶优先，其次最近更新）")
def list_notes(
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
    q: str | None = Query(default=None, description="标题/正文子串搜索"),
    tag: str | None = Query(default=None, description="按标签过滤"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> NoteListOut:
    items, total = services.notes.list(
        user_id=_owner(caller), query=q, tag=tag, limit=limit, offset=offset
    )
    return NoteListOut(
        items=[_list_item(item) for item in items], total=total, limit=limit, offset=offset
    )


@router.get("/tags", response_model=NoteTagListOut, summary="用过的标签与条数")
def list_tags(
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
) -> NoteTagListOut:
    items = [
        NoteTagOut(tag=tag, count=count)
        for tag, count in services.notes.tags(user_id=_owner(caller))
    ]
    return NoteTagListOut(items=items)


@router.post("", response_model=NoteOut, status_code=status.HTTP_201_CREATED, summary="新建笔记")
def create_note(
    payload: NoteCreateIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_write)],
) -> NoteOut:
    record = services.notes.create(
        user_id=_owner(caller),
        title=payload.title,
        content_md=payload.content_md,
        source_kind=payload.source_kind,
        source_ref=payload.source_ref,
        tags=payload.tags,
    )
    return NoteOut.model_validate(record)


@router.get("/{note_id}", response_model=NoteOut, summary="笔记详情")
def get_note(
    note_id: str,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
) -> NoteOut:
    return NoteOut.model_validate(services.notes.get_for_owner(note_id, _owner(caller)))


@router.patch("/{note_id}", response_model=NoteOut, summary="更新笔记")
def update_note(
    note_id: str,
    payload: NoteUpdateIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_write)],
) -> NoteOut:
    record = services.notes.update(
        note_id,
        user_id=_owner(caller),
        title=payload.title,
        content_md=payload.content_md,
        pinned=payload.pinned,
        tags=payload.tags,
    )
    return NoteOut.model_validate(record)


@router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT, summary="删除笔记")
def delete_note(
    note_id: str,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_write)],
) -> None:
    services.notes.delete(note_id, user_id=_owner(caller))


@router.post("/{note_id}/attach", response_model=NoteOut, summary="把笔记加入知识库")
def attach_note(
    note_id: str,
    payload: NoteAttachIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_write)],
) -> NoteOut:
    """笔记作为一份 Markdown 文档走现有摄入流水线（切块/嵌入/检索全部复用）。

    入库会写到知识库，所以要按 **WRITE** 校验库范围——只读分享不能借这条路径往库里塞东西。
    """
    check_kb_scope(services, caller, [payload.kb_id], need=WRITE)
    record = services.notes.attach_to_kb(note_id, user_id=_owner(caller), kb_id=payload.kb_id)
    return NoteOut.model_validate(record)
