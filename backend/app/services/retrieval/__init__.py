"""检索服务（M3）。

对外只暴露三样东西：检索入口、查询/结果类型、rerank 构造器。
"""

from __future__ import annotations

from app.services.retrieval.fusion import DEFAULT_RRF_K, rrf_fuse
from app.services.retrieval.rerank import (
    NoopReranker,
    OpenAICompatReranker,
    RerankError,
    RerankProvider,
    build_reranker,
)
from app.services.retrieval.service import RetrievalService, similarity_from_distance
from app.services.retrieval.types import (
    ChannelStat,
    MetadataFilter,
    RetrievalHit,
    RetrievalMode,
    RetrievalQuery,
    RetrievalResponse,
)

__all__ = [
    "DEFAULT_RRF_K",
    "ChannelStat",
    "MetadataFilter",
    "NoopReranker",
    "OpenAICompatReranker",
    "RerankError",
    "RerankProvider",
    "RetrievalHit",
    "RetrievalMode",
    "RetrievalQuery",
    "RetrievalResponse",
    "RetrievalService",
    "build_reranker",
    "rrf_fuse",
    "similarity_from_distance",
]
