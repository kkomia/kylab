"""文档端点：上传、列表、详情、子文件树、重跑（M4）。

上传接口的处理顺序是有讲究的：**先落盘建记录（uploaded）→ 再入队**。
反过来会出现在"文件还没存好"时任务已被 worker 领走的竞态。
"""

from __future__ import annotations

import hashlib
import logging

from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    Query,
    UploadFile,
    status,
)

from app.api.auth import check_kb_scope, require_read, require_write
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
from app.services.api_key import Caller
from app.services.idempotency import fingerprint

logger = logging.getLogger(__name__)

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
    idempotency_key: str | None = Header(
        default=None,
        alias="Idempotency-Key",
        description="可选。带上它则同一键的重试不会产生第二份文档（架构 §3.2）",
    ),
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> UploadAccepted:
    """上传文档。

    **幂等键是可选的，而不是强制的**——这里与架构 §3.2 的字面要求有一处偏差，
    理由是我们已经有一条更强的兜底：内容 hash 去重。同一份文件重复上传，
    ``ingest.submit`` 会认出来并回 ``is_duplicate=True``，本来就不会入库两次。

    幂等键补的是 hash 覆盖不到的那一段：**同一个键配不同内容**时的判定，
    以及"客户端连自己上次传没传成功都不知道"的场景（回放上次的响应，
    而不是让它重新走一遍去重）。

    做成强制会立刻打断既有前端与所有集成方（401 之后又来一次全员 400），
    而收益只是把已有的保护换一种表达。所以：**提供则生效，不提供仍受 hash 去重保护**。
    """
    check_kb_scope(services, caller, [kb_id])
    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"文件超过 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB 上限",
        )

    filename = file.filename or "未命名"

    # 幂等键的处理必须在读文件之后：指纹要覆盖内容，否则"同一个键换文件"
    # 会被当成重放，直接回上次的 document_id——那是最坏的一种错（用户以为传了新的）
    request_hash = (
        fingerprint(kb_id, filename, start, hashlib.sha256(content).hexdigest())
        if idempotency_key
        else ""
    )
    if idempotency_key:
        claim = services.idempotency.begin(idempotency_key, request_hash)
        if claim.is_replay:
            logger.info("幂等键 %s 命中重放，不再重复入库", idempotency_key)
            return UploadAccepted.model_validate(claim.replay)

    try:
        response = _do_upload(
            services,
            kb_id=kb_id,
            filename=filename,
            content=content,
            mime_type=file.content_type,
            start=start,
        )
    except Exception:
        # 业务没跑成：把键放掉，让客户端能真正重试。
        # 不放的话键留着而 response 为空，重试永远拿到"正在处理中"——
        # 比直接报错更糟，因为它看起来像"再等等就好"。
        if idempotency_key:
            services.idempotency.release(idempotency_key)
        raise

    if idempotency_key:
        # mode="json" 是必须的：`model_dump()` 会留下 datetime 对象，而幂等响应要落库
        # 成 JSON——实测这里会抛 "Object of type datetime is not JSON serializable"，
        # 而**抛出点在上传成功之后**，于是"文件已入库但接口 500"，客户端重试又被
        # 幂等层拦成 409。一个序列化细节能把成功路径变成不可重试的失败。
        services.idempotency.complete(idempotency_key, response.model_dump(mode="json"))

    return response


def _do_upload(
    services: Services,
    *,
    kb_id: str,
    filename: str,
    content: bytes,
    mime_type: str | None,
    start: bool,
) -> UploadAccepted:
    """真正的入库动作。抽出来是为了让幂等层的"占键 → 执行 → 挂响应"读起来是直的。"""
    outcome = services.ingest.submit(
        knowledge_base_id=kb_id,
        filename=filename,
        content=content,
        mime_type=mime_type,
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
    kb_id: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> DocumentList:
    check_kb_scope(services, caller, [kb_id])
    records = services.documents.list_documents(kb_id)
    counts = services.documents.chunk_counts([record.id for record in records])
    return DocumentList(
        items=[_to_out(record, chunk_count=counts.get(record.id, 0)) for record in records]
    )


def _guard_document(services: Services, caller: Caller, document_id: str) -> None:
    """按文档归属的知识库做范围判定。

    这几个端点只拿到 ``document_id``，而密钥范围是绑在知识库上的，
    所以必须先把文档读出来、取出它属于哪个库再判。

    注意**先取文档再判范围**的顺序：反过来（先判后取）在文档不存在时
    会给出 403 而不是 404，等于告诉调用方"这个 id 在本机上存在但你无权看"——
    越权探测者最想要的就是这种区分。
    """
    record = services.documents.get(document_id)
    check_kb_scope(services, caller, [record.knowledge_base_id])


@router.get("/documents/{document_id}", response_model=DocumentOut, summary="文档详情")
async def get_document(
    document_id: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> DocumentOut:
    _guard_document(services, caller, document_id)
    record = services.documents.get(document_id)
    return _to_out(record, chunk_count=services.documents.chunk_count(document_id))


@router.get(
    "/documents/{document_id}/parts",
    response_model=DocumentPartList,
    summary="子文件树（大文件切分）",
)
async def list_document_parts(
    document_id: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> DocumentPartList:
    _guard_document(services, caller, document_id)
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
    caller: Caller = Depends(require_read),
) -> ChunkList:
    """按 ``ordinal`` 升序返回切块。

    同时给出 ``total``：前端要能说清"这是前 5 块，共 137 块"，
    否则用户会把预览当成全文。
    """
    _guard_document(services, caller, document_id)
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
    document_id: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> UploadAccepted:
    _guard_document(services, caller, document_id)
    document = services.documents.get(document_id)
    task = services.documents.enqueue_ingest(document_id, force=True)
    return UploadAccepted(
        document=_to_out(document, chunk_count=services.documents.chunk_count(document_id)),
        is_duplicate=False,
        task_id=task.id,
    )
