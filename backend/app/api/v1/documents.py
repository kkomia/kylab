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
    Query,
    UploadFile,
    status,
)
from fastapi.responses import Response
from pydantic import BaseModel

from app.api.auth import (
    READ,
    WRITE,
    check_kb_scope,
    require_read,
    require_write,
    signing_secret,
)
from app.api.v1.schemas import (
    ChunkList,
    ChunkOut,
    DocumentBatchIn,
    DocumentBatchItemOut,
    DocumentBatchOut,
    DocumentDisabledIn,
    DocumentList,
    DocumentOut,
    DocumentPartList,
    DocumentPartOut,
    DocumentRenameIn,
    UploadAccepted,
)
from app.core.config import Settings, get_settings
from app.core.exceptions import PayloadTooLargeError, UnauthorizedError
from app.core.services import Services, get_services
from app.core.signing import SigningError, verify_resource
from app.models.enums import ApiKeyPermission, DataSourceKind, DocumentStage
from app.services.api_key import Caller
from app.services.documents import signature_resource
from app.services.idempotency import fingerprint
from app.services.ingest import content_disposition, normalize_filename

logger = logging.getLogger(__name__)

router = APIRouter(tags=["documents"])

MAX_UPLOAD_BYTES = 200 * 1024 * 1024
"""单文件上限 200MB：与 MinerU 云端解析的单文件上限对齐（架构 §15），
超限要在入口挡住，而不是等跑到云端才失败。"""

MAX_CHUNK_PREVIEW = 200
"""单次最多返回多少块：详情页只预览开头几段，但接口不能没有上限。"""


def _to_out(record, *, chunk_count: int = 0, uploader: str = "") -> DocumentOut:
    """记录 → 响应模型。用 ``model_validate`` 而不是手抄字段：

    协议层不该 import ``app.storage`` 的记录类型（工程规范 §3.3 L1），
    字段名对不上时 pydantic 会直接报错，不用等到线上发现"某个字段忘了同步"。
    """
    out = DocumentOut.model_validate(record)
    return out.model_copy(update={"chunk_count": chunk_count, "uploaded_by_name": uploader})


def document_out(services: Services, record) -> DocumentOut:  # type: ignore[no-untyped-def]
    """单个文档的完整响应（切块数与上传者名字都由后端补）。

    公开出来给别的路由复用（如"移动到目录"要回一份文档）——两处各拼一遍
    必然漂（一处忘了补 chunk_count，界面就少一列数字）。
    """
    counts = services.documents.chunk_counts([record.id])
    names = _uploader_names(services, [record])
    return _to_out(
        record,
        chunk_count=counts.get(record.id, 0),
        uploader=names.get(record.uploaded_by or "", ""),
    )


def _uploader_names(services: Services, records) -> dict[str, str]:  # type: ignore[no-untyped-def]
    """把一批文档的 ``uploaded_by`` 一次解析成名字（G6）。

    **批量解析而不是逐条查**：文档列表一页几十条，逐条查就是 N+1；
    而名册本身很小，整个读出来更划算。
    """
    wanted = {record.uploaded_by for record in records if record.uploaded_by}
    if not wanted:
        return {}
    return {item.id: item.name for item in services.users.list() if item.id in wanted}


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
    folder_id: str | None = Query(default=None, description="放进哪个目录（v13）；留空=根目录"),
    idempotency_key: str | None = Header(
        default=None,
        alias="Idempotency-Key",
        description="可选。带上它则同一键的重试不会产生第二份文档（架构 §3.2）",
    ),
    operator_token: str | None = Header(
        default=None,
        alias="X-Kylab-Operator",
        description=(
            "可选。使用者名册里的 id（形如 user_xxx），记录是谁传的（G6）。"
            "不参与鉴权。**用 id 而不是名字**：HTTP 头只能是 ASCII，"
            "而名字可能是中文（实测浏览器与 curl 都会报编码错）"
        ),
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
    check_kb_scope(services, caller, [kb_id], need=WRITE)
    # 归属标注（G6）：前端从名册里选一个人放进请求头。
    # **不参与鉴权**——伪造一个名字只会让归属记错，不会获得任何权限
    operator = services.users.resolve_operator(operator_token)
    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        # 走领域异常而不是 HTTPException：后者会绕过统一错误信封，返回 {"detail": ...}
        raise PayloadTooLargeError(f"文件超过 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB 上限")

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
            uploaded_by=operator.id if operator else None,
            uploader_name=operator.name if operator else "",
            folder_id=folder_id,
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
    uploaded_by: str | None = None,
    uploader_name: str = "",
    folder_id: str | None = None,
) -> UploadAccepted:
    """真正的入库动作。抽出来是为了让幂等层的"占键 → 执行 → 挂响应"读起来是直的。"""
    outcome = services.ingest.submit(
        knowledge_base_id=kb_id,
        filename=filename,
        content=content,
        mime_type=mime_type,
        uploaded_by=uploaded_by,
        folder_id=folder_id,
    )
    if not start or outcome.is_duplicate:
        return UploadAccepted(
            document=_to_out(
                outcome.document,
                chunk_count=outcome.chunk_count,
                uploader=uploader_name,
            ),
            is_duplicate=outcome.is_duplicate,
            task_id=None,
        )

    task = services.documents.enqueue_ingest(outcome.document.id)
    return UploadAccepted(
        document=_to_out(outcome.document, uploader=uploader_name),
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
    folder_id: str | None = Query(default=None, description="只看这个目录里的文档"),
    root: bool = Query(default=False, description="只看未归档（根目录）的文档"),
    q: str | None = Query(
        default=None, max_length=200, description="按文件名模糊搜（大小写不敏感）"
    ),
    stage: DocumentStage | None = Query(default=None, description="只保留这个流水线阶段"),
    source_kind: DataSourceKind | None = Query(default=None, description="只保留这个来源类型"),
) -> DocumentList:
    """知识库下的文档列表，支持目录 / 文件名 / 状态 / 来源四个维度的收窄。

    ``stage`` 与 ``source_kind`` 用枚举而不是裸字符串：传一个拼错的值时
    框架直接回 422，而不是被当成"合法但匹配不到"而静默返回空列表——
    后者会让用户以为"这个库真的没有失败文档"。
    """
    check_kb_scope(services, caller, [kb_id])
    records = services.documents.list_documents(
        kb_id,
        folder_id=folder_id,
        root_only=root,
        q=q,
        stage=stage.value if stage else None,
        source_kind=source_kind.value if source_kind else None,
    )
    counts = services.documents.chunk_counts([record.id for record in records])
    names = _uploader_names(services, records)
    return DocumentList(
        items=[
            _to_out(
                record,
                chunk_count=counts.get(record.id, 0),
                uploader=names.get(record.uploaded_by or "", ""),
            )
            for record in records
        ]
    )


@router.post(
    "/knowledge-bases/{kb_id}/documents/batch",
    response_model=DocumentBatchOut,
    summary="批量删除 / 重新摄入",
)
async def batch_documents(
    kb_id: str,
    payload: DocumentBatchIn,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> DocumentBatchOut:
    """对选中的一批文档执行同一个动作。

    **逐条返回成败**，接口本身不因个别失败而报错——批量操作里"10 篇删掉 9 篇"
    是正常结果，界面要能指出剩下那一篇为什么没成。请求里的 id 若不属于这个库，
    记为该条失败，不会被执行。
    """
    check_kb_scope(services, caller, [kb_id], need=WRITE)
    items = services.batch.run(
        kb_id, payload.action, payload.document_ids, folder_id=payload.folder_id
    )
    return DocumentBatchOut(
        action=payload.action,
        succeeded=sum(1 for item in items if item.ok),
        failed=sum(1 for item in items if not item.ok),
        items=[
            DocumentBatchItemOut(document_id=item.document_id, ok=item.ok, error=item.error)
            for item in items
        ],
    )


def _guard_document(
    services: Services, caller: Caller, document_id: str, *, need: ApiKeyPermission = READ
) -> None:
    """按文档归属的知识库做范围判定。

    这几个端点只拿到 ``document_id``，而密钥范围是绑在知识库上的，
    所以必须先把文档读出来、取出它属于哪个库再判。

    注意**先取文档再判范围**的顺序：反过来（先判后取）在文档不存在时
    会给出 403 而不是 404，等于告诉调用方"这个 id 在本机上存在但你无权看"——
    越权探测者最想要的就是这种区分。
    """
    record = services.documents.get(document_id)
    check_kb_scope(services, caller, [record.knowledge_base_id], need=need)


@router.get("/documents/{document_id}", response_model=DocumentOut, summary="文档详情")
async def get_document(
    document_id: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> DocumentOut:
    _guard_document(services, caller, document_id)
    record = services.documents.get(document_id)
    return _to_out(
        record,
        chunk_count=services.documents.chunk_count(document_id),
        uploader=_uploader_names(services, [record]).get(record.uploaded_by or "", ""),
    )


@router.patch("/documents/{document_id}", response_model=DocumentOut, summary="重命名文档")
async def rename_document(
    document_id: str,
    payload: DocumentRenameIn,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> DocumentOut:
    """改显示名。只读分享的成员改不了——那是 owner 的库。"""
    _guard_document(services, caller, document_id, need=WRITE)
    record = services.documents.rename(document_id, payload.name)
    return document_out(services, record)


@router.patch(
    "/documents/{document_id}/disabled",
    response_model=DocumentOut,
    summary="停用 / 恢复检索",
)
async def set_document_disabled(
    document_id: str,
    payload: DocumentDisabledIn,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> DocumentOut:
    """停用后文档**不参与检索**（全文与向量两条通道都过滤），其余一切保留：

    原文、切块、向量、上传记录都在，恢复是零成本。与删除的区别是
    删除会把原文移入回收站并立即清掉切块与向量。
    """
    _guard_document(services, caller, document_id, need=WRITE)
    record = services.documents.set_disabled(document_id, payload.disabled)
    return document_out(services, record)


@router.post(
    "/documents/{document_id}/cancel",
    response_model=DocumentOut,
    summary="取消解析（叫停还在跑的摄入）",
)
async def cancel_document(
    document_id: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_write),
) -> DocumentOut:
    """用户主动叫停。**不是删除**：已产出的东西留着，随时可以重新摄入。

    语义是协作式的（见 ``IngestService.ingest``）：正在云端跑的那一次请求没法
    中途掐断，但它返回后不会再往下推进。响应里回的已经是 ``canceled`` 态。
    """
    _guard_document(services, caller, document_id, need=WRITE)
    record = services.documents.cancel(document_id)
    return document_out(services, record)


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
    _guard_document(services, caller, document_id, need=WRITE)
    document = services.documents.get(document_id)
    task = services.documents.enqueue_ingest(document_id, force=True)
    return UploadAccepted(
        document=_to_out(
            document,
            chunk_count=services.documents.chunk_count(document_id),
            uploader=_uploader_names(services, [document]).get(document.uploaded_by or "", ""),
        ),
        is_duplicate=False,
        task_id=task.id,
    )


# --------------------------------------------------------------------- 下载与阅读（T4.5 / G2）


class DownloadUrlOut(BaseModel):
    """一条下载链接。**相对路径**：对外域名只有部署时才知道。"""

    url: str
    expires_at: int
    format: str


class PreviewOut(BaseModel):
    """「阅读」视角的内容。

    文本类直接内联返回（Markdown / 纯文本），非文本类只回一条签名 URL 让浏览器自己渲染
    （PDF、图片）。**不把二进制塞进 JSON**：那要 base64，体积涨三分之一，
    而且浏览器拿到 base64 还得再解回来才能渲染。
    """

    kind: str
    """``markdown`` / ``pdf`` / ``image`` / ``binary``。"""
    filename: str
    text: str | None = None
    url: str | None = None
    expires_at: int | None = None


@router.get(
    "/documents/{document_id}/preview",
    response_model=PreviewOut,
    summary="阅读视角（Markdown 内联 / PDF 与图片给签名链接）",
)
def preview_document(
    document_id: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> PreviewOut:
    """文档的「阅读」视角。

    与「切块预览」是两个视角、刻意并存：切块回答"解析成了什么"（调试用，
    等宽文本带块号），阅读回答"原文长什么样"（日常用，渲染件）。
    """
    _guard_document(services, caller, document_id)

    content = services.documents.reading_view(document_id)

    if content.kind == "markdown":
        return PreviewOut(
            kind="markdown",
            filename=content.filename,
            text=content.data.decode("utf-8", errors="replace"),
        )

    if content.kind in ("pdf", "image"):
        secret = signing_secret(get_settings(), services)
        if not secret:
            # 没有签名密钥时发不了链接（同 download-url 的说明）。但这里**不报错**：
            # 回一个 binary 让前端退化成"只能下载"，比整个阅读面板报红字好
            return PreviewOut(kind="binary", filename=content.filename)
        url, expires_at = services.documents.download_url(
            document_id, fmt="original", secret=secret
        )
        return PreviewOut(
            kind=content.kind, filename=content.filename, url=url, expires_at=expires_at
        )

    return PreviewOut(kind="binary", filename=content.filename)


@router.get(
    "/documents/{document_id}/download-url",
    response_model=DownloadUrlOut,
    summary="签发下载链接（带过期时间）",
)
def document_download_url(
    document_id: str,
    fmt: str = Query(
        default="original",
        alias="format",
        pattern="^(original|markdown)$",
        description="original=原文件（默认），markdown=解析产物",
    ),
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> DownloadUrlOut:
    """签发一条短期下载链接。

    **需要鉴权**：拿链接要带凭据，链接本身则可以在浏览器里直接打开（无需头）。
    这正是签名 URL 想解决的矛盾——``<img>`` 与下载按钮带不了 Authorization 头。
    """
    _guard_document(services, caller, document_id)

    secret = signing_secret(get_settings(), services)
    if not secret:
        # 没有签名密钥 = 系统处于无鉴权状态。此时**拒绝签发**，而不是发一条
        # 永远有效的链接：那等于把"无鉴权"这个状态固化成永久凭据。
        raise UnauthorizedError(
            "尚未配置下载签名密钥：请配置 KYLAB_URL_SIGNING_SECRET，"
            "或先完成首次初始化（会生成一条并落库）"
        )

    url, expires_at = services.documents.download_url(
        document_id, fmt=fmt, secret=secret
    )
    return DownloadUrlOut(url=url, expires_at=expires_at, format=fmt)


@router.get(
    "/documents/{document_id}/content",
    summary="按签名下载（浏览器可直接打开）",
    response_class=Response,
    responses={
        200: {"content": {"application/octet-stream": {}}, "description": "文件内容"}
    },
)
def download_document_content(
    document_id: str,
    fmt: str = Query(default="original", alias="format", pattern="^(original|markdown)$"),
    expires: int = Query(..., description="签发时给出的到期时间戳"),
    signature: str = Query(..., description="签发时给出的签名"),
    services: Services = Depends(get_services),
    settings: Settings = Depends(get_settings),
) -> Response:
    """签名下载端点。

    **刻意不挂 ``require_read`` 依赖**：这个 URL 要能直接在浏览器里打开
    （图片标签、下载按钮都带不了自定义头）。它的授权凭据是 URL 里的签名，
    而签名已经绑定了"哪个文档、哪种格式、什么时候过期"——比一个长期令牌更窄。

    用 ``Response`` 而不是 ``FileResponse``：内容是从对象存储读进内存的字节，
    没有磁盘路径可给。``FileResponse`` 只接受路径，传 BytesIO 会在
    ``os.stat`` 上抛 TypeError（实测踩到）。
    """
    secret = signing_secret(settings, services)
    if not secret:
        raise UnauthorizedError("尚未配置下载签名密钥，无法校验下载链接")

    try:
        verify_resource(signature_resource(document_id, fmt), signature, expires, secret)
    except SigningError as exc:
        # 401：链接无效或过期，正确动作是重新签发一条
        raise UnauthorizedError(f"下载链接无效：{exc}") from exc

    content = services.documents.content(document_id, fmt=fmt)
    filename = normalize_filename(content.filename)
    return Response(
        content=content.data,
        media_type=content.media_type,
        headers={"Content-Disposition": content_disposition(filename)},
    )
