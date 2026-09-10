"""知识库端点（M4）。

只做协议适配：校验入参 → 调用 ``KnowledgeBaseService`` → 转成响应模型。
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends

from app.api.auth import check_kb_scope, require_read, require_write
from app.api.v1.schemas import KnowledgeBaseCreate, KnowledgeBaseList, KnowledgeBaseOut
from app.core.services import Services, get_services
from app.services.api_key import Caller

router = APIRouter(prefix="/knowledge-bases", tags=["knowledge-bases"])


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
    )
    return KnowledgeBaseOut.model_validate(record)


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
    return KnowledgeBaseList(items=[KnowledgeBaseOut.model_validate(r) for r in records])


@router.get("/{kb_id}", response_model=KnowledgeBaseOut, summary="知识库详情")
async def get_knowledge_base(
    kb_id: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> KnowledgeBaseOut:
    check_kb_scope(services, caller, [kb_id])
    return KnowledgeBaseOut.model_validate(services.knowledge_bases.get(kb_id))
