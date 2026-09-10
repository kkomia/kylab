"""摄入编排（M2 T2.2 的服务侧）。

把"上传 → 探测 → 解析 → 切分 → 向量化 → 可检索"串成一条可重入的链路：

- **每一步都先落状态再做事**，失败时把 ``error`` 与失败阶段写进文档记录，
  界面据此显示"卡在哪一步、为什么"（架构 §4、§12）；
- **断点续跑**：``ingest`` 从文档当前阶段继续，已完成的上游步骤不重跑；
- **模型锁定**：库内已有向量就拒绝换模型；库内还没有向量则允许更新模型与维度
  （架构 §6.4 的原话是"库内已有向量化文件 → 不允许更换"，没向量时不必逼用户重建库）。

事件循环/队列不在这里：本类是纯同步逻辑，便于直接测试；异步 worker 只负责调用它。
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from urllib.parse import quote

from app.core.exceptions import NotFoundError
from app.models.enums import DataSourceKind, DocumentStage
from app.parsers.base import ParseError, ParseResult
from app.parsers.probe import probe, suffix_of
from app.pipeline.state_machine import InvalidTransition, assert_transition
from app.services.chunking import ChunkingConfig, chunk_markdown
from app.services.embedding.base import EmbeddingError, EmbeddingProvider
from app.services.parser_router import ParserRouter
from app.storage.base import (
    MARKDOWN,
    ORIGINALS,
    DocumentRecord,
    KnowledgeBaseRecord,
    ParseResultRecord,
    StoreBundle,
    content_key,
)

__all__ = [
    "IngestError",
    "IngestOutcome",
    "IngestService",
    "content_disposition",
    "normalize_filename",
]


class IngestError(Exception):
    """摄入失败。带 ``stage`` 让 worker 决定从哪一步重试。"""

    def __init__(self, message: str, *, document_id: str, stage: DocumentStage) -> None:
        super().__init__(message)
        self.document_id = document_id
        self.stage = stage


@dataclass(frozen=True, slots=True)
class IngestOutcome:
    """一次摄入的结果。``is_duplicate`` 对应架构 §6.3 的"检测到相同文件"。"""

    document: DocumentRecord
    chunk_count: int
    is_duplicate: bool = False


class IngestService:
    """摄入流水线编排。"""

    def __init__(
        self,
        stores: StoreBundle,
        *,
        router: ParserRouter,
        embedder: EmbeddingProvider,
        chunk_config: ChunkingConfig | None = None,
    ) -> None:
        self._stores = stores
        self._router = router
        self._embedder = embedder
        self._chunk_config = chunk_config or ChunkingConfig()

    # ------------------------------------------------------------------ 上传与去重

    def submit(
        self,
        *,
        knowledge_base_id: str,
        filename: str,
        content: bytes,
        mime_type: str | None = None,
        document_id: str | None = None,
        uploaded_by: str | None = None,
    ) -> IngestOutcome:
        """登记一份上传：按内容 hash 去重 → 存原文 → 建文档记录（``uploaded``）。

        ``uploaded_by`` 是使用者名册里的 id（G6）。**只是归属标注**，
        不参与鉴权——凭据是三档 API 身份那套，两者刻意分开。
        """
        kb = self._require_kb(knowledge_base_id)
        filename = normalize_filename(filename)
        digest = hashlib.sha256(content).hexdigest()

        existing = self._stores.meta.get_document_by_hash(kb.id, digest)
        if existing is not None:
            return IngestOutcome(
                document=existing,
                chunk_count=self._stores.meta.count_chunks(existing.id),
                is_duplicate=True,
            )

        stored_path = self._stores.objects.write(
            content_key(ORIGINALS, digest, _suffix_of(filename)), content
        )
        document = self._stores.meta.create_document(
            DocumentRecord(
                id=document_id or f"doc_{uuid.uuid4().hex[:12]}",
                knowledge_base_id=kb.id,
                name=filename or "未命名",
                source_kind=DataSourceKind.UPLOAD,
                content_hash=digest,
                stage=DocumentStage.UPLOADED,
                size_bytes=len(content),
                mime_type=mime_type,
                uploaded_by=uploaded_by,
            )
        )
        self._stores.meta.set_setting(f"document.{document.id}.original_path", stored_path)
        return IngestOutcome(document=document, chunk_count=0)

    # ------------------------------------------------------------------ 主链路

    def ingest(self, document_id: str) -> IngestOutcome:
        """把文档推进到 ``indexed``；已完成的步骤会按当前阶段跳过（断点续跑）。"""
        document = self._require_document(document_id)
        kb = self._require_kb(document.knowledge_base_id)
        self._resolve_model(kb)

        # failed 态下不能拿 stage 直接比大小（它不是主链路的一环），
        # 而是**按已有产物推断该从哪一步续跑**：有 chunk 就只差向量化，
        # 有解析产物就从切分开始，什么都没有就从头来。
        resume_from = self._resume_stage(document)

        try:
            if _before(resume_from, DocumentStage.PARSED):
                parse_result = self._probe_and_parse(document)
            else:
                parse_result = None
                self._reuse_parse_result(document)

            if _before(resume_from, DocumentStage.CHUNKED):
                chunks = self._chunk(document, parse_result)
            else:
                chunks = list(self._stores.meta.iter_chunks(document.id))

            if _before(resume_from, DocumentStage.INDEXED):
                self._embed_and_index(document, kb, chunks)
        except (ParseError, EmbeddingError, InvalidTransition) as exc:
            stage = getattr(exc, "stage", "parsing")
            self._fail(document, str(exc), stage=stage)
            raise IngestError(str(exc), document_id=document.id, stage=stage) from exc

        refreshed = self._require_document(document.id)
        return IngestOutcome(
            document=refreshed, chunk_count=self._stores.meta.count_chunks(document.id)
        )

    def _resume_stage(self, document: DocumentRecord) -> DocumentStage:
        """推断续跑起点。产物是唯一可信依据——状态可能因为崩溃而停在半路。"""
        if document.stage is not DocumentStage.FAILED:
            return document.stage
        if self._stores.meta.count_chunks(document.id) > 0:
            return DocumentStage.CHUNKED  # 只差向量化
        if self._stores.meta.get_parse_result(document.id) is not None:
            return DocumentStage.PARSED  # 从切分开始
        return DocumentStage.UPLOADED

    # ------------------------------------------------------------------ 各阶段

    def _probe_and_parse(self, document: DocumentRecord) -> ParseResult:
        self._advance(document, DocumentStage.PROBING)
        original = self._read_original(document)
        probe_result = probe(original, filename=document.name, mime_type=document.mime_type)

        self._advance(document, DocumentStage.PARSING)
        decision = self._router.decide(
            filename=document.name, mime_type=document.mime_type, probe=probe_result
        )
        result = decision.parser.parse(
            content=original,
            filename=document.name,
            mime_type=document.mime_type,
            probe=probe_result,
        )

        markdown_path = self._stores.objects.write(
            f"{MARKDOWN}/{document.id}.md", result.markdown.encode("utf-8")
        )
        self._stores.meta.save_parse_result(
            ParseResultRecord(
                document_id=document.id,
                part_id=None,
                parser_name=result.parser_name,
                markdown_path=markdown_path,
                probe_meta={
                    "kind": probe_result.kind,
                    "text_coverage": probe_result.text_coverage,
                    "route_reason": decision.reason,
                    **probe_result.detail,
                },
            )
        )
        self._advance(document, DocumentStage.PARSED)
        return result

    def _reuse_parse_result(self, document: DocumentRecord) -> None:
        """断点续跑：已有解析产物就直接用，不重复调用解析引擎（可能是收费的云服务）。"""
        if self._stores.meta.get_parse_result(document.id) is None:
            raise ParseError(
                f"文档 {document.id} 处于 {document.stage.value}，但找不到解析产物，无法续跑",
                stage="parsing",
            )

    def _chunk(self, document: DocumentRecord, parse_result: ParseResult | None) -> list:
        self._advance(document, DocumentStage.CHUNKING)
        markdown = parse_result.markdown if parse_result else self._read_markdown(document)

        chunks = chunk_markdown(
            markdown,
            document_id=document.id,
            knowledge_base_id=document.knowledge_base_id,
            config=self._chunk_config,
        )
        self._stores.meta.replace_chunks(document.id, chunks)
        self._stores.fulltext.index_chunks(chunks)
        self._advance(document, DocumentStage.CHUNKED)
        return chunks

    def _embed_and_index(self, document: DocumentRecord, kb: KnowledgeBaseRecord, chunks) -> None:
        self._advance(document, DocumentStage.EMBEDDING)
        if not chunks:
            self._advance(document, DocumentStage.INDEXED)
            return

        self._stores.vectors.ensure_partition(kb.id, dim=self._embedder.dim)
        texts = [chunk.text for chunk in chunks]
        vectors = self._embedder.embed(texts)
        self._stores.vectors.upsert_vectors(
            kb.id,
            items=[(chunk.chunk_id, vector) for chunk, vector in zip(chunks, vectors, strict=True)],
        )
        self._advance(document, DocumentStage.INDEXED)

    # ------------------------------------------------------------------ 状态与校验

    def _advance(self, document: DocumentRecord, target: DocumentStage) -> None:
        assert_transition(document.stage, target)
        self._stores.meta.update_document_stage(document.id, target)
        document.stage = target

    def _fail(self, document: DocumentRecord, message: str, *, stage: str) -> None:
        """失败要落到文档记录上：界面才能显示卡在哪一步、为什么（架构 §12）。"""
        if document.stage is not DocumentStage.FAILED:
            self._stores.meta.update_document_stage(
                document.id, DocumentStage.FAILED, error=f"[{stage}] {message}"
            )
            document.stage = DocumentStage.FAILED

    def _resolve_model(self, kb: KnowledgeBaseRecord) -> None:
        """模型锁定（架构 §6.4）：库内已有向量就拒绝换模型；还没有向量则允许更正配置。

        **刻意放在 try 之外**：这是配置错误而非文档处理失败——重试没有意义，
        所以既不把文档标成 ``failed``，也不抛可重试的 :class:`IngestError`。
        """
        same_model = kb.embedding_model_id == self._embedder.model_id
        same_dim = kb.embedding_dim == self._embedder.dim
        if same_model and same_dim:
            return
        if self._stores.meta.count_kb_chunks(kb.id) == 0:
            self._stores.meta.update_knowledge_base_embedding(
                kb.id,
                model_id=self._embedder.model_id,
                dim=self._embedder.dim,
                base_url=None,
            )
            kb.embedding_model_id = self._embedder.model_id
            kb.embedding_dim = self._embedder.dim
            return
        raise EmbeddingError(
            f"知识库 {kb.id} 内已有向量化文件（模型 {kb.embedding_model_id}，"
            f"{kb.embedding_dim} 维），不允许改用 {self._embedder.model_id}"
            f"（{self._embedder.dim} 维）；需更换模型请新建知识库"
        )

    def _require_kb(self, kb_id: str) -> KnowledgeBaseRecord:
        record = self._stores.meta.get_knowledge_base(kb_id)
        if record is None:
            raise NotFoundError(f"知识库不存在：{kb_id}")
        return record

    def _require_document(self, document_id: str) -> DocumentRecord:
        record = self._stores.meta.get_document(document_id)
        if record is None:
            raise NotFoundError(f"文档不存在：{document_id}")
        return record

    def _read_original(self, document: DocumentRecord) -> bytes:
        path = self._stores.meta.get_setting(f"document.{document.id}.original_path")
        if not path:
            raise ParseError(f"文档 {document.id} 找不到原文路径", stage="probing")
        return self._stores.objects.read(path)

    def _read_markdown(self, document: DocumentRecord) -> str:
        parsed = self._stores.meta.get_parse_result(document.id)
        if parsed is None:
            raise ParseError(f"文档 {document.id} 找不到解析产物", stage="chunking")
        return self._stores.objects.read(parsed.markdown_path).decode("utf-8")


def _before(current: DocumentStage, target: DocumentStage) -> bool:
    """当前阶段是否还在 ``target`` 之前（决定该步骤要不要跑）。"""
    order = (
        DocumentStage.UPLOADED,
        DocumentStage.PROBING,
        DocumentStage.PARSING,
        DocumentStage.PARSED,
        DocumentStage.CHUNKING,
        DocumentStage.CHUNKED,
        DocumentStage.EMBEDDING,
        DocumentStage.INDEXED,
    )
    if current not in order:
        return False
    return order.index(current) < order.index(target)


def _suffix_of(filename: str) -> str:
    return suffix_of(filename)


def normalize_filename(filename: str) -> str:
    """还原 multipart 头里被按 latin-1 解出来的 UTF-8 文件名。

    HTTP 的 ``Content-Disposition`` 头只允许 latin-1，浏览器会把 UTF-8 文件名的
    原始字节直接塞进去。Starlette 按 latin-1 解码这些字节，于是中文名在控制台上
    整片变成乱码，而文件本身没问题（具体样貌见 tests/unit/services/
    test_filename_normalization.py，此处不写进注释：那段乱码里含 U+201E 等字符，
    会被本仓库自己的 emoji 扫描当成违规字符）。

    修法是把这段字符串按 latin-1 编回字节、再按 UTF-8 解一次。**只在能成功还原时采用**
    （`strict`），否则原样返回：纯 ASCII 名或本来就不是这个成因的名字不该被改坏。
    """
    if not filename or filename.isascii():
        return filename
    try:
        recovered = filename.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return filename
    return recovered or filename


def content_disposition(filename: str, *, disposition: str = "attachment") -> str:
    """按 RFC 6266 拼 ``Content-Disposition``。

    中文文件名必须走 ``filename*=UTF-8''`` 那一支：HTTP 头是 latin-1，
    直接把中文塞进 ``filename="..."`` 会被上游编码器拒掉（或变成乱码落盘）。

    同时给两个参数是刻意的，不是冗余：
    - ``filename=`` 是 ASCII 回退，给不认识 ``filename*`` 的老客户端；
    - ``filename*=`` 是标准写法，现代浏览器优先用它。
    只给后者，老客户端会拿到一个没名字的文件；只给前者，中文名就保不住。

    ``%`` 与换行要转义/剔除：换行进头部就是响应拆分（response splitting），
    而文件名是用户可控的输入。
    """
    safe = filename.replace("\r", "").replace("\n", "").replace('"', "")
    ascii_fallback = safe.encode("ascii", "replace").decode("ascii") or "download"
    quoted = quote(safe, safe="")
    return f"{disposition}; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quoted}"
