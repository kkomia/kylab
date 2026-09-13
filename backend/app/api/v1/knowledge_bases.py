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
    KnowledgeBaseUpdate,
)
from app.core.services import Services, get_services
from app.models.enums import UserRole
from app.services.api_key import Caller

router = APIRouter(prefix="/knowledge-bases", tags=["knowledge-bases"])


def _out(
    record: Any,
    caller: Caller,
    services: Services,
    *,
    document_count: int = 0,
    last_activity: Any = None,
) -> KnowledgeBaseOut:
    """记录 → 响应，并补上"当前主体能不能管 / 能不能写这个库"。

    `record` 标成 `Any` 而不是具体记录类型：协议层不允许 import 存储
    （`scripts/check_layering.py` 的 L1 规则），而那条纪律正是"换存储不用改 api"的保证。

    两条判定都**在后端算**，前端不重复实现：
    - `can_manage` 与 ``services/share.py`` 的 ``_require_owner_or_admin`` 一致；
    - `can_write` 直接复用 ``api_keys.check_access(need=WRITE)``——
      界面据此决定要不要显示「上传文档」「添加数据源」，避免给出一个点了必然 403 的入口。

    ``document_count`` / ``last_activity`` 由调用方传入：列表接口一次 ``GROUP BY``
    拿到全部库的计数，单个库的接口用 ``document_stats()`` 里对应的一项。
    """
    managed = caller.is_admin or (
        caller.user is not None
        and (caller.user.role is UserRole.ADMIN or record.owner_id == caller.user.id)
    )
    return KnowledgeBaseOut.model_validate(record).model_copy(
        update={
            "can_manage": managed,
            "can_write": managed or services.api_keys.can_write(caller, record.id),
            "document_count": document_count,
            "last_activity": last_activity,
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
        # 推荐问题设置（v19）：建库时就能定，之后在「知识库设置 → 推荐问题」里改
        suggested_enabled=payload.suggested_enabled,
        suggested_count=payload.suggested_count,
        suggested_model_pk=payload.suggested_model_pk,
        suggested_prompt=payload.suggested_prompt,
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
    # 计数一次聚合查出来，随列表一起回——前端不必再"逐库拉文档列表只为数数"
    stats = services.knowledge_bases.document_stats()
    return KnowledgeBaseList(
        items=[
            _out(
                record,
                caller,
                services,
                document_count=stats.get(record.id, (0, None))[0],
                last_activity=stats.get(record.id, (0, None))[1],
            )
            for record in records
        ]
    )


@router.get("/{kb_id}", response_model=KnowledgeBaseOut, summary="知识库详情")
async def get_knowledge_base(
    kb_id: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> KnowledgeBaseOut:
    check_kb_scope(services, caller, [kb_id])
    count, last_activity = services.knowledge_bases.document_stats().get(kb_id, (0, None))
    return _out(
        services.knowledge_bases.get(kb_id),
        caller,
        services,
        document_count=count,
        last_activity=last_activity,
    )


@router.patch("/{kb_id}", response_model=KnowledgeBaseOut, summary="修改知识库（名称 / 简介）")
async def update_knowledge_base(
    kb_id: str,
    payload: KnowledgeBaseUpdate,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> KnowledgeBaseOut:
    """改名称、简介或切分参数。**与"删除知识库"同一档权限**（WRITE）——都是库级结构动作，
    让改名比删库更严会得到一个说不通的权限阶梯（见 ``lifecycle.py`` 的同款说明）。

    各项都可选，只处理传了的那些；都为空时不动任何东西（幂等）。

    切分参数**只对之后摄入的文档生效**（切块是解析阶段写下的）。这里不假装
    "改完就重切"——重跑由用户显式触发，取舍见 ``services/knowledge_base.py::set_chunking``。
    """
    check_kb_scope(services, caller, [kb_id], need=WRITE)
    record = services.knowledge_bases.get(kb_id)
    if payload.name is not None:
        record = services.knowledge_bases.rename(kb_id, payload.name)
    if payload.description is not None:
        record = services.knowledge_bases.set_description(kb_id, payload.description)
    if payload.chunk_size is not None or payload.chunk_overlap is not None:
        record = services.knowledge_bases.set_chunking(
            kb_id, chunk_size=payload.chunk_size, chunk_overlap=payload.chunk_overlap
        )
    if _touches_suggested(payload):
        record = services.knowledge_bases.set_suggested(
            kb_id,
            enabled=(
                payload.suggested_enabled
                if payload.suggested_enabled is not None
                else record.suggested_enabled
            ),
            count=(
                payload.suggested_count
                if payload.suggested_count is not None
                else record.suggested_count
            ),
            # 空串表示"清除"（回到跟随对话模型），与简介空串表示清空同一套约定
            model_pk=(
                payload.suggested_model_pk
                if payload.suggested_model_pk is not None
                else record.suggested_model_pk
            ),
            prompt=(
                payload.suggested_prompt
                if payload.suggested_prompt is not None
                else record.suggested_prompt
            ),
        )
    count, last_activity = services.knowledge_bases.document_stats().get(kb_id, (0, None))
    return _out(
        record, caller, services, document_count=count, last_activity=last_activity
    )


def _touches_suggested(payload: KnowledgeBaseUpdate) -> bool:
    """这次 PATCH 有没有碰推荐问题设置。

    四个字段都可选，``None`` 表示"不改"；但只要有一个不是 ``None`` 就整组提交
    （``set_suggested`` 一次写四个值，界面也是一屏提交）。
    """
    return any(
        value is not None
        for value in (
            payload.suggested_enabled,
            payload.suggested_count,
            payload.suggested_model_pk,
            payload.suggested_prompt,
        )
    )
