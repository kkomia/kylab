"""混合检索的集成测试（M3）。

先用真实的摄入链路把文档灌进库，再验证召回、融合、过滤、rerank 与调试信息。
"""

from datetime import UTC, datetime, timedelta

import pytest

from app.models.enums import DataSourceKind
from app.parsers.plain_text import PlainTextParser
from app.services.chunking import ChunkingConfig
from app.services.embedding.base import EmbeddingNotConfiguredError
from app.services.embedding.deterministic import DeterministicEmbedder
from app.services.ingest import IngestService
from app.services.knowledge_base import KnowledgeBaseService
from app.services.parser_router import ParserRouter
from app.services.retrieval import (
    MetadataFilter,
    NoopReranker,
    RetrievalMode,
    RetrievalQuery,
    RetrievalService,
)
from app.services.retrieval.rerank import RerankError, RerankProvider
from app.storage.base import StoreBundle

DIM = 64

DOC_A = (
    "# 向量检索\n\n"
    "本系统使用向量检索做语义召回，配合全文检索形成混合召回。\n\n"
    "## 存储\n\n"
    "向量存放在 sqlite-vec 的虚拟表中，按知识库分区。\n"
)
DOC_B = (
    "# 部署说明\n\n"
    "服务以 Docker Compose 部署，支持局域网访问，默认端口 8000。\n\n"
    "## 配置\n\n"
    "通过环境变量配置解析节点与 embedding 端点。\n"
)


@pytest.fixture
def embedder() -> DeterministicEmbedder:
    return DeterministicEmbedder(dim=DIM)


@pytest.fixture
def ingest_service(bundle: StoreBundle, embedder: DeterministicEmbedder) -> IngestService:
    return IngestService(
        bundle,
        router=ParserRouter([PlainTextParser()]),
        embedder=embedder,
        chunk_config=ChunkingConfig(size=80, overlap=10),
    )


@pytest.fixture
def retrieval(bundle: StoreBundle, embedder: DeterministicEmbedder) -> RetrievalService:
    return RetrievalService(bundle, embedder=embedder, reranker=NoopReranker())


@pytest.fixture
def seeded(bundle: StoreBundle, ingest_service: IngestService, embedder: DeterministicEmbedder):
    """两个库、三份文档，用来验证按库收敛与过滤。"""
    kb_service = KnowledgeBaseService(bundle, embedder=embedder)
    kb_service.create(kb_id="kb_1", name="技术库")
    kb_service.create(kb_id="kb_2", name="运维库")

    for kb_id, name, content in [
        ("kb_1", "vector.md", DOC_A),
        ("kb_1", "deploy.md", DOC_B),
        ("kb_2", "ops.md", DOC_B),  # 同内容不同库：验证库范围隔离
    ]:
        outcome = ingest_service.submit(
            knowledge_base_id=kb_id, filename=name, content=content.encode()
        )
        if not outcome.is_duplicate:
            ingest_service.ingest(outcome.document.id)
    return bundle


# --------------------------------------------------------------------- 基本召回


def test_hybrid_search_finds_relevant_document(seeded: StoreBundle,
                                               retrieval: RetrievalService) -> None:
    response = retrieval.search(RetrievalQuery(query="向量检索 混合召回", kb_ids=["kb_1"]))

    assert response.hits
    assert response.mode == RetrievalMode.HYBRID
    assert response.hits[0].document_name == "vector.md"
    assert "向量检索" in response.hits[0].text


def test_hits_carry_source_metadata_for_the_console(seeded: StoreBundle,
                                                    retrieval: RetrievalService) -> None:
    """调试台要显示来源文档、页码、相似度（架构 §3.3）。"""
    hit = retrieval.search(RetrievalQuery(query="sqlite-vec 分区", kb_ids=["kb_1"])).hits[0]

    assert hit.document_name
    assert hit.heading_path  # 标题路径注入的成果
    assert hit.channels  # 这条是怎么被捞上来的
    assert hit.raw_scores  # 原始分（向量侧为余弦相似度）


def test_channel_stats_are_reported(seeded: StoreBundle, retrieval: RetrievalService) -> None:
    """慢在哪一路、每路召回多少，界面要能看出来。"""
    response = retrieval.search(RetrievalQuery(query="部署", kb_ids=["kb_1"]))
    channels = {stat.channel: stat for stat in response.stats}

    assert set(channels) == {"vector", "fulltext"}
    assert all(stat.count >= 0 and stat.elapsed_ms >= 0 for stat in channels.values())


def test_modes_restrict_channels(seeded: StoreBundle, retrieval: RetrievalService) -> None:
    vector_only = retrieval.search(
        RetrievalQuery(query="向量检索", kb_ids=["kb_1"], mode=RetrievalMode.VECTOR)
    )
    fulltext_only = retrieval.search(
        RetrievalQuery(query="向量检索", kb_ids=["kb_1"], mode=RetrievalMode.FULLTEXT)
    )

    assert [stat.channel for stat in vector_only.stats] == ["vector"]
    assert [stat.channel for stat in fulltext_only.stats] == ["fulltext"]


def test_top_k_is_respected(seeded: StoreBundle, retrieval: RetrievalService) -> None:
    response = retrieval.search(
        RetrievalQuery(query="检索 部署 配置", kb_ids=["kb_1"], top_k=1, candidate_k=10)
    )
    assert len(response.hits) == 1


def test_empty_query_returns_nothing(seeded: StoreBundle, retrieval: RetrievalService) -> None:
    assert retrieval.search(RetrievalQuery(query="   ", kb_ids=["kb_1"])).hits == []


def test_empty_kb_list_returns_nothing(seeded: StoreBundle, retrieval: RetrievalService) -> None:
    assert retrieval.search(RetrievalQuery(query="检索", kb_ids=[])).hits == []


def test_unknown_kb_returns_nothing(retrieval: RetrievalService) -> None:
    assert retrieval.search(RetrievalQuery(query="检索", kb_ids=["kb_none"])).hits == []


def test_injected_query_vector_is_used(seeded: StoreBundle,
                                       retrieval: RetrievalService,
                                       embedder: DeterministicEmbedder) -> None:
    """允许调用方直接给向量（省一次 embedding 调用，也便于测试）。"""
    vector = embedder.embed(["向量检索"])[0]
    response = retrieval.search(
        RetrievalQuery(query="向量检索", kb_ids=["kb_1"], mode=RetrievalMode.VECTOR),
        query_vector=vector,
    )
    assert response.hits


# --------------------------------------------------------------------- 库范围与过滤


def test_results_are_scoped_to_requested_kbs(seeded: StoreBundle,
                                            retrieval: RetrievalService) -> None:
    """架构 §8.3：检索先按 kb_id 收敛范围，不同库互不串味。"""
    kb_1 = retrieval.search(RetrievalQuery(query="Docker Compose 部署", kb_ids=["kb_1"]))
    kb_2 = retrieval.search(RetrievalQuery(query="Docker Compose 部署", kb_ids=["kb_2"]))

    assert {hit.knowledge_base_id for hit in kb_1.hits} == {"kb_1"}
    assert {hit.knowledge_base_id for hit in kb_2.hits} == {"kb_2"}


def test_multiple_kbs_can_be_searched_together(seeded: StoreBundle,
                                               retrieval: RetrievalService) -> None:
    response = retrieval.search(
        RetrievalQuery(query="Docker Compose 部署", kb_ids=["kb_1", "kb_2"], top_k=10)
    )
    assert {hit.knowledge_base_id for hit in response.hits} == {"kb_1", "kb_2"}


def test_filter_by_document_id(seeded: StoreBundle, retrieval: RetrievalService) -> None:
    documents = {
        document.name: document
        for document in seeded.meta.list_documents("kb_1")
    }
    target = documents["vector.md"]

    response = retrieval.search(
        RetrievalQuery(
            query="检索 部署",
            kb_ids=["kb_1"],
            top_k=10,
            filters=MetadataFilter(document_ids=[target.id]),
        )
    )

    assert response.hits
    assert {hit.document_id for hit in response.hits} == {target.id}
    assert response.filtered_out > 0  # 被挡掉多少要说清楚，否则"结果为空"无从解释


def test_filter_by_source_kind(seeded: StoreBundle, retrieval: RetrievalService) -> None:
    only_html = retrieval.search(
        RetrievalQuery(
            query="检索",
            kb_ids=["kb_1"],
            filters=MetadataFilter(source_kinds=[DataSourceKind.HTML]),
        )
    )
    assert only_html.hits == []
    assert only_html.filtered_out > 0


def test_filter_by_time_window(seeded: StoreBundle, retrieval: RetrievalService) -> None:
    future = datetime.now(UTC) + timedelta(days=1)
    past = datetime.now(UTC) - timedelta(days=1)

    assert retrieval.search(
        RetrievalQuery(query="检索", kb_ids=["kb_1"],
                       filters=MetadataFilter(created_after=future))
    ).hits == []
    assert retrieval.search(
        RetrievalQuery(query="检索", kb_ids=["kb_1"],
                       filters=MetadataFilter(created_before=past))
    ).hits == []


def test_filter_empty_object_keeps_everything(seeded: StoreBundle,
                                              retrieval: RetrievalService) -> None:
    response = retrieval.search(
        RetrievalQuery(query="检索", kb_ids=["kb_1"], filters=MetadataFilter())
    )
    assert response.hits


def test_relative_score_threshold_filters_weak_hits(seeded: StoreBundle,
                                                    retrieval: RetrievalService) -> None:
    """阈值语义是"相对最高分的比例"，因此在任何模式下都成立。"""
    everything = retrieval.search(
        RetrievalQuery(query="检索 部署 配置 存储", kb_ids=["kb_1"], top_k=20, candidate_k=40)
    )
    strict = retrieval.search(
        RetrievalQuery(query="检索 部署 配置 存储", kb_ids=["kb_1"], top_k=20, candidate_k=40,
                       score_threshold=1.0)
    )

    assert len(strict.hits) <= len(everything.hits)
    assert len(strict.hits) == 1  # 1.0 = 只保留并列第一


# --------------------------------------------------------------------- 文档级停用（v14）


def test_disabled_document_is_excluded_from_both_channels(
    seeded: StoreBundle, retrieval: RetrievalService
) -> None:
    """停用一份文档后，全文与向量两条通道都不应再命中它。

    全文在 SQL 里裁（JOIN documents）；向量靠下游过滤 + 超采补偿。
    两边一起改才不会出现"全文搜不到、向量搜得到"的静默不一致——这条用例钉住它。
    """
    bundle = seeded
    document = bundle.meta.get_document_by_hash("kb_1", _hash_of(bundle, "kb_1", "deploy.md"))
    assert document is not None

    bundle.meta.set_document_disabled(document.id, True)
    assert bundle.meta.get_document(document.id).disabled is True

    # 全文通道单独查
    fulltext_hits = bundle.fulltext.search(query="部署说明", top_k=5, kb_id="kb_1")
    assert all(hit.document_id != document.id for hit in fulltext_hits)

    # 混合检索整体（向量通道也覆盖）
    response = retrieval.search(
        RetrievalQuery(query="Docker Compose 部署 端口", kb_ids=["kb_1"], top_k=5)
    )
    assert all(hit.document_id != document.id for hit in response.hits)
    # 另一份未停用的文档不受影响
    assert response.hits


def test_disabled_document_is_restorable_without_reingest(
    seeded: StoreBundle, retrieval: RetrievalService
) -> None:
    """恢复=把标记翻回来：切块与向量原样保留，立刻重新可检索。"""
    bundle = seeded
    document = bundle.meta.get_document_by_hash("kb_1", _hash_of(bundle, "kb_1", "deploy.md"))
    bundle.meta.set_document_disabled(document.id, True)

    bundle.meta.set_document_disabled(document.id, False)

    response = retrieval.search(RetrievalQuery(query="部署说明", kb_ids=["kb_1"], top_k=5))
    assert any(hit.document_id == document.id for hit in response.hits)


def _hash_of(bundle: StoreBundle, kb_id: str, name: str) -> str:
    """找到已入库文档的 content_hash：测试里用名字反查（文档少，可接受）。"""
    for document in bundle.meta.list_documents(kb_id):
        if document.name == name:
            return document.content_hash
    raise AssertionError(f"fixture 里没有 {name}")


# --------------------------------------------------------------------- rerank


class _FakeReranker(RerankProvider):
    """把顺序整个倒过来，便于断言"确实重排了"。"""

    model_id = "fake"
    enabled = True

    def __init__(self, *, fail: bool = False) -> None:
        self._fail = fail
        self.calls = 0

    def rerank(self, *, query, documents, top_n):
        self.calls += 1
        if self._fail:
            raise RerankError("端点挂了")
        return [(index, float(index)) for index in range(min(top_n, len(documents)))][::-1]


def test_rerank_reorders_hits(seeded: StoreBundle, embedder: DeterministicEmbedder) -> None:
    baseline = RetrievalService(seeded, embedder=embedder, reranker=NoopReranker())
    request = RetrievalQuery(
        query="检索 部署 配置 存储 向量 服务 环境变量",
        kb_ids=["kb_1"],
        top_k=10,
        candidate_k=40,
        rerank=True,
    )
    before = baseline.search(request)
    assert len(before.hits) > 1, "语料太少会让本用例失去意义（只有一条命中时不会重排）"

    reranker = _FakeReranker()
    after = RetrievalService(seeded, embedder=embedder, reranker=reranker).search(request)

    assert reranker.calls == 1
    assert after.reranked is True
    assert after.hits[0].chunk_id == before.hits[-1].chunk_id
    assert after.hits[0].rerank_score is not None


def test_rerank_not_requested_is_skipped(seeded: StoreBundle,
                                         embedder: DeterministicEmbedder) -> None:
    reranker = _FakeReranker()
    service = RetrievalService(seeded, embedder=embedder, reranker=reranker)
    response = service.search(
        RetrievalQuery(query="检索", kb_ids=["kb_1"], rerank=False)
    )

    assert reranker.calls == 0
    assert response.reranked is False


def test_rerank_failure_degrades_to_rrf_order(seeded: StoreBundle,
                                              embedder: DeterministicEmbedder) -> None:
    """rerank 是可选增强：它挂了不能把整次检索也拖挂（架构 §5）。"""
    baseline = RetrievalService(seeded, embedder=embedder, reranker=NoopReranker())
    degraded = RetrievalService(seeded, embedder=embedder, reranker=_FakeReranker(fail=True))

    request = RetrievalQuery(query="检索 部署", kb_ids=["kb_1"], rerank=True)
    assert [hit.chunk_id for hit in degraded.search(request).hits] == [
        hit.chunk_id for hit in baseline.search(request).hits
    ]
    assert degraded.search(request).reranked is False


def test_single_hit_needs_no_rerank(seeded: StoreBundle, embedder: DeterministicEmbedder) -> None:
    reranker = _FakeReranker()
    service = RetrievalService(seeded, embedder=embedder, reranker=reranker)
    response = service.search(
        RetrievalQuery(query="sqlite-vec 分区", kb_ids=["kb_1"], top_k=1, candidate_k=1,
                       rerank=True)
    )
    assert reranker.calls == 0
    assert response.reranked is False


# --------------------------------------------------------------------- 脏数据与防御


def test_stale_index_entries_are_skipped(seeded: StoreBundle,
                                         retrieval: RetrievalService) -> None:
    """索引里可能还留着已经删掉的 chunk：跳过它，而不是让检索崩掉。"""
    documents = {d.name: d for d in seeded.meta.list_documents("kb_1")}
    target = documents["vector.md"]
    seeded.meta.replace_chunks(target.id, [])  # 只删 chunk，FTS 索引仍留有旧条目

    response = retrieval.search(
        RetrievalQuery(query="向量检索 sqlite-vec", kb_ids=["kb_1"], top_k=10, candidate_k=40)
    )

    assert all(hit.document_id != target.id for hit in response.hits)
    assert response.filtered_out > 0


def test_filter_without_document_is_rejected() -> None:
    """防御路径：命中却查不到文档记录时，带过滤条件应判为不通过。"""
    from app.services.retrieval.service import _passes_filters

    assert _passes_filters(None, MetadataFilter(document_ids=["doc_x"])) is False
    assert _passes_filters(None, None) is True


# --------------------------------------------------------------------- 参数校验


@pytest.mark.parametrize(
    "kwargs",
    [
        {"mode": "unknown"},
        {"top_k": 0},
        {"top_k": 10, "candidate_k": 3},
    ],
)
def test_invalid_query_parameters_are_rejected(kwargs: dict) -> None:
    with pytest.raises(ValueError):
        RetrievalQuery(query="q", kb_ids=["kb_1"], **kwargs)


# ------------------------------------------------- 每个库用自己的嵌入模型（v11）


class _RecordingResolver:
    """记录"为哪个库解析了 embedder"，并把同一个确定性嵌入实现发下去。

    这里验的是**检索会按库解析模型**这条性质（混合模型的库必须各自算查询向量），
    而不是嵌入质量——质量由 embedding 自己的测试管。
    """

    def __init__(self, embedder) -> None:  # type: ignore[no-untyped-def]
        self._embedder = embedder
        self.calls: list[str | None] = []

    def for_kb(self, kb):  # type: ignore[no-untyped-def]
        self.calls.append(kb.embedding_model_pk)
        return self._embedder


def test_vector_channel_resolves_an_embedder_per_knowledge_base(seeded: StoreBundle,
                                                               embedder) -> None:  # type: ignore[no-untyped-def]
    """跨库检索时，每个库都要用**它自己的**嵌入模型算查询向量。

    共用一个查询向量是错的：不同模型的向量空间不同，相似度没有意义。
    """
    resolver = _RecordingResolver(embedder)
    service = RetrievalService(
        seeded, embedder=embedder, reranker=NoopReranker(), embedders=resolver
    )

    service.search(RetrievalQuery(query="向量检索", kb_ids=["kb_1", "kb_2"]))

    assert resolver.calls == [None, None]  # 两个库各解析一次（这里都没显式选模型）


def test_retrieval_falls_back_when_no_resolver_is_wired(seeded: StoreBundle,
                                                       retrieval: RetrievalService) -> None:
    """没接注册器时行为与改动前一致——升级不打断既有部署。"""
    assert retrieval.search(RetrievalQuery(query="部署", kb_ids=["kb_1"])).hits


def test_unconfigured_embedding_skips_the_vector_channel(seeded: StoreBundle) -> None:
    """没配嵌入模型时跳过向量通道，全文照常返回（v0.8 取消哈希兜底）。

    这里刻意不降级成"无语义的假向量"——那会让用户以为语义召回是有效的。
    正确行为是：这个通道用不了就不用，并且**不报错**，界面上另有字段说明。
    """

    class _Unconfigured:
        model_id = ""
        dim = 0

        def embed(self, texts):  # type: ignore[no-untyped-def]
            raise EmbeddingNotConfiguredError("未配置嵌入模型")

        def embed_query(self, text: str) -> list[float]:
            raise EmbeddingNotConfiguredError("未配置嵌入模型")

    service = RetrievalService(seeded, embedder=_Unconfigured(), reranker=NoopReranker())

    response = service.search(RetrievalQuery(query="部署说明", kb_ids=["kb_1"]))

    # 全文通道仍能命中：库里已有的内容不会因为没配模型就查不到
    assert response.hits
    vector_stat = next(stat for stat in response.stats if stat.channel == "vector")
    assert vector_stat.count == 0
