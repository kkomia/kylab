"""检索端点（M4）。

**产品边界**：这里只返回检索结果原文与元信息，**不做任何 LLM 预处理**
（架构 §5）——提示注入防护的责任在调用方。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.v1.schemas import (
    ChannelStatOut,
    SearchHitOut,
    SearchRequest,
    SearchResponse,
)
from app.core.services import Services, get_services
from app.services.retrieval import MetadataFilter, RetrievalQuery

router = APIRouter(tags=["search"])


@router.post("/search", response_model=SearchResponse, summary="混合检索")
async def search(
    payload: SearchRequest, services: Services = Depends(get_services)
) -> SearchResponse:
    filters = None
    if payload.filters is not None:
        filters = MetadataFilter(
            document_ids=payload.filters.document_ids,
            source_kinds=payload.filters.source_kinds,
            created_after=payload.filters.created_after,
            created_before=payload.filters.created_before,
        )

    response = services.retrieval.search(
        RetrievalQuery(
            query=payload.query,
            kb_ids=payload.kb_ids,
            top_k=payload.top_k,
            mode=payload.mode,
            candidate_k=payload.candidate_k,
            score_threshold=payload.score_threshold,
            rerank=payload.rerank,
            filters=filters,
        )
    )

    return SearchResponse(
        hits=[
            SearchHitOut(
                chunk_id=hit.chunk_id,
                document_id=hit.document_id,
                document_name=hit.document_name,
                knowledge_base_id=hit.knowledge_base_id,
                text=hit.text,
                score=hit.score,
                page=hit.page,
                heading_path=hit.heading_path,
                image_ids=list(hit.image_ids),
                channels=list(hit.channels),
                ranks=dict(hit.ranks),
                raw_scores=dict(hit.raw_scores),
                rerank_score=hit.rerank_score,
            )
            for hit in response.hits
        ],
        mode=response.mode,
        reranked=response.reranked,
        filtered_out=response.filtered_out,
        stats=[
            ChannelStatOut(channel=stat.channel, count=stat.count, elapsed_ms=stat.elapsed_ms)
            for stat in response.stats
        ],
        embedding_is_development=services.embedder.is_development,
    )
