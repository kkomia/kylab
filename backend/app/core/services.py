"""服务装配（组合根的服务侧）。

与 `app/core/storage.py` 同构：这里是**唯一**把"接口"和"具体服务实现"接起来的地方，
API 层通过依赖注入拿到服务，自己不 new 任何东西。

解析器注册顺序即优先级，且**必须由本模块决定**：`parsers/` 内部禁止互相 import，
"谁先试"这种跨实现的决策只能放在 services/（工程规范 §3.3 L3）。

当前顺序：纯文本直通 → MinerU 云端 → PaddleOCR 云端。
前两个都靠 ``supports()`` 自己排除纯文本类文件，所以顺序不会误伤本地直读。
云端解析器在未配置 token 时 ``supports()`` 恒为 False，因此**没配凭据也能跑通整条链路**。
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from functools import lru_cache

from app.core.config import Settings, get_settings
from app.core.storage import build_stores
from app.services.api_key import ApiKeyService
from app.services.chat import ChatService
from app.services.conversation import ConversationService
from app.services.documents import DocumentService
from app.services.embedding import build_embedder
from app.services.embedding.base import EmbeddingProvider
from app.services.idempotency import IdempotencyService
from app.services.ingest import IngestService
from app.services.knowledge_base import KnowledgeBaseService
from app.services.parser_router import ParserRouter
from app.services.retrieval import RetrievalService, build_reranker
from app.services.retrieval.rerank import RerankProvider
from app.services.runtime_config import RuntimeConfigService
from app.services.stats import StatsService
from app.storage.base import StoreBundle
from app.workers.queue_worker import TaskWorker

__all__ = ["Services", "build_services", "get_services", "reset_services"]

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Services:
    """一组装配好的服务。字段类型都是服务类，不含存储实现。"""

    knowledge_bases: KnowledgeBaseService
    documents: DocumentService
    ingest: IngestService
    retrieval: RetrievalService
    chat: ChatService
    """快速检索对话：检索 + 提示词 + LLM，定位是让用户快速验证知识库。"""
    stats: StatsService
    """驾驶舱统计：把散在几张表里的数字聚合成仪表盘要的形状。"""
    runtime: RuntimeConfigService
    """运行期配置（凭据与模型）：设置页读写它，各 provider 每次调用现取快照。"""
    api_keys: ApiKeyService
    """API Key 的发放、校验与作用域判定（架构 §3.2）。"""
    idempotency: IdempotencyService
    """幂等键：上传类接口防重试造成重复入库（架构 §3.2）。"""
    conversations: ConversationService
    """对话留存：会话与消息的读写（§11.2）。"""
    embedder: EmbeddingProvider
    reranker: RerankProvider
    worker: TaskWorker


class _RuntimeEmbedder(EmbeddingProvider):
    """把 `RuntimeConfigService` 包成 embedding provider。

    为什么要有这一层：用户在设置页改完模型应当**立刻生效**，而不是重启进程。
    所以这里不缓存实例，每次 ``embed``/``embed_query`` 都按当前配置现建一个——
    建对象本身是廉价的（真正昂贵的是 HTTP 调用）。
    """

    def __init__(self, runtime: RuntimeConfigService) -> None:
        self._runtime = runtime

    @property
    def current(self) -> EmbeddingProvider:
        return build_embedder(self._runtime)

    @property
    def model_id(self) -> str:
        return self.current.model_id

    @property
    def dim(self) -> int:
        return self.current.dim

    @property
    def is_development(self) -> bool:
        return self.current.is_development

    def embed(self, texts):  # type: ignore[no-untyped-def]
        return self.current.embed(texts)

    def embed_query(self, text: str) -> list[float]:
        return self.current.embed_query(text)


class _RuntimeReranker(RerankProvider):
    """同上：rerank 也按当前配置现取。"""

    name = "runtime"

    def __init__(self, runtime: RuntimeConfigService) -> None:
        self._runtime = runtime

    @property
    def enabled(self) -> bool:
        return build_reranker(self._runtime).enabled

    def rerank(self, query: str, documents):  # type: ignore[no-untyped-def]
        return build_reranker(self._runtime).rerank(query, documents)


def build_services(
    settings: Settings | None = None, stores: StoreBundle | None = None
) -> Services:
    resolved = settings or get_settings()
    bundle = stores or build_stores(resolved)

    runtime = RuntimeConfigService(bundle, resolved)
    embedder = _RuntimeEmbedder(runtime)
    reranker = _RuntimeReranker(runtime)
    retrieval = RetrievalService(bundle, embedder=embedder, reranker=reranker)
    ingest = IngestService(
        bundle,
        # 路由按运行期配置现建解析器：设置页填完 token，下一个文件就走云端
        router=ParserRouter(runtime),
        embedder=embedder,
    )

    idempotency = IdempotencyService(bundle)

    def _maintain() -> None:
        """空闲维护：把"会悄悄长大的表"收一收。

        两件事都是**本来就没有调用者**的承诺——``purge_expired_idempotency_keys`` 与
        ``purge_expired_trash`` 写在存储层很久了，但从没人调，于是"保留 7 天"
        和"键不会无限增长"实际上都没发生。挂在 worker 的空闲分支上让它真的跑起来。

        顺序无所谓，但都吞异常：清理失败不该影响消费（worker 那边还会再兜一层）。
        """
        removed_keys = idempotency.purge_expired()
        if removed_keys:
            logger.info("清理过期幂等键 %d 条", removed_keys)
        purged = bundle.meta.purge_expired_trash()
        if purged:
            logger.info("清理过期回收站条目 %d 条", len(purged))

    return Services(
        knowledge_bases=KnowledgeBaseService(bundle, embedder=embedder),
        documents=DocumentService(bundle),
        ingest=ingest,
        retrieval=retrieval,
        chat=ChatService(retrieval, runtime),
        stats=StatsService(bundle),
        runtime=runtime,
        api_keys=ApiKeyService(bundle),
        idempotency=idempotency,
        conversations=ConversationService(bundle),
        embedder=embedder,
        reranker=reranker,
        worker=TaskWorker(
            bundle,
            ingest,
            owner=f"worker-{os.getpid()}",
            lease_seconds=resolved.worker_lease_seconds,
            maintain=_maintain,
        ),
    )


@lru_cache
def get_services() -> Services:
    """进程级单例，供 FastAPI 依赖注入使用。"""
    return build_services()


def reset_services() -> None:
    get_services.cache_clear()
