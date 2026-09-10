"""服务装配（组合根的服务侧）。

与 `app/core/storage.py` 同构：这里是**唯一**把"接口"和"具体服务实现"接起来的地方，
API 层通过依赖注入拿到服务，自己不 new 任何东西。

解析器清单目前只有纯文本直通——它让整条链路在没有云端凭据时也能跑通；
MinerU / PaddleOCR 等云端解析器接入时在这里追加，路由顺序即优先级。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

from app.core.config import Settings, get_settings
from app.core.storage import build_stores
from app.parsers.plain_text import PlainTextParser
from app.services.documents import DocumentService
from app.services.embedding import build_embedder
from app.services.embedding.base import EmbeddingProvider
from app.services.ingest import IngestService
from app.services.knowledge_base import KnowledgeBaseService
from app.services.parser_router import ParserRouter
from app.services.retrieval import RetrievalService, build_reranker
from app.services.retrieval.rerank import RerankProvider
from app.storage.base import StoreBundle
from app.workers.queue_worker import TaskWorker

__all__ = ["Services", "build_services", "get_services", "reset_services"]


@dataclass(frozen=True, slots=True)
class Services:
    """一组装配好的服务。字段类型都是服务类，不含存储实现。"""

    knowledge_bases: KnowledgeBaseService
    documents: DocumentService
    ingest: IngestService
    retrieval: RetrievalService
    embedder: EmbeddingProvider
    reranker: RerankProvider
    worker: TaskWorker


def build_services(
    settings: Settings | None = None, stores: StoreBundle | None = None
) -> Services:
    resolved = settings or get_settings()
    bundle = stores or build_stores(resolved)

    embedder = build_embedder(resolved)
    reranker = build_reranker(resolved)
    ingest = IngestService(
        bundle,
        router=ParserRouter([PlainTextParser()]),
        embedder=embedder,
    )

    return Services(
        knowledge_bases=KnowledgeBaseService(bundle, embedder=embedder),
        documents=DocumentService(bundle),
        ingest=ingest,
        retrieval=RetrievalService(bundle, embedder=embedder, reranker=reranker),
        embedder=embedder,
        reranker=reranker,
        worker=TaskWorker(
            bundle,
            ingest,
            owner=f"worker-{os.getpid()}",
            lease_seconds=resolved.worker_lease_seconds,
        ),
    )


@lru_cache
def get_services() -> Services:
    """进程级单例，供 FastAPI 依赖注入使用。"""
    return build_services()


def reset_services() -> None:
    get_services.cache_clear()
