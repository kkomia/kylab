"""摄入流水线的集成测试（M2 主链路）。

覆盖架构 §4 的端到端承诺：上传 → 探测 → 解析 → 切分 → 向量化 → indexed，
以及去重、失败定位、断点续跑与模型锁定。
"""

import pytest

from app.models.enums import DocumentStage
from app.parsers.base import ParseError
from app.parsers.plain_text import PlainTextParser
from app.services.chunking import ChunkingConfig
from app.services.embedding.base import EmbeddingError
from app.services.embedding.deterministic import DeterministicEmbedder
from app.services.ingest import IngestCanceled, IngestError, IngestService
from app.services.knowledge_base import KnowledgeBaseService
from app.services.parser_router import ParserRouter
from app.storage.base import StoreBundle

DIM = 32
MARKDOWN = (
    "# 知识库设计\n\n"
    "向量检索与全文检索混合召回。\n\n"
    "## 切分策略\n\n"
    "固定长度与语义切块两种模式。\n"
)


@pytest.fixture
def embedder() -> DeterministicEmbedder:
    return DeterministicEmbedder(dim=DIM)


@pytest.fixture
def kb_service(bundle: StoreBundle, embedder: DeterministicEmbedder) -> KnowledgeBaseService:
    return KnowledgeBaseService(bundle, embedder=embedder)


@pytest.fixture
def ingest_service(bundle: StoreBundle, embedder: DeterministicEmbedder) -> IngestService:
    return IngestService(
        bundle,
        router=ParserRouter([PlainTextParser()]),
        embedder=embedder,
        chunk_config=ChunkingConfig(size=64, overlap=8),
    )


@pytest.fixture
def kb(bundle: StoreBundle, kb_service: KnowledgeBaseService):
    return kb_service.create(kb_id="kb_1", name="默认库")


# --------------------------------------------------------------------- 知识库


def test_create_knowledge_base_freezes_model_and_dim(kb) -> None:
    """架构 §6.4：模型与维度随库冻结，作为后续写入的校验依据。"""
    assert kb.embedding_model_id == "dev/deterministic-hash"
    assert kb.embedding_dim == DIM


def test_kb_service_raises_for_missing_kb(kb_service: KnowledgeBaseService) -> None:
    from app.core.exceptions import NotFoundError

    with pytest.raises(NotFoundError):
        kb_service.get("kb_none")


# --------------------------------------------------------------------- 主链路


def test_ingest_reaches_indexed(bundle: StoreBundle, ingest_service: IngestService, kb) -> None:
    outcome = ingest_service.submit(knowledge_base_id="kb_1", filename="kb.md",
                                    content=MARKDOWN.encode())
    assert outcome.document.stage is DocumentStage.UPLOADED

    result = ingest_service.ingest(outcome.document.id)

    assert result.document.stage is DocumentStage.INDEXED
    assert result.document.error is None
    assert result.chunk_count > 0


def test_ingest_writes_markdown_artifact(bundle: StoreBundle, ingest_service: IngestService,
                                         kb) -> None:
    """架构 §4.3：所有格式统一产出 Markdown，原文另留一份。"""
    outcome = ingest_service.submit(knowledge_base_id="kb_1", filename="kb.md",
                                    content=MARKDOWN.encode())
    ingest_service.ingest(outcome.document.id)

    parsed = bundle.meta.get_parse_result(outcome.document.id)
    assert parsed is not None
    assert parsed.parser_name == "PlainTextParser"
    assert bundle.objects.read(parsed.markdown_path).decode() == MARKDOWN
    assert parsed.probe_meta["kind"] == "text"
    assert "route_reason" in parsed.probe_meta  # 路由理由要能被界面解释


def test_ingest_makes_document_searchable_by_fulltext(bundle: StoreBundle,
                                                      ingest_service: IngestService, kb) -> None:
    outcome = ingest_service.submit(knowledge_base_id="kb_1", filename="kb.md",
                                    content=MARKDOWN.encode())
    ingest_service.ingest(outcome.document.id)

    hits = bundle.fulltext.search(query="混合召回", top_k=5, kb_id="kb_1")
    assert hits
    assert hits[0].document_id == outcome.document.id


def test_ingest_writes_vectors(bundle: StoreBundle, ingest_service: IngestService, kb) -> None:
    outcome = ingest_service.submit(knowledge_base_id="kb_1", filename="kb.md",
                                    content=MARKDOWN.encode())
    result = ingest_service.ingest(outcome.document.id)

    assert bundle.vectors.declared_dim("kb_1") == DIM
    query = [0.0] * DIM
    query[0] = 1.0
    matches = bundle.vectors.search("kb_1", query_vector=query, top_k=result.chunk_count)
    assert len(matches) == result.chunk_count


def test_original_file_is_kept(bundle: StoreBundle, ingest_service: IngestService, kb) -> None:
    """架构 §4.3：原文在文件系统保留一份（下载可给原件）。"""
    outcome = ingest_service.submit(knowledge_base_id="kb_1", filename="kb.md",
                                    content=MARKDOWN.encode())
    path = bundle.meta.get_setting(f"document.{outcome.document.id}.original_path")

    assert path is not None and path.startswith("originals/")
    assert bundle.objects.read(path) == MARKDOWN.encode()


def test_probe_meta_records_coverage_and_suffix(bundle: StoreBundle,
                                                ingest_service: IngestService, kb) -> None:
    outcome = ingest_service.submit(knowledge_base_id="kb_1", filename="kb.md",
                                    content=MARKDOWN.encode())
    ingest_service.ingest(outcome.document.id)

    meta = bundle.meta.get_parse_result(outcome.document.id).probe_meta
    assert meta["text_coverage"] == pytest.approx(1.0)
    assert meta["suffix"] == ".md"


# --------------------------------------------------------------------- 取消（v13 后）

class _CancelingParser(PlainTextParser):
    """解析过程中把文档置为 canceled，模拟"用户在这时候点了取消"。"""

    def __init__(self, bundle: StoreBundle, holder: dict) -> None:
        self._bundle = bundle
        self._holder = holder

    def parse(self, *, content, filename, mime_type, probe):  # type: ignore[no-untyped-def]
        result = super().parse(
            content=content, filename=filename, mime_type=mime_type, probe=probe
        )
        self._bundle.meta.update_document_stage(
            self._holder["id"], DocumentStage.CANCELED, error="已取消"
        )
        return result


def test_ingest_stops_at_the_next_stage_boundary_when_canceled(
    bundle: StoreBundle, embedder: DeterministicEmbedder, kb
) -> None:
    """取消是协作式的：阶段边界发现 canceled 就抛 IngestCanceled，不再往下走。

    这一条要证的是**不会出现"取消了却继续向量化"**：解析回来之后、切分之前
    就停手，文档保持在 canceled（不被后续推进覆盖）。
    """
    holder: dict = {}
    service = IngestService(
        bundle,
        router=ParserRouter([_CancelingParser(bundle, holder)]),
        embedder=embedder,
        chunk_config=ChunkingConfig(size=64, overlap=8),
    )
    outcome = service.submit(knowledge_base_id="kb_1", filename="kb.md", content=MARKDOWN.encode())
    holder["id"] = outcome.document.id

    with pytest.raises(IngestCanceled):
        service.ingest(outcome.document.id)

    assert bundle.meta.get_document(outcome.document.id).stage is DocumentStage.CANCELED
    assert bundle.meta.count_chunks(outcome.document.id) == 0


def test_canceled_document_can_be_reingested(
    bundle: StoreBundle, ingest_service: IngestService, kb
) -> None:
    """"取消"不是死路：重新摄入应当从已有产物续跑并走到 indexed。"""
    outcome = ingest_service.submit(knowledge_base_id="kb_1", filename="kb.md",
                                    content=MARKDOWN.encode())
    bundle.meta.update_document_stage(outcome.document.id, DocumentStage.CANCELED, error="已取消")

    result = ingest_service.ingest(outcome.document.id)

    assert result.document.stage is DocumentStage.INDEXED


# --------------------------------------------------------------------- 去重


def test_duplicate_upload_is_detected(ingest_service: IngestService, kb) -> None:
    """架构 §6.3：上传命中相同 hash 时提醒"检测到相同文件"，只保留一份。"""
    first = ingest_service.submit(knowledge_base_id="kb_1", filename="a.md",
                                 content=MARKDOWN.encode())
    second = ingest_service.submit(knowledge_base_id="kb_1", filename="a-copy.md",
                                  content=MARKDOWN.encode())

    assert second.is_duplicate is True
    assert second.document.id == first.document.id


def test_same_content_in_different_kb_is_not_duplicate(
    bundle: StoreBundle, ingest_service: IngestService, kb_service: KnowledgeBaseService, kb
) -> None:
    kb_service.create(kb_id="kb_2", name="第二库")
    first = ingest_service.submit(knowledge_base_id="kb_1", filename="a.md",
                                 content=MARKDOWN.encode())
    second = ingest_service.submit(knowledge_base_id="kb_2", filename="a.md",
                                  content=MARKDOWN.encode())

    assert second.is_duplicate is False
    assert second.document.id != first.document.id


# --------------------------------------------------------------------- 失败与续跑


def test_empty_file_fails_with_stage_recorded(ingest_service: IngestService, kb) -> None:
    """失败要落到文档记录上：界面才能显示卡在哪一步、为什么（架构 §12）。"""
    outcome = ingest_service.submit(knowledge_base_id="kb_1", filename="empty.md", content=b"")

    with pytest.raises(IngestError) as excinfo:
        ingest_service.ingest(outcome.document.id)

    assert excinfo.value.stage == "parsing"
    document = ingest_service._stores.meta.get_document(outcome.document.id)
    assert document.stage is DocumentStage.FAILED
    assert "内容为空" in (document.error or "")


def test_unsupported_binary_is_rejected(ingest_service: IngestService, kb) -> None:
    outcome = ingest_service.submit(
        knowledge_base_id="kb_1",
        filename="scan.pdf",
        content=b"\x89PNG\r\n\x1a\n\x00\x00",
        mime_type="application/pdf",
    )

    with pytest.raises(IngestError, match="暂不支持"):
        ingest_service.ingest(outcome.document.id)


def test_resume_after_failure_skips_completed_steps(bundle: StoreBundle,
                                                    ingest_service: IngestService,
                                                    kb_service: KnowledgeBaseService, kb) -> None:
    """断点续跑：解析已完成就不该再调一次解析器（云解析是要花钱的）。"""
    outcome = ingest_service.submit(knowledge_base_id="kb_1", filename="kb.md",
                                    content=MARKDOWN.encode())
    document_id = outcome.document.id

    # 手工推进到 parsed，模拟"解析已完成、切分前失败"
    ingest_service._probe_and_parse(
        bundle.meta.get_document(document_id)
    )
    bundle.meta.update_document_stage(document_id, DocumentStage.FAILED, error="模拟切分失败")

    # 用一个"一旦被调用就失败"的路由器，证明它没被调用
    class _ExplodingParser(PlainTextParser):
        name = "ExplodingParser"

        def parse(self, **_kwargs):  # type: ignore[override]
            raise AssertionError("解析器不该在续跑时被再次调用")

    resumed = IngestService(
        bundle,
        router=ParserRouter([_ExplodingParser()]),
        embedder=DeterministicEmbedder(dim=DIM),
        chunk_config=ChunkingConfig(size=64, overlap=8),
    )
    result = resumed.ingest(document_id)

    assert result.document.stage is DocumentStage.INDEXED


def test_resume_without_artifact_reports_parsing_stage(bundle: StoreBundle,
                                                       ingest_service: IngestService, kb) -> None:
    """状态说解析完了、产物却不在：不能假装能续跑，要报在 parsing 阶段。"""
    outcome = ingest_service.submit(knowledge_base_id="kb_1", filename="kb.md",
                                    content=MARKDOWN.encode())
    bundle.meta.update_document_stage(outcome.document.id, DocumentStage.PARSED)

    with pytest.raises(IngestError) as excinfo:
        ingest_service.ingest(outcome.document.id)

    assert excinfo.value.stage == "parsing"
    assert "找不到解析产物" in str(excinfo.value)


# --------------------------------------------------------------------- 模型锁定


def test_model_change_is_allowed_before_any_vector_exists(
    bundle: StoreBundle, ingest_service: IngestService, kb
) -> None:
    """库内还没有向量时允许更正配置，不必逼用户重建库。"""
    outcome = ingest_service.submit(knowledge_base_id="kb_1", filename="kb.md",
                                    content=MARKDOWN.encode())

    switched = IngestService(
        bundle,
        router=ParserRouter([PlainTextParser()]),
        embedder=DeterministicEmbedder(dim=64),
        chunk_config=ChunkingConfig(size=64, overlap=8),
    )
    result = switched.ingest(outcome.document.id)

    assert result.document.stage is DocumentStage.INDEXED
    assert bundle.meta.get_knowledge_base("kb_1").embedding_dim == 64  # type: ignore[union-attr]


def test_model_change_is_refused_once_vectors_exist(bundle: StoreBundle,
                                                    ingest_service: IngestService, kb) -> None:
    """架构 §6.4：库内已有向量化文件就不允许换模型——混用会让检索静默失效。"""
    first = ingest_service.submit(knowledge_base_id="kb_1", filename="kb.md",
                                  content=MARKDOWN.encode())
    ingest_service.ingest(first.document.id)

    second = ingest_service.submit(knowledge_base_id="kb_1", filename="another.md",
                                   content="另一个文件的内容。".encode())
    switched = IngestService(
        bundle,
        router=ParserRouter([PlainTextParser()]),
        embedder=DeterministicEmbedder(dim=64),
        chunk_config=ChunkingConfig(size=64, overlap=8),
    )

    # 配置错误直接抛 EmbeddingError：重试无意义，也不该把文档标成 failed
    with pytest.raises(EmbeddingError, match="不允许改用"):
        switched.ingest(second.document.id)

    assert bundle.meta.get_document(second.document.id).stage is DocumentStage.UPLOADED


def test_missing_kb_is_reported(bundle: StoreBundle, embedder: DeterministicEmbedder) -> None:
    from app.core.exceptions import NotFoundError

    service = IngestService(bundle, router=ParserRouter([PlainTextParser()]), embedder=embedder)
    with pytest.raises(NotFoundError):
        service.submit(knowledge_base_id="kb_none", filename="a.md", content=b"x")


def test_embedding_error_stage_is_reported(bundle: StoreBundle, kb) -> None:
    """embedding 端点挂了：失败要归到 embedding 阶段，而不是含混地算作解析失败。"""
    from app.services.embedding.base import EmbeddingProvider

    class _BrokenEmbedder(EmbeddingProvider):
        model_id = "dev/deterministic-hash"  # 与库内一致，绕过模型锁
        dim = DIM

        def embed(self, texts):
            raise EmbeddingError("端点不可达")

    service = IngestService(
        bundle, router=ParserRouter([PlainTextParser()]), embedder=_BrokenEmbedder()
    )
    outcome = service.submit(knowledge_base_id="kb_1", filename="kb.md", content=MARKDOWN.encode())

    with pytest.raises(IngestError) as excinfo:
        service.ingest(outcome.document.id)
    assert excinfo.value.stage == "embedding"


# --------------------------------------------------------------------- 切分参数按库生效（v17）


def _per_kb_service(bundle: StoreBundle, embedder: DeterministicEmbedder) -> IngestService:
    """**不注入 chunk_config** 的摄入服务：生产走的就是这条路径（按库读参数）。"""
    return IngestService(bundle, router=ParserRouter([PlainTextParser()]), embedder=embedder)


def test_chunking_follows_the_knowledge_base_config(
    bundle: StoreBundle, embedder: DeterministicEmbedder, kb_service: KnowledgeBaseService
) -> None:
    """切分参数按库生效——这是"存了没人用"那个缺陷的回归用例。

    之前 `KnowledgeBaseService.create(chunk_size=...)` 只是把值存进库，
    `IngestService` 永远用硬编码的 512/64。现在两个库给同一份文本、不同的块长，
    切出来的块数必须不同，且各自不超过自己的上限。
    """
    text = ("这是一段用于验证切分参数的文本。" * 60).encode()
    kb_service.create(kb_id="kb_tiny", name="小块库", chunk_size=128, chunk_overlap=16)
    kb_service.create(kb_id="kb_big", name="大块库", chunk_size=1024, chunk_overlap=0)
    service = _per_kb_service(bundle, embedder)

    tiny = service.submit(knowledge_base_id="kb_tiny", filename="a.md", content=text)
    service.ingest(tiny.document.id)
    big = service.submit(knowledge_base_id="kb_big", filename="b.md", content=text)
    service.ingest(big.document.id)

    tiny_sizes = [len(item.text) for item in bundle.meta.iter_chunks(tiny.document.id)]
    big_sizes = [len(item.text) for item in bundle.meta.iter_chunks(big.document.id)]
    assert tiny_sizes and big_sizes
    assert max(tiny_sizes) <= 128
    assert max(big_sizes) <= 1024
    # 同一个文本，块长差 8 倍，块数必须明显不同——否则说明参数根本没被读
    assert len(tiny_sizes) > len(big_sizes)


def test_injected_chunk_config_still_wins(
    bundle: StoreBundle, embedder: DeterministicEmbedder, kb_service: KnowledgeBaseService,
    ingest_service: IngestService,
) -> None:
    """显式注入的配置优先于库里的值（测试与批量导入的旁路，不能因为接线而失效）。"""
    kb_service.create(kb_id="kb_1", name="默认库", chunk_size=2048, chunk_overlap=0)
    text = ("用于验证注入优先的文本。" * 80).encode()
    outcome = ingest_service.submit(knowledge_base_id="kb_1", filename="a.md", content=text)
    ingest_service.ingest(outcome.document.id)

    sizes = [len(item.text) for item in bundle.meta.iter_chunks(outcome.document.id)]
    assert max(sizes) <= 64  # 注入的是 size=64，不是库里的 2048


def test_legacy_out_of_range_chunking_is_clamped(
    bundle: StoreBundle, embedder: DeterministicEmbedder, kb_service: KnowledgeBaseService,
) -> None:
    """历史库里的越界参数（例如 overlap=4000 配 size=512）不许把摄入打挂。

    旧版建库接口允许这种组合入库；切分器收到 overlap >= size 会直接抛错，
    看起来像"文件坏了"。所以读出来时钳位。
    """
    record = kb_service.create(kb_id="kb_1", name="默认库")
    bundle.meta.set_knowledge_base_chunking("kb_1", 512, 4000)  # 模拟历史脏数据
    assert bundle.meta.get_knowledge_base("kb_1").chunk_overlap == 4000

    service = _per_kb_service(bundle, embedder)
    outcome = service.submit(
        knowledge_base_id="kb_1", filename="a.md", content=("文本内容。" * 200).encode()
    )
    result = service.ingest(outcome.document.id)

    assert result.document.stage is DocumentStage.INDEXED
    assert record.id == "kb_1"


def test_uploaded_html_is_stripped_before_indexing(
    bundle: StoreBundle, embedder, kb  # type: ignore[no-untyped-def]
) -> None:
    """上传的 .html 走正文提取（v17）。

    回归用例：原先 `.html` 落到纯文本直通（靠 MIME text/* 兜底），
    `<script>` 与导航原样入库——用户问什么都能匹配到菜单里的"首页 关于 联系方式"。
    """
    from app.parsers.html_upload import HtmlUploadParser

    service = IngestService(
        bundle,
        router=ParserRouter([HtmlUploadParser(), PlainTextParser()]),
        embedder=embedder,
    )
    html = (
        "<html><body>"
        "<nav>首页 关于我们 联系方式</nav>"
        "<p>眼轴长度是近视防控的核心指标。</p>"
        "<script>var tracking = 1;</script>"
        "</body></html>"
    )
    outcome = service.submit(
        knowledge_base_id="kb_1", filename="page.html", content=html.encode()
    )
    result = service.ingest(outcome.document.id)

    assert result.document.stage is DocumentStage.INDEXED
    parsed = bundle.meta.get_parse_result(outcome.document.id)
    assert parsed is not None
    assert parsed.parser_name == "HtmlUploadParser"
    markdown = bundle.objects.read(parsed.markdown_path).decode()
    assert "眼轴长度是近视防控的核心指标" in markdown
    assert "首页 关于我们" not in markdown
    assert "var tracking" not in markdown


# ------------------------------------------------- 解析引擎自动降级（v17）


class _FailingParser(PlainTextParser):
    """首选引擎：一定失败。"""

    name = "FailingParser"

    def parse(self, **_kwargs):  # type: ignore[override]
        raise ParseError("云端额度用尽", stage="parsing")


def test_parser_failure_degrades_to_the_next_candidate(bundle: StoreBundle, kb) -> None:  # type: ignore[no-untyped-def]
    """首选引擎失败时自动换下一个：扫描件有两条云端通道，文字型 PDF 还有本地直提。

    原先只挑第一个，第一个失败就整份文档失败——后面的通道白放着。
    """
    service = IngestService(
        bundle,
        router=ParserRouter([_FailingParser(), PlainTextParser()]),
        embedder=DeterministicEmbedder(dim=DIM),
    )
    outcome = service.submit(knowledge_base_id="kb_1", filename="a.md", content=MARKDOWN.encode())

    result = service.ingest(outcome.document.id)

    assert result.document.stage is DocumentStage.INDEXED
    parsed = bundle.meta.get_parse_result(outcome.document.id)
    assert parsed is not None
    assert parsed.parser_name == "PlainTextParser"
    # 降级原因要写进产物说明：界面上"这个文件是谁解析的"必须能解释为什么不是首选
    reason = parsed.probe_meta.get("route_reason", "")
    assert "FailingParser" in reason
    assert "云端额度用尽" in reason


def test_all_parsers_failing_reports_every_reason(bundle: StoreBundle, kb) -> None:  # type: ignore[no-untyped-def]
    """全挂时把**每个引擎为什么失败**都说出来。

    只回最后一条会误导：用户看到"PaddleOCR 超时"以为换个引擎就行，
    其实 MinerU 早就因为额度用尽失败了（那才是要处理的事）。
    """

    class _AlsoFailing(PlainTextParser):
        name = "AlsoFailingParser"

        def parse(self, **_kwargs):  # type: ignore[override]
            raise ParseError("接口抖动", stage="parsing")

    service = IngestService(
        bundle,
        router=ParserRouter([_FailingParser(), _AlsoFailing()]),
        embedder=DeterministicEmbedder(dim=DIM),
    )
    outcome = service.submit(knowledge_base_id="kb_1", filename="a.md", content=MARKDOWN.encode())

    with pytest.raises(IngestError) as excinfo:
        service.ingest(outcome.document.id)

    message = str(excinfo.value)
    assert "FailingParser" in message and "云端额度用尽" in message
    assert "AlsoFailingParser" in message and "接口抖动" in message
