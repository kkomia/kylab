"""知识库端点（M4）。

只做协议适配：校验入参 → 调用 ``KnowledgeBaseService`` → 转成响应模型。
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends

from app.api.auth import WRITE, check_kb_scope, require_read, require_write
from app.api.v1.schemas import (
    KnowledgeBaseCreate,
    KnowledgeBaseList,
    KnowledgeBaseOut,
    KnowledgeBaseRename,
)
from app.core.services import Services, get_services
from app.models.enums import UserRole
from app.services.api_key import Caller

router = APIRouter(prefix="/knowledge-bases", tags=["knowledge-bases"])


def _out(record: Any, caller: Caller, services: Services) -> KnowledgeBaseOut:
    """记录 → 响应，并补上"当前主体能不能管 / 能不能写这个库"。

    `record` 标成 `Any` 而不是具体记录类型：协议层不允许 import 存储
    （`scripts/check_layering.py` 的 L1 规则），而那条纪律正是"换存储不用改 api"的保证。

    两条判定都**在后端算**，前端不重复实现：
    - `can_manage` 与 ``services/share.py`` 的 ``_require_owner_or_admin`` 一致；
    - `can_write` 直接复用 ``api_keys.check_access(need=WRITE)``——
      界面据此决定要不要显示「上传文档」「添加数据源」，避免给出一个点了必然 403 的入口。
    """
    managed = caller.is_admin or (
        caller.user is not None
        and (caller.user.role is UserRole.ADMIN or record.owner_id == caller.user.id)
    )
    return KnowledgeBaseOut.model_validate(record).model_copy(
        update={
            "can_manage": managed,
            "can_write": managed or services.api_keys.can_write(caller, record.id),
        }
    )


@router.post("", response_model=KnowledgeBaseOut, status_code=201, summary="创建知识库")
async def create_knowledge_base(
    payload: KnowledgeBaseCreate,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> KnowledgeBaseOut:
    # 建库是写操作。注意**不把新库塞进密钥范围**：密钥能建库不代表它能碰新库，
    # 范围是发钥匙时定死的，运行时不该被调用方自己扩大。
    check_kb_scope(services, caller, None)
    record = services.knowledge_bases.create(
        kb_id=f"kb_{uuid.uuid4().hex[:12]}",
        name=payload.name,
        chunk_size=payload.chunk_size,
        chunk_overlap=payload.chunk_overlap,
        # 登录成员建的库归自己（v10 私有隔离）；API Key 通道建的库无主
        owner_id=caller.user.id if caller.user else None,
        # 嵌入模型随库选定并冻结（v11）；留空走服务端默认
        embedding_model_pk=payload.embedding_model_pk,
    )
    return _out(record, caller, services)


@router.get("", response_model=KnowledgeBaseList, summary="知识库列表")
async def list_knowledge_bases(
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> KnowledgeBaseList:
    records = services.knowledge_bases.list_all()
    # 受限密钥只看到自己范围内的库——**列表也要过滤**，否则光看名字就能探出
    # 这台机器上有哪些知识库（元信息泄露），而且它点进去必然 403，体验也怪
    visible = services.api_keys.visible_kb_ids(caller)
    if visible is not None:
        records = [record for record in records if record.id in set(visible)]
    return KnowledgeBaseList(items=[_out(record, caller, services) for record in records])


@router.get("/{kb_id}", response_model=KnowledgeBaseOut, summary="知识库详情")
async def get_knowledge_base(
    kb_id: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> KnowledgeBaseOut:
    check_kb_scope(services, caller, [kb_id])
    return _out(services.knowledge_bases.get(kb_id), caller, services)


@router.patch("/{kb_id}", response_model=KnowledgeBaseOut, summary="重命名知识库")
async def rename_knowledge_base(
    kb_id: str,
    payload: KnowledgeBaseRename,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> KnowledgeBaseOut:
    """改显示名。**与"删除知识库"同一档权限**（WRITE）——两者都是库级结构动作，
    让改名比删库更严会得到一个说不通的权限阶梯（见 ``lifecycle.py`` 的同款说明）。
    """
    check_kb_scope(services, caller, [kb_id], need=WRITE)
    record = services.knowledge_bases.rename(kb_id, payload.name)
    return _out(record, caller, services)
