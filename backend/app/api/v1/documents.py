"""文档端点：上传、列表、详情、子文件树、重跑（M4）。

上传接口的处理顺序是有讲究的：**先落盘建记录（uploaded）→ 再入队**。
反过来会出现在"文件还没存好"时任务已被 worker 领走的竞态。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status

from app.api.v1.schemas import (
    ChunkList,
    ChunkOut,
    DocumentList,
    DocumentOut,
    DocumentPartList,
    DocumentPartOut,
    UploadAccepted,
)
from app.core.services import Services, get_services

router = APIRouter(tags=["documents"])

MAX_UPLOAD_BYTES = 200 * 1024 * 1024
"""单文件上限 200MB：与 MinerU 云端解析的单文件上限对齐（架构 §15），
超限要在入口挡住，而不是等跑到云端才失败。"""

MAX_CHUNK_PREVIEW = 200
"""单次最多返回多少块：详情页只预览开头几段，但接口不能没有上限。"""


def _to_out(record, *, chunk_count: int = 0) -> DocumentOut:
    """记录 → 响应模型。用 ``model_validate`` 而不是手抄字段：

    协议层不该 import ``app.storage`` 的记录类型（工程规范 §3.3 L1），
    字段名对不上时 pydantic 会直接报错，不用等到线上发现"某个字段忘了同步"。
    """
    out = DocumentOut.model_validate(record)
    return out.model_copy(update={"chunk_count": chunk_count})


@router.post(
    "/knowledge-bases/{kb_id}/documents",
    response_model=UploadAccepted,
    status_code=status.HTTP_202_ACCEPTED,
    summary="上传文档（异步摄入）",
)
async def upload_document(
    kb_id: str,
    file: UploadFile = File(...),
    start: bool = Query(default=True, description="是否立即入队摄入；false 表示仅登记"),
    services: Services = Depends(get_services),
) -> UploadAccepted:
    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"文件超过 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB 上限",
        )

    outcome = services.ingest.submit(
        knowledge_base_id=kb_id,
        filename=file.filename or "未命名",
        content=content,
        mime_type=file.content_type,
    )
    if not start or outcome.is_duplicate:
        return UploadAccepted(
            document=_to_out(outcome.document, chunk_count=outcome.chunk_count),
            is_duplicate=outcome.is_duplicate,
            task_id=None,
        )

    task = services.documents.enqueue_ingest(outcome.document.id)
    return UploadAccepted(
        document=_to_out(outcome.document),
        is_duplicate=False,
        task_id=task.id,
    )


@router.get(
    "/knowledge-bases/{kb_id}/documents",
    response_model=DocumentList,
    summary="知识库下的文档列表",
)
async def list_documents(
    kb_id: str, services: Services = Depends(get_services)
) -> DocumentList:
    records = services.documents.list_documents(kb_id)
    counts = services.documents.chunk_counts([record.id for record in records])
    return DocumentList(
        items=[_to_out(record, chunk_count=counts.get(record.id, 0)) for record in records]
    )


@router.get("/documents/{document_id}", response_model=DocumentOut, summary="文档详情")
async def get_document(
    document_id: str, services: Services = Depends(get_services)
) -> DocumentOut:
    record = services.documents.get(document_id)
    return _to_out(record, chunk_count=services.documents.chunk_count(document_id))


@router.get(
    "/documents/{document_id}/parts",
    response_model=DocumentPartList,
    summary="子文件树（大文件切分）",
)
async def list_document_parts(
    document_id: str, services: Services = Depends(get_services)
) -> DocumentPartList:
    parts = services.documents.list_parts(document_id)
    return DocumentPartList(items=[DocumentPartOut.model_validate(part) for part in parts])


@router.get(
    "/documents/{document_id}/chunks",
    response_model=ChunkList,
    summary="切块列表（文档详情页的正文预览）",
)
async def list_document_chunks(
    document_id: str,
    limit: int = Query(default=20, ge=1, le=MAX_CHUNK_PREVIEW, description="最多返回多少块"),
    services: Services = Depends(get_services),
) -> ChunkList:
    """按 ``ordinal`` 升序返回切块。

    同时给出 ``total``：前端要能说清"这是前 5 块，共 137 块"，
    否则用户会把预览当成全文。
    """
    chunks = services.documents.list_chunks(document_id, limit=limit)
    return ChunkList(
        items=[ChunkOut.model_validate(chunk) for chunk in chunks],
        total=services.documents.chunk_count(document_id),
    )


@router.post(
    "/documents/{document_id}/reprocess",
    response_model=UploadAccepted,
    status_code=status.HTTP_202_ACCEPTED,
    summary="重新摄入（失败重跑）",
)
async def reprocess_document(
    document_id: str, services: Services = Depends(get_services)
) -> UploadAccepted:
    document = services.documents.get(document_id)
    task = services.documents.enqueue_ingest(document_id, force=True)
    return UploadAccepted(
        document=_to_out(document, chunk_count=services.documents.chunk_count(document_id)),
        is_duplicate=False,
        task_id=task.id,
    )
