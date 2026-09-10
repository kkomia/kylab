"""知识库端点（M4）。

只做协议适配：校验入参 → 调用 ``KnowledgeBaseService`` → 转成响应模型。
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends

from app.api.v1.schemas import KnowledgeBaseCreate, KnowledgeBaseList, KnowledgeBaseOut
from app.core.services import Services, get_services

router = APIRouter(prefix="/knowledge-bases", tags=["knowledge-bases"])


@router.post("", response_model=KnowledgeBaseOut, status_code=201, summary="创建知识库")
async def create_knowledge_base(
    payload: KnowledgeBaseCreate, services: Services = Depends(get_services)
) -> KnowledgeBaseOut:
    record = services.knowledge_bases.create(
        kb_id=f"kb_{uuid.uuid4().hex[:12]}",
        name=payload.name,
        chunk_size=payload.chunk_size,
        chunk_overlap=payload.chunk_overlap,
    )
    return KnowledgeBaseOut.model_validate(record)


@router.get("", response_model=KnowledgeBaseList, summary="知识库列表")
async def list_knowledge_bases(services: Services = Depends(get_services)) -> KnowledgeBaseList:
    records = services.knowledge_bases.list_all()
    return KnowledgeBaseList(items=[KnowledgeBaseOut.model_validate(r) for r in records])


@router.get("/{kb_id}", response_model=KnowledgeBaseOut, summary="知识库详情")
async def get_knowledge_base(
    kb_id: str, services: Services = Depends(get_services)
) -> KnowledgeBaseOut:
    return KnowledgeBaseOut.model_validate(services.knowledge_bases.get(kb_id))
