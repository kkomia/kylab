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
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from app.core.config import Settings, get_settings
from app.core.storage import build_stores
from app.services.api_key import ApiKeyService
from app.services.approvals import ApprovalRegistry
from app.services.artifacts import ArtifactService
from app.services.auth import AuthService
from app.services.avatars import AvatarService
from app.services.batch import DocumentBatchService
from app.services.chat import ChatService
from app.services.chunk import ChunkService
from app.services.commands import CommandService
from app.services.conversation import ConversationService
from app.services.documents import DocumentService
from app.services.embedding import build_embedder
from app.services.embedding.base import EmbeddingProvider
from app.services.embedding.deterministic import DeterministicEmbedder
from app.services.embedding.resolver import EmbeddingResolver
from app.services.folder import FolderService
from app.services.idempotency import IdempotencyService
from app.services.ingest import IngestService
from app.services.kb_prompt import KBPromptService
from app.services.knowledge_base import KnowledgeBaseService
from app.services.lifecycle import LifecycleService
from app.services.llm import LLMUsage
from app.services.maintenance import MaintenanceService
from app.services.mcp_client import MCPClientService
from app.services.memory import MemoryService
from app.services.model_registry import ModelRegistryService
from app.services.note_ai import NoteAiService
from app.services.notes import NotesService
from app.services.observability import ObservabilityService
from app.services.parser_router import ParserRouter
from app.services.plugins import PluginService
from app.services.retrieval import RetrievalService, build_reranker
from app.services.retrieval.rerank import RerankProvider
from app.services.runtime_config import RuntimeConfigService
from app.services.schedule_runner import run_scheduled_task
from app.services.schedules import ScheduleService
from app.services.share import ShareService
from app.services.skill_blurb import SkillBlurbService
from app.services.skill_market import SkillMarketService
from app.services.skill_sources import SkillSourceService
from app.services.skills import SkillService
from app.services.sources import SourceService
from app.services.stats import StatsService
from app.services.suggested_questions import SuggestedQuestionsService
from app.services.summary import DocumentSummaryService
from app.services.system_load import SystemLoadService
from app.services.tabular import TabularService
from app.services.usage import UsageService
from app.services.users import UserService
from app.services.webhook import WebhookService
from app.services.wiki import WikiService
from app.services.workspace import WorkspaceService
from app.storage.base import StoreBundle
from app.workers.queue_worker import TaskWorker

__all__ = ["Services", "build_services", "get_services", "reset_services"]

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Services:
    """一组装配好的服务。字段类型都是服务类，不含存储实现。"""

    knowledge_bases: KnowledgeBaseService
    documents: DocumentService
    folders: FolderService
    """知识库内目录：建/列/改名/删，以及把文档放进目录（v13）。"""
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
    avatars: AvatarService
    """用户头像（v0.29）：图片在对象存储、库里只留 key，链接走签名。"""
    shares: ShareService
    """知识库分享：owner 把库授给其他成员，读/写两档（v10）。"""
    lifecycle: LifecycleService
    """数据生命周期：影响清单、级联删除、回收站（M6 / T6.3、T6.4）。"""
    batch: DocumentBatchService
    """文档批量动作：多选后的删除 / 重新摄入，逐条返回成败。"""
    maintenance: MaintenanceService
    """存储维护：空间概览与"整理"（丢无主向量分区 + VACUUM，v17）。"""
    sources: SourceService
    """数据源：HTML / RSS 的登记与拉取（M6 / T6.1–T6.3）。"""
    observability: ObservabilityService
    """运行态判据：任务是否卡住、是否长时间没被领取（M7 / T7.4）。"""
    tabular: TabularService
    """表格结构化副本：读写 CSV/Excel 的行列（M2 / T2.11）。"""
    conversations: ConversationService
    """对话留存：会话与消息的读写（§11.2）。"""
    artifacts: ArtifactService
    """会话产物（v0.26）：Agent 做出来的文件落在哪、什么时候进知识库。
    与"文档"分开：产物先是文件，进知识库是它的一个可选去向。"""
    notes: NotesService
    """笔记：Markdown 事实源 + 加入知识库（v20）。"""
    note_ai: NoteAiService
    """笔记的 AI 排版 / 润色（v20.2）。单独依赖 LLM，保住 NotesService 的"无模型也能用"。"""
    summaries: DocumentSummaryService
    """文档摘要（v25）：入库时生成，问答上下文与界面都用它。"""
    suggested_questions: SuggestedQuestionsService
    """示例问题：依据所选知识库的语料让对话模型生成开场问题（对话页空状态）。"""
    kb_prompt: KBPromptService
    """库级提示词生成（v0.19）：按库里的文档摘要让模型写一版提示词草稿。"""
    wiki: WikiService
    """知识库 Wiki：把已入库内容整理成带出处的百科式页面（v24）。"""
    webhooks: WebhookService
    """Webhook 订阅与事件推送（M4 / T4.6）。"""
    load: SystemLoadService
    """负载面板数据源：CPU / 内存 / 队列深度 / 并发槽位 / 云端解析额度（§12.115）。"""
    memory: MemoryService
    workspaces: WorkspaceService
    skills: SkillService
    skill_market: SkillMarketService
    skill_sources: SkillSourceService
    """技能源（v0.27）：内置的 GitHub 仓库清单 + 自定义源，浏览/取文件。"""
    plugins: PluginService
    """插件包（v0.43）：插件 = 一个目录 + 一份 plugin.json，**目录即本地市场**。

    与 `mcp` 是两件事：MCP 是"连出去的外部服务"，插件是"磁盘上的能力包"
    （技能/命令/钩子/工具四类能力面，见 `docs/设计/插件与技能-v0.1.md`）。"""
    mcp: MCPClientService
    schedules: ScheduleService
    """定时任务（v0.33）：到点替用户跑一轮问答。

    执行体见 ``services/schedule_runner.py``。"""
    """长期记忆的门面（设计见 `docs/设计/记忆层设计-v0.1.md`）。

    默认关；关着时它的每个方法都明确报错。"""
    embedder: EmbeddingProvider
    reranker: RerankProvider
    worker: TaskWorker
    """消费者之一。**单消费者场景用它**（测试、只跑一条任务）。
    实际并发数看 ``workers``。"""
    workers: list[TaskWorker] = field(default_factory=list)
    """进程里全部消费者（``KYLAB_WORKER_CONCURRENCY`` 个），应用启动时各起一个协程。

    默认空列表是为了让"手工构造 Services 的测试"不必挨个补参数——
    但它**必须包含 ``worker``**（见 ``build_services``）。"""
    commands: CommandService = field(default_factory=lambda: CommandService(Path("data")))
    """斜杠命令（v0.44，P1-2）：内置表 + ``commands/*.md`` 自定义命令。

    **默认值给的是"只认内置命令"的那一份**（空数据目录 + 仓库自带目录）：手工构造
    ``Services`` 的测试不必为它造一个目录，而内置那六条正是大多数用例要用到的。"""
    approvals: ApprovalRegistry = field(default_factory=ApprovalRegistry)
    """对话里的待确认登记表（v0.41，见 ``services/approvals.py``）。

    ``ask`` 档的工具调用挂在这里等用户点头：**执行器登记、工具循环等、端点交决定**，
    三方在不同线程上，所以它必须与那一轮对话共用同一份实例。
    ``get_services()`` 是进程级单例，于是"同一个进程里的那两个请求"天然看到同一张表。

    用 ``default_factory`` 而不是在组合根里 new 一遍：手工构造 Services 的地方
    （测试、脚本）不必为它加参数，而"每个 Services 自带一张空表"比"忘了传就崩"稳。
    """


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


def build_services(settings: Settings | None = None, stores: StoreBundle | None = None) -> Services:
    resolved = settings or get_settings()
    bundle = stores or build_stores(resolved)

    # 注册器先建、再交给 runtime：runtime 的快照要**优先取注册表里绑定的模型**，
    # 未绑定时才回退到设置页那套字段（叠加层，见 services/model_registry.py）
    registry = ModelRegistryService(bundle)
    runtime = RuntimeConfigService(bundle, resolved, registry=registry)
    # 记忆服务**先建**：ChatService 要拿它把长期记忆注入 system prompt。
    # 工作区放在数据目录下（见 services/memory.py 与设计文档 §2.2）：
    # 与其它数据一起备份/迁移，一个部署只有一处要备份
    memory_service = MemoryService(runtime, resolved.data_dir, stores=bundle)
    # 工作区也要 data_dir：它要拦住「把数据目录当工作区」这种配置
    # （指向那里等于绕过账号隔离，见 services/workspace.py 的第三道校验）
    workspace_service = WorkspaceService(bundle, resolved.data_dir)
    # 技能：扫描仓库自带 skills/ 与数据目录 data/skills/（见 services/skills.py）
    # 技能的门控要读运行期配置（`requires.config`，见 services/skills.py）：
    # 把"读一个配置键"的能力注进去，而不是把整个 runtime 塞给技能服务——
    # 技能层只需要这一个动作，多了就说不清它到底依赖什么。
    skill_service = SkillService(resolved.data_dir, config_value=runtime.get)
    # 技能市场（v0.16）：安装/卸载。**只写 data/skills/**——仓库自带的那份动不了
    skill_market_service = SkillMarketService(resolved.data_dir, skill_service)
    # 技能源（v0.27）：从 GitHub 仓库浏览技能。**出站只在这一层**——
    # 前端永远不直接打 GitHub（匿名配额 60 次/小时，一分钟就能打爆，见该模块说明）
    skill_source_service = SkillSourceService(
        resolved.data_dir, token=resolved.github_token or ""
    )
    # 插件包（v0.43）：扫描数据目录 plugins/ 与仓库自带 plugins/（目录即本地市场）。
    # **状态写在 app_settings**（启停/屏蔽），插件目录只读——见 services/plugins.py
    plugins_service = PluginService(resolved.data_dir, bundle)
    # MCP 客户端（v0.15）：连外部 MCP 服务，是「插件能力」的落点
    mcp_service = MCPClientService(bundle)
    # 定时任务（v0.33）：只做"到点入队"，跑问答的那一步在 schedule_runner 里
    # （它要一整套 Services，而这里还没有那个对象——见下面那个"槽"）
    schedule_service = ScheduleService(bundle)
    # 用量服务要**先建**：下面的 embedder 回调闭包引用了它
    usage = UsageService(bundle)

    def _record_embed_usage(**kwargs: object) -> None:
        usage.record(**kwargs)  # type: ignore[arg-type]

    embedder = _RuntimeEmbedder(runtime, _record_embed_usage, dev_embedding=resolved.dev_embedding)
    reranker = _RuntimeReranker(runtime)
    # 嵌入模型是知识库属性（v11）：按库解析。显式选了注册模型就用它，
    # 否则回退到上面的全局 embedder——老库与"不挑模型"的库行为不变。
    # 批大小取运行期配置（取值函数而不是常量）：否则设置页那个项对这条路径是 no-op
    embedding_resolver = EmbeddingResolver(
        registry, fallback=embedder, batch_size=lambda: runtime.embedding().batch_size
    )
    retrieval = RetrievalService(
        bundle,
        embedder=embedder,
        reranker=reranker,
        embedders=embedding_resolver,
        # 检索次数原先只在日志里：接了回调仪表盘才有"检索量 / 平均命中"可看
        usage_recorder=lambda **kwargs: usage.record(**kwargs),  # type: ignore[arg-type]
    )
    # webhook 先建：下面的摄入与生命周期都通过回调向它发事件（T4.6）。
    # **用回调而不是直接依赖**：通知是旁路，它挂了不能让摄入卡住
    webhooks = WebhookService(bundle)

    # 对话的 token 用量通过回调记（G7）：ChatService 不该依赖统计服务，
    # 那会让"记不记账"变成它的必需前提
    def _record_chat_usage(**kwargs: object) -> None:
        usage.record(**kwargs)  # type: ignore[arg-type]

    # **对话与出题服务必须在摄入之前建**（v23）：摄入现在要依赖"分段出题"
    # （SuggestedQuestionsService → ChatService）。反过来建的话 IngestService
    # 只能拿到 None，"上传即出题"就永远不生效。
    conversations_service = ConversationService(bundle)
    # 斜杠命令（v0.44，P1-2）：扫数据目录与仓库自带的 `commands/`（放进来一个 md 文件
    # 就是一条命令）。`conversations` 只用来读"这条会话上一轮的档"——模式观测的基线
    # （见 services/commands.ModeWatch），进程内不重复读。
    #
    # `skills` 是"技能即命令"那一半（v0.45，调研 §3 第 4-5 条）：每个技能注册一条
    # `/<技能名> [任务]`，正文仍由 ChatService.skill_prompt 注入（只有一处实现）。
    # `skill_summaries` 给菜单那一行用中文简介，与能力页读的是同一份清单数据。
    def _installed_skill_summaries() -> dict[str, str]:
        """已装技能的中文简介（``技能名 → 简介``）；读不出来就当没有。

        它只是菜单与 ``/skills`` 里那一行说明，坏掉不该让命令表跟着 500
        （与 api/v1/skills.py 的 ``_summaries`` 同一口径、同一份数据）。
        """
        try:
            records = skill_market_service.installed_records()
        except Exception:  # 清单坏了不影响命令表（只是少几行中文简介）
            return {}
        return {
            name: str(item.get("summary") or "")
            for name, item in records.items()
            if item.get("summary")
        }

    commands_service = CommandService(
        resolved.data_dir,
        conversations=conversations_service,
        skills=skill_service,
        skill_summaries=_installed_skill_summaries,
    )
    chat_service = ChatService(
        retrieval,
        runtime,
        # stores 用于"小块检索、大块阅读"（把命中块补成整段小节，v17）
        stores=bundle,
        usage_recorder=_record_chat_usage,
        # 会话读写（v20.1）：上下文压缩要读历史、写摘要
        conversations=conversations_service,
        # 长期记忆（v0.14）：非空时把 MEMORY.md / SOUL.md 注入 system prompt
        memory=memory_service,
        # 技能（v0.15）：把技能目录（名字 + 何时用）注入 system prompt，
        # 正文由 `use_skill` 按需展开——见 services/skills.py 的模块头
        skills=skill_service,
    )
    # 技能源的中文化（v0.28）：浏览器里那一屏是给中文用户看的，而技能描述基本都是英文。
    # 在这里接上而不是在源服务里 new：源服务只认识一个"翻译函数"，
    # 不该认识 ChatService（测试里注入一个 lambda 就够）。
    skill_source_service.use_translator(SkillBlurbService(chat_service))
    questions_service = SuggestedQuestionsService(
        bundle, chat_service, batch_concurrency=resolved.questions_concurrency
    )
    summary_service = DocumentSummaryService(
        bundle,
        chat_service,
        # 开关走运行期配置（设置页可改）。默认开：它是一次性成本换每轮问答的
        # token 节省，关掉只会让问答更贵（见 services/summary.py 的说明）
        enabled=lambda: runtime.get("ingest.summary_enabled").lower() not in ("0", "false", "no"),
    )
    # Wiki 生成（v24）：规划主题 + 逐页写作，资料直接复用上面的混合检索
    wiki_service = WikiService(bundle, chat=chat_service, retrieval=retrieval)
    kb_prompt_service = KBPromptService(bundle, chat_service)

    ingest = IngestService(
        bundle,
        # 路由按运行期配置现建解析器：设置页填完 token，下一个文件就走云端
        router=ParserRouter(runtime),
        embedder=embedder,
        embedders=embedding_resolver,
        notifier=webhooks.emit,
        # 分段出题（v23）：库上开着才用，失败不影响摄入
        questions=questions_service,
        # 文档摘要（v25）：入库时每篇一次调用，供问答上下文省 token
        summaries=summary_service,
    )

    # 可观测性服务**先建**：文档列表的进度条要判"停滞"，而那个判据（租约还在不在续）
    # 与任务中心那一列必须是同一个结论，所以两处共用这一个实例
    observability = ObservabilityService(bundle, worker_lease_seconds=resolved.worker_lease_seconds)
    documents_service = DocumentService(bundle, observability=observability)
    # 产物服务（v0.26）在建在这里：它要用摄入链路（复制一份进知识库）与文档服务
    # （入库后排队解析），而这两样都在上面就绪了。
    artifacts_service = ArtifactService(bundle, ingest=ingest, documents=documents_service)
    # 数据源要往摄入队列里塞任务，所以依赖 DocumentService（入队）与
    # IngestService（登记）两者——它们分工不同，见 services/sources.py
    sources_service = SourceService(bundle, ingest, documents_service)

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
        usage.purge_expired()
        # 任务与阶段事件这两张表只增不减，而它们都在热路径上（列表、队列概览、
        # 每行的进度条都会读）。保留期见 services/maintenance.py（§12.116）。
        MaintenanceService(bundle).prune_history()
        # 给还没有摘要的文档补摘要（v25）。挂在空闲分支上：它是"用空闲时间换
        # 后续每轮问答的 token"，一小批一小批地补，不需要用户点任何东西。
        try:
            summary_service.summarize_missing()
        except Exception:
            logger.warning("补生成文档摘要失败，跳过本轮", exc_info=True)
        # 走 lifecycle 而不是直接调存储层：它会**连磁盘上的原文一起删**。
        # 只删数据库行会把对象存储变成只增不减的垃圾场，
        # 而用户以为"7 天后就清掉了"
        lifecycle = LifecycleService(bundle)
        lifecycle.purge_expired_trash()

    lifecycle_service = LifecycleService(bundle, notifier=webhooks.emit)
    folders_service = FolderService(bundle)

    # 定时任务的执行体需要一个**装配好的 Services**（工具表、执行器、会话……都从它上面取），
    # 而 Services 要到这一行之下才存在。用一格可变的"槽"接住它：回调在应用起来之后
    # 才会被调用，那时槽里一定有值（不是懒加载的托词——这条链路上没有第二个时机）。
    runner_slot: list[Services] = []

    def _run_scheduled(scheduled_id: str) -> str:
        return run_scheduled_task(runner_slot[0], scheduled_id)

    workers = _build_workers(
        resolved.worker_concurrency,
        bundle=bundle,
        ingest=ingest,
        lease_seconds=resolved.worker_lease_seconds,
        maintain=_maintain,
        sources=sources_service,
        wiki=wiki_service,
        summaries=summary_service,
        memory=memory_service,
        schedules=schedule_service,
        run_scheduled=_run_scheduled,
    )

    services = Services(
        knowledge_bases=KnowledgeBaseService(bundle, embedder=embedder, models=registry),
        documents=documents_service,
        folders=folders_service,
        ingest=ingest,
        retrieval=retrieval,
        chat=chat_service,
        stats=StatsService(bundle),
        runtime=runtime,
        api_keys=ApiKeyService(bundle),
        idempotency=idempotency,
        chunks=ChunkService(
            bundle,
            embedder=embedder,
            embedders=embedding_resolver,
            # 手工改块后要重出这一段的题（v23）
            questions=questions_service,
        ),
        models=registry,
        usage=usage,
        users=UserService(bundle),
        auth=AuthService(bundle),
        avatars=AvatarService(bundle),
        shares=ShareService(bundle),
        lifecycle=lifecycle_service,
        batch=DocumentBatchService(bundle, documents_service, lifecycle_service, folders_service),
        maintenance=MaintenanceService(bundle),
        tabular=TabularService(bundle),
        sources=sources_service,
        observability=observability,
        conversations=conversations_service,
        artifacts=artifacts_service,
        notes=NotesService(bundle, ingest=ingest, documents=documents_service),
        note_ai=NoteAiService(chat_service),
        suggested_questions=questions_service,
        kb_prompt=kb_prompt_service,
        summaries=summary_service,
        wiki=wiki_service,
        webhooks=webhooks,
        embedder=embedder,
        reranker=reranker,
        worker=workers[0],
        workers=workers,
        load=SystemLoadService(
            bundle,
            concurrency=resolved.worker_concurrency,
            mineru_quota_pages=resolved.mineru_daily_page_quota,
            # "配没配 MinerU"问运行期配置（设置页可改），不能问启动期 Settings——
            # 用户填完令牌不重启就该生效
            mineru_configured=lambda: runtime.mineru().is_configured,
            observability=observability,
        ),
        memory=memory_service,
        workspaces=workspace_service,
        skills=skill_service,
        skill_market=skill_market_service,
        skill_sources=skill_source_service,
        plugins=plugins_service,
        commands=commands_service,
        mcp=mcp_service,
        schedules=schedule_service,
    )
    # 槽里放进刚装好的这一份：定时任务的执行体从这一刻起可用
    # （`_run_scheduled` 只在 worker 领到 SCHEDULED 任务时被调用，那时这里早已填上）
    runner_slot.append(services)
    return services


def _build_workers(
    count: int,
    *,
    bundle: StoreBundle,
    ingest: IngestService,
    lease_seconds: int,
    maintain: Callable[[], None],
    sources: SourceService,
    wiki: WikiService,
    summaries: DocumentSummaryService,
    memory: MemoryService,
    schedules: ScheduleService,
    run_scheduled: Callable[[str], object],
) -> list[TaskWorker]:
    """按 ``KYLAB_WORKER_CONCURRENCY`` 造 N 个消费者。

    **为什么是 N 个实例而不是给一个 worker 加并发**：任务表本身就是队列，
    ``claim_task`` 是原子单语句（``FOR UPDATE SKIP LOCKED``），多实例各自领各自的活
    就是天然的并发——给单实例加并发反而要自己实现"同时跑几个任务"的调度与心跳，
    等于把队列已经解决的事再做一遍。

    ``owner`` 必须**各不相同**：租约是按 owner 校验的，同名会让两个消费者互相
    认领对方的租约（``heartbeat_task`` 返回真、终态写入互相覆盖）。
    """
    if count <= 1:
        count = 1
    pid = os.getpid()
    return [
        TaskWorker(
            bundle,
            ingest,
            owner=f"worker-{pid}-{index}",
            lease_seconds=lease_seconds,
            maintain=maintain,
            # 数据源拉取没有 document_id，走 worker 里的独立分支（见 _handle_source）
            sync_source=sources.sync_now,
            # Wiki 重建同样是知识库级任务（见 _handle）
            compile_wiki=wiki.generate,
            # 记忆沉淀（v0.14）：把一轮对话交给记忆服务。**它是可选回调**——
            # 记忆关着时这个回调仍然存在，由 MemoryService 自己判断"未启用"并报错
            # （而不是在这里判，那样"关着"会表现成任务静默失败）
            capture_memory=lambda messages, session_id, user_id: memory.capture(
                messages, session_id=session_id, user_id=user_id or None
            ),
            # 补文档摘要（v25）：空闲时一小批一小批地补，不需要用户点任何东西
            summarize_gap=summaries.summarize_missing,
            # 定时任务（v0.33）：到点入队 + 到点执行。**两个回调分工明确**——
            # 调度侧只扫描与入队（快、独立循环），执行侧才跑问答（慢、在消费者线程里）
            due_schedules=schedules.enqueue_due,
            run_scheduled=run_scheduled,
        )
        for index in range(count)
    ]


@lru_cache
def get_services() -> Services:
    """进程级单例，供 FastAPI 依赖注入使用。"""
    return build_services()


def reset_services() -> None:
    get_services.cache_clear()
