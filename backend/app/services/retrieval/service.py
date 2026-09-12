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

from app.services.embedding.base import EmbeddingNotConfiguredError, EmbeddingProvider
from app.services.embedding.resolver import EmbeddingResolver
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
        embedders: EmbeddingResolver | None = None,
        usage_recorder=None,  # type: ignore[no-untyped-def]
    ) -> None:
        self._stores = stores
        # 用量回调（可选）：**检索次数原先只在日志里**，于是"检索到底跑了多少次、
        # 平均命中几块"这类问题没有数字可查。缺席时什么都不记，功能照常
        self._usage_recorder = usage_recorder
        self._embedder = embedder
        # 按库解析嵌入模型（v11）：不同库可能用不同模型，查询向量必须按库算
        self._embedders = embedders
        self._reranker = reranker
        # "未配置嵌入模型"只告警一次：否则每次检索都刷一行同样的日志
        self._unconfigured_warned = False
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

        started_all = time.perf_counter()
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
        # 记在**返回之前**：返回给调用方的条数才是"命中数"，与 stats 里的分路召回数
        # 不是一回事（后者是融合前的候选量）
        self._record_usage(request, hits=hits[: request.top_k], started=started_all)

        return RetrievalResponse(
            hits=hits[: request.top_k],
            mode=request.mode,
            reranked=reranked,
            stats=stats,
            filtered_out=filtered_out,
        )

    def _record_usage(
        self, request: RetrievalQuery, *, hits: Sequence[object], started: float
    ) -> None:
        """记一次检索：条数与耗时。

        **不记 mode**：用量事件表没有能放它的字段，把 "hybrid" 塞进 ``model_id``
        会让"按模型聚合"那张表出现一行假模型。分模式的差异看 ``/search`` 响应里的
        分路统计（那本来就是给调试台用的）。
        ``items`` 记的是**返回给调用方的条数**（命中数），不是融合前的候选量。
        """
        if self._usage_recorder is None:
            return
        try:
            self._usage_recorder(
                kind="search",
                items=len(hits),
                # **必须与 started 用同一个时钟**：`perf_counter` 与 `monotonic` 的
                # 起点不同（Windows 上一个是 QPC、一个是开机毫秒），混用会算出
                # 负数时长——实测在整套测试里真的写出了 duration_ms=-19。
                # 本文件的渠道统计也一直用 perf_counter，跟它保持一致。
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        except Exception:
            # 与对话/嵌入同一条纪律：**统计失败绝不能反过来影响检索本身**
            logger.exception("检索用量记录失败（不影响本次检索）")

    # ------------------------------------------------------------------ 召回通道

    def _vector_channel(
        self, request: RetrievalQuery, query_vector: Sequence[float] | None
    ) -> tuple[list[str], dict[str, float]]:
        best: dict[str, float] = {}
        recall_factor = 2 if self._stores.meta.any_disabled_documents(request.kb_ids) else 1
        for kb_id in request.kb_ids:
            # 每个库用自己的嵌入模型算查询向量：跨库混用一个向量是错的——
            # 向量空间不同，相似度没有意义（v11 起嵌入模型是库属性）
            if query_vector is not None:
                vector = list(query_vector)
            else:
                try:
                    vector = self._embedder_for(kb_id).embed([request.query])[0]
                except EmbeddingNotConfiguredError:
                    # 没配嵌入模型不是"调用失败"，是"这个通道现在用不了"：跳过它，
                    # 全文通道照常返回——库里已有内容仍可检索，界面也能如实说明
                    # "当前只做了关键词检索"（v0.8 取消哈希兜底）
                    if not self._unconfigured_warned:
                        logger.warning("未配置嵌入模型，检索跳过向量通道，只做全文检索")
                        self._unconfigured_warned = True
                    continue
            # 有停用文档的库才 2 倍超采：KNN 扫描时没法按"文档是否停用"过滤，
            # 停用的命中会在下游 _materialize 被裁掉——多召回一倍作补偿。
            # 没有停用文档时保持原深度（candidate_k 语义不漂，也省一次放大）。
            for match in self._stores.vectors.search(
                kb_id, query_vector=vector, top_k=request.candidate_k * recall_factor
            ):
                # 同一条 chunk 不应出现在多个库，但真出现时取更近的那个距离
                if match.chunk_id not in best or match.distance < best[match.chunk_id]:
                    best[match.chunk_id] = match.distance

        ranked = sorted(best.items(), key=lambda pair: (pair[1], pair[0]))
        return [chunk_id for chunk_id, _ in ranked], {
            chunk_id: similarity_from_distance(distance) for chunk_id, distance in ranked
        }

    def _embedder_for(self, kb_id: str) -> EmbeddingProvider:
        """这个库该用哪个嵌入实现：显式选了模型就用它，否则全局默认。"""
        if self._embedders is None:
            return self._embedder
        kb = self._stores.meta.get_knowledge_base(kb_id)
        if kb is None:
            return self._embedder
        return self._embedders.for_kb(kb)

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

            if chunk.disabled:
                # 用户手动禁用的块（§G3）。**在检索侧过滤而不是删向量**：
                # 恢复时零成本，也不必重新 embedding。
                # 计入 filtered_out，让界面能解释"结果为什么变少了"。
                filtered_out += 1
                continue

            document = documents.get(chunk.document_id)
            if document is not None and document.disabled:
                # 文档级停用（v14）：与切块禁用同一套语义，只是范围是整份文档。
                # KNN 没法在扫描时按文档过滤，所以这里兜底（向量通道已按 2 倍超采缓解）。
                filtered_out += 1
                continue

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
