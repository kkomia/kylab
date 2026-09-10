"""混合检索服务（M3 T3.1–T3.6）。

流程：**多路召回 → RRF 融合 → 元数据过滤 → 可选 rerank → 截断**。

几处刻意的决定：

- **先按 kb_id 收敛再检索**（架构 §8.3）：向量表本就按库分区，全文侧也带 kb 过滤；
- **元数据过滤放在召回之后**：MVP 用"多召回再筛"实现，因为过滤维度（类型、时间）不在
  检索索引里。代价是过滤很严时可能筛空，故把 ``filtered_out`` 一并返回，让界面能解释
  为什么结果为空；后续可把常用过滤下沉到索引；
- **阈值作用于相对融合分**（``该条分 / 最高分``）：向量距离与 BM25 分数量纲不同，
  绝对阈值没法跨模式通用；相对阈值在任何模式下语义一致（1.0 = 只保留并列第一）；
- **rerank 失败降级为不重排**：日志告警即可，绝不因此让整次检索失败（架构 §5 把它定义为可选增强）。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Sequence

from app.services.embedding.base import EmbeddingProvider
from app.services.retrieval.fusion import DEFAULT_RRF_K, rrf_fuse
from app.services.retrieval.rerank import RerankError, RerankProvider
from app.services.retrieval.types import (
    ChannelStat,
    MetadataFilter,
    RetrievalHit,
    RetrievalMode,
    RetrievalQuery,
    RetrievalResponse,
)
from app.storage.base import DocumentRecord, StoreBundle

logger = logging.getLogger(__name__)

__all__ = ["RetrievalService", "similarity_from_distance"]

VECTOR_CHANNEL = "vector"
FULLTEXT_CHANNEL = "fulltext"


def similarity_from_distance(distance: float) -> float:
    """L2 距离 → 余弦相似度。

    写入前向量已做 L2 归一化，此时 ``‖a-b‖² = 2 - 2·cos``，即 ``cos = 1 - d²/2``。
    界面要显示"相似度"而不是"距离"，转换放在这里统一做。
    """
    similarity = 1.0 - (distance * distance) / 2.0
    return max(-1.0, min(1.0, similarity))


class RetrievalService:
    """混合检索。"""

    def __init__(
        self,
        stores: StoreBundle,
        *,
        embedder: EmbeddingProvider,
        reranker: RerankProvider,
        rrf_k: int = DEFAULT_RRF_K,
    ) -> None:
        self._stores = stores
        self._embedder = embedder
        self._reranker = reranker
        self._rrf_k = rrf_k

    # ------------------------------------------------------------------ 入口

    def search(
        self,
        request: RetrievalQuery,
        *,
        query_vector: Sequence[float] | None = None,
    ) -> RetrievalResponse:
        if not request.query.strip() or not request.kb_ids:
            return RetrievalResponse(hits=[], mode=request.mode, reranked=False)

        raw: dict[str, dict[str, float]] = {}
        ordered: list[tuple[str, Sequence[str]]] = []
        stats: list[ChannelStat] = []

        if request.mode in (RetrievalMode.HYBRID, RetrievalMode.VECTOR):
            started = time.perf_counter()
            vector_ranked, vector_scores = self._vector_channel(request, query_vector)
            raw[VECTOR_CHANNEL] = vector_scores
            ordered.append((VECTOR_CHANNEL, vector_ranked))
            stats.append(
                ChannelStat(
                    channel=VECTOR_CHANNEL,
                    count=len(vector_ranked),
                    elapsed_ms=round((time.perf_counter() - started) * 1000, 2),
                )
            )

        if request.mode in (RetrievalMode.HYBRID, RetrievalMode.FULLTEXT):
            started = time.perf_counter()
            text_ranked, text_scores = self._fulltext_channel(request)
            raw[FULLTEXT_CHANNEL] = text_scores
            ordered.append((FULLTEXT_CHANNEL, text_ranked))
            stats.append(
                ChannelStat(
                    channel=FULLTEXT_CHANNEL,
                    count=len(text_ranked),
                    elapsed_ms=round((time.perf_counter() - started) * 1000, 2),
                )
            )

        fused = rrf_fuse(ordered, k=self._rrf_k)
        hits, filtered_out = self._materialize(fused, raw, request)
        hits, reranked = self._maybe_rerank(hits, request)

        return RetrievalResponse(
            hits=hits[: request.top_k],
            mode=request.mode,
            reranked=reranked,
            stats=stats,
            filtered_out=filtered_out,
        )

    # ------------------------------------------------------------------ 召回通道

    def _vector_channel(
        self, request: RetrievalQuery, query_vector: Sequence[float] | None
    ) -> tuple[list[str], dict[str, float]]:
        vector = list(query_vector) if query_vector is not None else self._embedder.embed(
            [request.query]
        )[0]
        best: dict[str, float] = {}
        for kb_id in request.kb_ids:
            for match in self._stores.vectors.search(
                kb_id, query_vector=vector, top_k=request.candidate_k
            ):
                # 同一条 chunk 不应出现在多个库，但真出现时取更近的那个距离
                if match.chunk_id not in best or match.distance < best[match.chunk_id]:
                    best[match.chunk_id] = match.distance

        ranked = sorted(best.items(), key=lambda pair: (pair[1], pair[0]))
        return [chunk_id for chunk_id, _ in ranked], {
            chunk_id: similarity_from_distance(distance) for chunk_id, distance in ranked
        }

    def _fulltext_channel(
        self, request: RetrievalQuery
    ) -> tuple[list[str], dict[str, float]]:
        scored: dict[str, float] = {}
        for kb_id in request.kb_ids:
            hits = self._stores.fulltext.search(
                query=request.query, top_k=request.candidate_k, kb_id=kb_id
            )
            for hit in hits:
                if hit.chunk_id not in scored or hit.score > scored[hit.chunk_id]:
                    scored[hit.chunk_id] = hit.score

        ranked = sorted(scored.items(), key=lambda pair: (-pair[1], pair[0]))
        return [chunk_id for chunk_id, _ in ranked], dict(ranked)

    # ------------------------------------------------------------------ 组装与过滤

    def _materialize(
        self,
        fused: Sequence[tuple[str, float, tuple[str, ...], dict[str, int]]],
        raw: dict[str, dict[str, float]],
        request: RetrievalQuery,
    ) -> tuple[list[RetrievalHit], int]:
        if not fused:
            return [], 0

        chunk_ids = [chunk_id for chunk_id, _, _, _ in fused]
        chunks = {chunk.chunk_id: chunk for chunk in self._stores.meta.get_chunks(chunk_ids)}
        documents = self._documents_of(chunks.values())

        top_score = fused[0][1] or 1.0
        threshold = request.score_threshold

        hits: list[RetrievalHit] = []
        filtered_out = 0
        for chunk_id, score, channels, ranks in fused:
            chunk = chunks.get(chunk_id)
            if chunk is None:
                # chunk 已被删除但索引还没清干净：跳过而不是崩
                filtered_out += 1
                continue

            document = documents.get(chunk.document_id)
            if not _passes_filters(document, request.filters):
                filtered_out += 1
                continue
            if threshold is not None and (score / top_score) < threshold:
                filtered_out += 1
                continue

            hits.append(
                RetrievalHit(
                    chunk_id=chunk.chunk_id,
                    document_id=chunk.document_id,
                    knowledge_base_id=chunk.knowledge_base_id,
                    text=chunk.text,
                    score=score,
                    page=chunk.page,
                    heading_path=chunk.heading_path,
                    image_ids=tuple(chunk.image_ids),
                    document_name=document.name if document else None,
                    channels=channels,
                    ranks=ranks,
                    raw_scores={channel: values[chunk_id] for channel, values in raw.items()
                                if chunk_id in values},
                )
            )
        return hits, filtered_out

    def _documents_of(self, chunks) -> dict[str, DocumentRecord]:
        """批量取回命中的文档元信息（用于过滤与展示来源文档名）。"""
        documents: dict[str, DocumentRecord] = {}
        for document_id in {chunk.document_id for chunk in chunks}:
            record = self._stores.meta.get_document(document_id)
            if record is not None:
                documents[document_id] = record
        return documents

    # ------------------------------------------------------------------ rerank

    def _maybe_rerank(
        self, hits: list[RetrievalHit], request: RetrievalQuery
    ) -> tuple[list[RetrievalHit], bool]:
        if not request.rerank or not self._reranker.enabled or len(hits) <= 1:
            return hits, False

        try:
            ranked = self._reranker.rerank(
                query=request.query,
                documents=[hit.text for hit in hits],
                top_n=len(hits),
            )
        except RerankError as exc:
            logger.warning("rerank 失败，降级为 RRF 排序：%s", exc)
            return hits, False

        reordered: list[RetrievalHit] = []
        for index, score in ranked:
            if 0 <= index < len(hits):
                hit = hits[index]
                hit.rerank_score = score
                reordered.append(hit)
        # rerank 只给了部分结果时，剩下的按融合分补在后面，避免凭空丢结果
        returned = {id(hit) for hit in reordered}
        reordered.extend(hit for hit in hits if id(hit) not in returned)
        return reordered, True


def _passes_filters(document: DocumentRecord | None, filters: MetadataFilter | None) -> bool:
    if filters is None or filters.is_empty():
        return True
    if document is None:
        return False
    if filters.document_ids and document.id not in filters.document_ids:
        return False
    if filters.source_kinds and document.source_kind not in filters.source_kinds:
        return False
    if filters.created_after and (document.created_at is None
                                  or document.created_at < filters.created_after):
        return False
    return not (
        filters.created_before
        and (document.created_at is None or document.created_at > filters.created_before)
    )
