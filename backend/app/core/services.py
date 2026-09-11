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
import time
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache

from app.core.config import Settings, get_settings
from app.core.storage import build_stores
from app.services.api_key import ApiKeyService
from app.services.auth import AuthService
from app.services.chat import ChatService
from app.services.chunk import ChunkService
from app.services.conversation import ConversationService
from app.services.documents import DocumentService
from app.services.embedding import build_embedder
from app.services.embedding.base import EmbeddingProvider
from app.services.embedding.deterministic import DeterministicEmbedder
from app.services.embedding.resolver import EmbeddingResolver
from app.services.idempotency import IdempotencyService
from app.services.ingest import IngestService
from app.services.knowledge_base import KnowledgeBaseService
from app.services.lifecycle import LifecycleService
from app.services.llm import LLMUsage
from app.services.model_registry import ModelRegistryService
from app.services.observability import ObservabilityService
from app.services.parser_router import ParserRouter
from app.services.retrieval import RetrievalService, build_reranker
from app.services.retrieval.rerank import RerankProvider
from app.services.runtime_config import RuntimeConfigService
from app.services.share import ShareService
from app.services.sources import SourceService
from app.services.stats import StatsService
from app.services.tabular import TabularService
from app.services.usage import UsageService
from app.services.users import UserService
from app.services.webhook import WebhookService
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
    chunks: ChunkService
    """切块人工干预：改正文并重新向量化、禁用、删除（调研报告 G3）。"""
    models: ModelRegistryService
    """模型注册器：供应商 → 模型目录 → 按用途绑定（调研报告 G1）。"""
    usage: UsageService
    """用量统计：按次记 token 与调用量（调研报告 G7）。"""
    users: UserService
    """使用者名册：记录"是谁传的"，不参与鉴权（调研报告 G6）。"""
    auth: AuthService
    """账号引导、登录与会话校验（v10：名册升级为账号体系）。"""
    shares: ShareService
    """知识库分享：owner 把库授给其他成员，读/写两档（v10）。"""
    lifecycle: LifecycleService
    """数据生命周期：影响清单、级联删除、回收站（M6 / T6.3、T6.4）。"""
    sources: SourceService
    """数据源：HTML / RSS 的登记与拉取（M6 / T6.1–T6.3）。"""
    observability: ObservabilityService
    """运行态判据：任务是否卡住、是否长时间没被领取（M7 / T7.4）。"""
    tabular: TabularService
    """表格结构化副本：读写 CSV/Excel 的行列（M2 / T2.11）。"""
    conversations: ConversationService
    """对话留存：会话与消息的读写（§11.2）。"""
    webhooks: WebhookService
    """Webhook 订阅与事件推送（M4 / T4.6）。"""
    embedder: EmbeddingProvider
    reranker: RerankProvider
    worker: TaskWorker


class _RuntimeEmbedder(EmbeddingProvider):
    """把 `RuntimeConfigService` 包成 embedding provider。

    为什么要有这一层：用户在设置页改完模型应当**立刻生效**，而不是重启进程。
    所以这里不缓存实例，每次 ``embed``/``embed_query`` 都按当前配置现建一个——
    建对象本身是廉价的（真正昂贵的是 HTTP 调用）。

    **用量记在这一层是刻意的**（G7）：向量化的调用点很多（摄入的每个分片、
    每次检索的 query），逐个去记必然漏。包在 provider 外面就有唯一入口。
    向量化接口通常**不返回 usage**，所以这里的 token 是按字符数估的——
    因此 ``reported=False``，界面上会明确标注"这是估算"。

    ``model_id`` / ``dim`` 走**配置快照**而不是 ``current``：接口层要读它们做展示，
    没配模型时那里不该抛异常，而应如实回"未配置"。
    """

    def __init__(
        self, runtime: RuntimeConfigService, usage_recorder=None, *, dev_embedding: bool = False
    ) -> None:  # type: ignore[no-untyped-def]
        self._runtime = runtime
        self._usage_recorder = usage_recorder
        self._dev_embedding = dev_embedding

    def _record(self, texts: Sequence[str], started: float) -> None:
        if self._usage_recorder is None:
            return
        snapshot = self._runtime.embedding()
        # 中文里 1 token ≈ 1.5 个字符（各家分词不同，这是保守估计）。
        # 明确标成"未上报"，界面据此说明数字是估算的
        estimated = sum(max(1, len(text)) for text in texts) // 2
        self._usage_recorder(
            kind="embedding",
            provider=snapshot.base_url,
            model_id=self.model_id,
            # estimated=True：这是我们按字符数估的，不是接口报的。
            # 不标记的话统计页会把估算当实测展示（假精度比没数字更糟）
            usage=LLMUsage(prompt_tokens=estimated, estimated=True),
            items=len(texts),
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    @property
    def current(self) -> EmbeddingProvider:
        return build_embedder(self._runtime, dev_embedding=self._dev_embedding)

    @property
    def configured(self) -> bool:
        """是否真的配了嵌入模型。界面据此区分"没配"与"配了但坏了"。"""
        return self._runtime.embedding().is_configured

    @property
    def model_id(self) -> str:
        snapshot = self._runtime.embedding()
        if snapshot.is_configured:
            return snapshot.model_id
        return DeterministicEmbedder.model_id if self._dev_embedding else ""

    @property
    def dim(self) -> int:
        snapshot = self._runtime.embedding()
        if snapshot.dim:
            return snapshot.dim
        return 256 if self._dev_embedding else 0

    @property
    def is_development(self) -> bool:
        """只有在**没配模型但显式开了开发兜底**时才为真。"""
        return self._dev_embedding and not self._runtime.embedding().is_configured

    def embed(self, texts):  # type: ignore[no-untyped-def]
        started = time.monotonic()
        vectors = self.current.embed(texts)
        self._record(texts, started)
        return vectors

    def embed_query(self, text: str) -> list[float]:
        """查询向量化。

        **单列一个方法而不是复用 embed**：向量化接口对"文档"与"查询"常常用不同的
        前缀/指令（bge、e5 这类模型很常见），走错一边会**静默降低召回**。
        用量上按一条算。
        """
        started = time.monotonic()
        vector = self.current.embed_query(text)
        self._record([text], started)
        return vector


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

    # 注册器先建、再交给 runtime：runtime 的快照要**优先取注册表里绑定的模型**，
    # 未绑定时才回退到设置页那套字段（叠加层，见 services/model_registry.py）
    registry = ModelRegistryService(bundle)
    runtime = RuntimeConfigService(bundle, resolved, registry=registry)
    # 用量服务要**先建**：下面的 embedder 回调闭包引用了它
    usage = UsageService(bundle)

    def _record_embed_usage(**kwargs: object) -> None:
        usage.record(**kwargs)  # type: ignore[arg-type]

    embedder = _RuntimeEmbedder(runtime, _record_embed_usage, dev_embedding=resolved.dev_embedding)
    reranker = _RuntimeReranker(runtime)
    # 嵌入模型是知识库属性（v11）：按库解析。显式选了注册模型就用它，
    # 否则回退到上面的全局 embedder——老库与"不挑模型"的库行为不变
    embedding_resolver = EmbeddingResolver(registry, fallback=embedder)
    retrieval = RetrievalService(
        bundle, embedder=embedder, reranker=reranker, embedders=embedding_resolver
    )
    # webhook 先建：下面的摄入与生命周期都通过回调向它发事件（T4.6）。
    # **用回调而不是直接依赖**：通知是旁路，它挂了不能让摄入卡住
    webhooks = WebhookService(bundle)
    ingest = IngestService(
        bundle,
        # 路由按运行期配置现建解析器：设置页填完 token，下一个文件就走云端
        router=ParserRouter(runtime),
        embedder=embedder,
        embedders=embedding_resolver,
        notifier=webhooks.emit,
    )

    documents_service = DocumentService(bundle)
    # 数据源要往摄入队列里塞任务，所以依赖 DocumentService（入队）与
    # IngestService（登记）两者——它们分工不同，见 services/sources.py
    sources_service = SourceService(bundle, ingest, documents_service)

    idempotency = IdempotencyService(bundle)

    # 对话的 token 用量通过回调记（G7）：ChatService 不该依赖统计服务，
    # 那会让"记不记账"变成它的必需前提
    def _record_chat_usage(**kwargs: object) -> None:
        usage.record(**kwargs)  # type: ignore[arg-type]

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
        usage.purge_expired()
        # 走 lifecycle 而不是直接调存储层：它会**连磁盘上的原文一起删**。
        # 只删数据库行会把对象存储变成只增不减的垃圾场，
        # 而用户以为"7 天后就清掉了"
        lifecycle = LifecycleService(bundle)
        lifecycle.purge_expired_trash()

    return Services(
        knowledge_bases=KnowledgeBaseService(bundle, embedder=embedder, models=registry),
        documents=documents_service,
        ingest=ingest,
        retrieval=retrieval,
        chat=ChatService(retrieval, runtime, usage_recorder=_record_chat_usage),
        stats=StatsService(bundle),
        runtime=runtime,
        api_keys=ApiKeyService(bundle),
        idempotency=idempotency,
        chunks=ChunkService(bundle, embedder=embedder, embedders=embedding_resolver),
        models=registry,
        usage=usage,
        users=UserService(bundle),
        auth=AuthService(bundle),
        shares=ShareService(bundle),
        lifecycle=LifecycleService(bundle, notifier=webhooks.emit),
        tabular=TabularService(bundle),
        sources=sources_service,
        observability=ObservabilityService(
            bundle, worker_lease_seconds=resolved.worker_lease_seconds
        ),
        conversations=ConversationService(bundle),
        webhooks=webhooks,
        embedder=embedder,
        reranker=reranker,
        worker=TaskWorker(
            bundle,
            ingest,
            owner=f"worker-{os.getpid()}",
            lease_seconds=resolved.worker_lease_seconds,
            maintain=_maintain,
            # 数据源拉取没有 document_id，走 worker 里的独立分支（见 _handle_source）
            sync_source=sources_service.sync_now,
        ),
    )


@lru_cache
def get_services() -> Services:
    """进程级单例，供 FastAPI 依赖注入使用。"""
    return build_services()


def reset_services() -> None:
    get_services.cache_clear()
