"""笔记端点（v20）。

**为什么单独一组 `/notes`**：笔记是"写"的一侧，与知识库的"读"、对话的"问"并列，
混进任何一边都会让那一边的状态机变复杂。前端的信息架构也照此收敛——
侧栏一个入口、页面一个视图（列表 → 编辑），相关操作全收在页内。

**归属**：与对话同口径。普通成员只能读写自己的笔记（越主 404，不暴露存在性）；
管理员会话与 API Key 通道归属为空，可以看到全部并在列表里不带归属过滤。
"""

from __future__ import annotations

import mimetypes
import re
from typing import Annotated

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile, status

from app.api.auth import check_kb_scope, require_read, require_write, signing_secret
from app.api.v1.schemas import (
    NoteAiIn,
    NoteAiOut,
    NoteAttachIn,
    NoteCreateIn,
    NoteImageOut,
    NoteListItemOut,
    NoteListOut,
    NoteOut,
    NoteTagListOut,
    NoteTagOut,
    NoteUpdateIn,
)
from app.core.config import Settings, get_settings
from app.core.exceptions import InvalidRequestError, UnauthorizedError
from app.core.services import Services, get_services
from app.core.signing import SigningError, sign_resource, verify_resource
from app.services.api_key import WRITE, Caller
from app.services.notes import image_resource

router = APIRouter(prefix="/notes", tags=["notes"])

#: 列表项正文预览的界面截断（与对话引用同一个量级）。
PREVIEW_CHARS = 120
#: 配图 URL 的有效期。**故意很长**：这个 URL 会被写进笔记正文里存下来，
#: 短了就会"过一阵子打开笔记，图全裂了"。图片本身是内容哈希命名的，内容不会变，
#: 签名绑定的就是"哪条笔记的哪张图"，过期时间只是最后的兜底。
IMAGE_URL_TTL_SECONDS = 10 * 365 * 24 * 3600


def _owner(caller: Caller) -> str | None:
    """归属过滤用：只有**普通成员**会话才有归属；管理员与 API Key 通道没有。"""
    if caller.user is not None and not caller.is_admin:
        return caller.user.id
    return None


#: 行首的 Markdown 结构性记号：标题井号、引用、列表符号、有序列表序号、待办框。
_LINE_PREFIX = re.compile(r"^\s*(?:[-*+]\s*\[[ xX]\]|[#>]+|[-*+]|\d+[.)])\s*")
#: 图片整段丢掉：预览里不需要 alt 文字（那通常是文件名）。链接只保留可见文字，
#: 所以 ``|`` 的两个分支里只有链接分支有 group(1)。
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_INLINE = re.compile(r"\[([^\]]*)\]\([^)]*\)|\*\*|__|`{1,3}")


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
    body = _IMAGE.sub("", body)
    body = _INLINE.sub(lambda match: match.group(1) or "", body).strip()
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


# --------------------------------------------------------------------- AI 处理（v20.2）


@router.post("/{note_id}/ai", response_model=NoteAiOut, summary="用对话模型排版 / 润色笔记")
def ai_transform(
    note_id: str,
    payload: NoteAiIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_write)],
) -> NoteAiOut:
    """对**已保存的正文**做一次 AI 处理，返回处理结果而不落库。

    不自动写回是有意的：这是"整篇替换"级别的操作，用户应当先看到结果再决定存不存；
    前端把结果放进编辑器后走正常的防抖自动保存，中途还能用撤销回退。
    """
    record = services.notes.get_for_owner(note_id, _owner(caller))
    text = services.note_ai.transform(
        action=payload.action, content_md=record.content_md, model_pk=payload.model_pk
    )
    return NoteAiOut(content_md=text)


# --------------------------------------------------------------------- 配图（v20.2）


@router.post("/{note_id}/images", response_model=NoteImageOut, summary="上传笔记配图")
async def upload_note_image(
    note_id: str,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_write)],
    settings: Annotated[Settings, Depends(get_settings)],
    file: UploadFile = File(...),
) -> NoteImageOut:
    """上传一张图片，返回可直接放进 ``<img src>`` 的**签名相对地址**。

    为什么是签名地址而不是走鉴权头：``<img>`` 发不出 ``Authorization``，
    这正是文档下载那条路用签名参数的原因（见 ``api/v1/documents.py::content``）。
    """
    _, name = services.notes.upload_image(
        note_id,
        user_id=_owner(caller),
        filename=file.filename or "image",
        content=await file.read(),
    )
    secret = signing_secret(settings, services)
    if not secret:
        raise InvalidRequestError("尚未配置下载签名密钥，无法生成图片地址")
    signature, expires = sign_resource(
        image_resource(note_id, name), secret, ttl_seconds=IMAGE_URL_TTL_SECONDS
    )
    return NoteImageOut(
        url=f"/api/v1/notes/{note_id}/images/{name}?expires={expires}&signature={signature}",
        name=name,
        alt=file.filename or "图片",
    )


@router.get("/{note_id}/images/{name}", summary="读取笔记配图")
def read_note_image(
    note_id: str,
    name: str,
    expires: int,
    signature: str,
    services: Annotated[Services, Depends(get_services)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Response:
    """按签名取图。**刻意不挂 ``require_read``**：图片标签带不了自定义请求头。"""
    secret = signing_secret(settings, services)
    if not secret:
        raise UnauthorizedError("尚未配置下载签名密钥，无法校验图片地址")
    try:
        verify_resource(image_resource(note_id, name), signature, expires, secret)
    except SigningError as exc:
        raise UnauthorizedError(f"图片地址无效：{exc}") from exc
    data = services.notes.image_bytes(note_id, name)
    media_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return Response(
        content=data,
        media_type=media_type,
        # 文件名是内容哈希，内容不会变：可以放心长期缓存
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )
