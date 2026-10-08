"""服务装配（组合根的服务侧）。

与 `app/core/storage.py` 同构：这里是**唯一**把"接口"和"具体服务实现"接起来的地方，
API 层通过依赖注入拿到服务，自己不 new 任何东西。

解析器注册顺序即优先级，且**必须由本模块决定**：`parsers/` 内部禁止互相 import，
"谁先试"这种跨实现的决策只能放在 services/（工程规范 §3.3 L3）。
云端解析器（MinerU / PaddleOCR）在未配置 token 时 ``supports()`` 恒为 False，
因此**没配凭据也能跑通整条链路**。

## 一个进程、一个根

这个进程是**桌面壳的本机边车**：会话 / 笔记 / 设置 / 模型凭据都落这一台机器，
知识库在别处（另一台机器上的提供者），本机是它的客户端。服务器档随知识库产品
剥离到独立仓库一起拆掉了，所以装配里不再有"按档分流"的分支。

``Services`` 是唯一那个根。**`Services.kb` 这一格仍然在**——它装的是"本机这一侧
剩下的知识库面"：调用者能碰哪些库的判定，以及两条写进知识库的接缝
（提交字节 / 入队）。这两样今天还挂在组合根上，而 `scripts/check_domains.py` 的
KB 访问器判定靠这一格名字识别"经组合根取 KB 域服务"，所以名字不能改。

### 依赖注入

- Agent 侧与共享侧的模块注入 **`Services`**，依赖 `get_services()`；
- 还经 `Depends(get_kb_services)` 取 KB 面的那几个模块拿到的是 `get_services().kb`
  ——**进程里只有一份图**，不二次装配（否则会出现两个 `StoreBundle`、
  两个补传线程、两份运行期配置）。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from app.core.config import Settings, get_settings
from app.core.signing import ensure_url_signing_secret
from app.core.storage import build_stores
from app.services.api_key import ApiKeyService
from app.services.approvals import ApprovalRegistry
from app.services.artifacts import ArtifactService
from app.services.backup_provider import BackupProviderClient
from app.services.backup_queue import BackupQueueService
from app.services.backup_restore import BackupRestorer
from app.services.backup_snapshot import BackupSnapshotService
from app.services.chat import ChatService
from app.services.commands import CommandService
from app.services.conversation import ConversationService
from app.services.conversation_export import ConversationExportService
from app.services.credentials import CredentialsService
from app.services.embedding import build_embedder
from app.services.embedding.base import EmbeddingProvider
from app.services.embedding.deterministic import DeterministicEmbedder
from app.services.kb_cache import CachedKnowledgeMetaReader, KbMetaCacheService
from app.services.knowledge_provider import (
    EnqueueGateway,
    IngestGateway,
    KnowledgeProviderClient,
)
from app.services.legacy_import import LegacyImporter
from app.services.llm import LLMUsage
from app.services.mcp_client import MCPClientService
from app.services.memory import MemoryService
from app.services.model_registry import ModelRegistryService
from app.services.note_ai import NoteAiService
from app.services.notes import NotesService
from app.services.plugins import PluginService
from app.services.rerank import RerankProvider, build_reranker
from app.services.runtime_config import RuntimeConfigService
from app.services.schedule_runner import run_scheduled_task
from app.services.schedules import ScheduleService
from app.services.secrets import SecretStore, platform_store
from app.services.skill_blurb import SkillBlurbService
from app.services.skill_market import SkillMarketService
from app.services.skill_sources import SkillSourceService
from app.services.skills import SkillService
from app.services.system_load import SystemLoadService
from app.services.usage import UsageService
from app.services.workspace import WorkspaceService
from app.storage.base import StoreBundle

__all__ = [
    "KbServices",
    "Services",
    "build_kb_services",
    "build_services",
    "get_kb_services",
    "get_services",
    "reset_services",
]

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class KbServices:
    """本机这一侧剩下的**知识库面**。

    三样，各有各的理由：

    - ``api_keys``：**这次调用能碰哪些库**的判定。本机的调用主体只有"本机主人"一种
      （见 `api/auth.py`），`check_access` 在那一档直接放行——但判定本身仍然走它，
      而不是在协议层改成"不判"，因为"谁是主人"这件事只有一处定义才不会漂；
    - ``ingest``：**提交一份字节进知识库**的接缝。本机给它的是提供者网关
      （知识库在别处，本机不落库、不解析）；
    - ``documents``：**入队**那条接缝。本机同样只有网关那一面——远端收到上传时
      自己已经排上了，本机没有队列可管。

    **四个知识库服务本体（knowledge_bases / retrieval / tabular / lifecycle …）
    都不在这里**：它们随知识库产品搬去了 kybase，本仓库一行数据都不持有。
    """

    api_keys: ApiKeyService

    ingest: IngestGateway

    documents: EnqueueGateway

@dataclass(frozen=True, slots=True)
class Services:
    """全部服务 + 它们需要的件。

**下面若干字段的说明里还留着"服务器档怎样"的对照**：那是历史设计记录
（它让"本机为什么做成这样"读得出来）。那个档已经随知识库产品剥离拆掉了，
读的时候把它当背景，不是现状。
    """

    conversations: ConversationService
    """对话留存：会话与消息的读写（§11.2）。"""

    artifacts: ArtifactService
    """会话产物（v0.26）：Agent 做出来的文件落在哪、什么时候进知识库。
    与"文档"分开：产物先是文件，进知识库是它的一个可选去向。"""

    conversation_export: ConversationExportService
    """会话导出（M2 阶段 5）：`GET /conversations/export` 背后那一段（六型 NDJSON 流）。
    **两个档位都有**：服务器档导给本机导入器用，本机档导自己那批（同一份契约）。"""

    legacy_import: LegacyImporter | None
    """旧会话导入（M2 阶段 5）：拉 NAS 的导出流、写本机库、记账、回滚。

    **只有本机档不是 None**（服务器档的会话就是权威，没有"从别的部署导进来"
    这条动作——而台账那两张表也只在服务器不存在的本机库里）。"""

    notes: NotesService
    """笔记：Markdown 事实源 + 加入知识库（v20）。"""

    note_ai: NoteAiService
    """笔记的 AI 排版 / 润色（v20.2）。单独依赖 LLM，保住 NotesService 的"无模型也能用"。"""

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
    """长期记忆的门面（设计见 `docs/设计/记忆档案-设计-v0.1.md`）。

    一份四区档案（`PROFILE.md`）+ 变更流；写入三条路，其中隐式捕获默认关。"""

    runtime: RuntimeConfigService
    """运行期配置（凭据与模型）：设置页读写它，各 provider 每次调用现取快照。"""

    models: ModelRegistryService
    """模型注册器：供应商 → 模型目录 → 按用途绑定（调研报告 G1）。"""

    usage: UsageService
    """用量统计：按次记 token 与调用量（调研报告 G7）。"""


    load: SystemLoadService
    """负载面板数据源：CPU / 内存 / 队列深度 / 并发槽位 / 云端解析额度（§12.115）。"""

    chat: ChatService
    """快速检索对话：检索 + 提示词 + LLM，定位是让用户快速验证知识库。"""

    kb: KbServices
    """**本机这一侧剩下的知识库面**（见 :class:`KbServices`）。

    用途：`api/auth.py` 的存取判定、工具层那两条写进知识库的接缝
    （`tools.py` 的 `upload_document` / `attach_note_to_kb` / `ingest_artifact`
    与 `agent_tools.py` 的 `ingest_file`）。

    **名字不能改**：`scripts/check_domains.py` 用 `services.kb.<字段>` 这个形状识别
    "经组合根取 KB 域服务"，改名的后果是那条门禁静默失效。

    **方向是单向的**：`KbServices` 上**没有**这一格（KB 面不依赖 Agent 面）。
    """

    embedder: EmbeddingProvider
    """文本嵌入的**运行期限定**封装（见 `_RuntimeEmbedder`）。

    它与知识库在别处这件事不冲突：嵌入能力是"调用模型"的能力（地址 / 密钥 / 模型名
    在模型注册表里），不是"库里的数据"。设置页与模型注册器的「测试连接」都读它，
    而真正的检索与入库发生在提供者那一侧（那边用它自己那份配置）。
    """

    reranker: RerankProvider
    """重排的**运行期限定**封装（见 `_RuntimeReranker`）。

    与 ``embedder`` 同理：今天没有调用链用它重排（检索不在本仓库），
    它服务于设置页的 ``rerank_enabled`` 与模型注册器的「测试连接」。
    """

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

    provider: KnowledgeProviderClient | None = None
    """**知识库提供者客户端**（M3 阶段 2 建、阶段 5 收成进程级那一个实例）。

    本机档：这一份就是**全进程唯一**的那一个（`ChatService` 的检索、笔记与产物的
    入库网关、`Services.ingest`/`documents`、`stores.meta.kb` 的 reader、边车
    `Clients` 的工具表门控、`/local/provider` 端点**全从它取**）——它身上那份 30s
    握手缓存因此也只有一个，改完地址之后各处看到的必然是同一个结论。

    服务器档：``None``。它的知识库就是它自己（进程内那套一位不变），没有"第二个
    东西可以问"（R11）。

    为什么带默认值：服务器档与手工构造 ``Services`` 的地方（脚本、测试）都不该被迫
    传一个不适用的对象；"没有它"本身就是一个合法状态，而不是配置漏项。
    """

    backup_snapshot: BackupSnapshotService | None = None
    """**本机快照打包服务**（M5 阶段 2 建，阶段 4 起接上端点与队列）。

    本机档：打一份擦洗过的、可搬到别的机器的包（库 + 记忆 + 选择性产物 → tar.gz）。
    它每次调用现取运行期配置（含不含工作区产物），所以设置页改完**不必重启**。

    服务器档：``None``。那一档的库就是它自己，没有"把自己打成一份便携的包"这条动作
    （``/local/backup`` 那一族端点也只在 ``local_router`` 上，见 ``api/v1/router.py``）。

    为什么带默认值：与 ``provider`` / ``kb_cache`` 同一条理由——"没有它"是一个合法状态，
    而不是配置漏项。
    """

    backup_provider: BackupProviderClient | None = None
    """**备份提供者客户端**（M5 阶段 4 建）：本机打 NAS ``/backup/*`` 的唯一出口。

    两个身份、同一个对象：① ``/local/backup`` 与 ``/local/backup/points`` 问它的状态与
    恢复点清单；② 它是**补传队列的上传者**（``SnapshotUploader`` 那份协议），
    ``upload`` 里的两次 PUT（先 blob 后 manifest）就是它发的。全进程只有这一份，
    所以那份 30s 握手缓存与恢复点列表缓存也只有一份——改完地址各处看到的必然是同一个结论。

    服务器档：``None``。那一档**自己就是**备份的目的地：它提供 ``/backup/*``
    （``api/v1/backup.py``），没有"往另一台 NAS 传快照"这条动作。

    为什么带默认值：同 ``provider``——"没有它"是合法状态。
    """

    backup_queue: BackupQueueService | None = None
    """**备份待传队列服务**（M5 阶段 3 建，阶段 4 起在组合根里 ``start()``）。

    它持有那一个 ``backup-upload`` 守护线程（断网入队、联网补传、退避、本地队列上限）与
    "该不该自动打一份"的判据；``/local/backup`` 的 ``backlog`` 段读它的 :meth:`backlog`，
    ``POST /local/backup/snapshots`` 走它的 ``enqueue``。

    **它的线程在 ``build_services`` 里启动一次**（``start()`` = 崩溃复位
    ``uploading → pending`` + 起线程），所以"这台进程负责补传"这件事只有一个起点——
    与 worker 线程由组合根拉起的口径一致。

    服务器档：``None``（那一档没有"排队往别处传"这条动作）。

    为什么带默认值：同 ``provider``——"没有它"是合法状态。
    """

    backup_restore: BackupRestorer | None = None
    """**按点恢复服务**（M5 阶段 5 建）：把 NAS 上一份恢复点落到本机的那条路。

    两个动作、一个对象：``plan()``（dry-run：会新建哪些会话 / 哪些跳过、为什么 /
    哪些产物不在包里 / 要重配几项凭据）与 ``restore()``（真恢复：打一份本地兜底 →
    走 M2 导入器写会话 → 记忆 / 设置 / 产物落位 → 报告）。

    **会话那条链一个字都不重写**：它拿一台走 ``SnapshotFileSource`` 的 ``LegacyImporter``
    干活，所以进度与回滚复用既有两个端点（``GET /local/import/{batch}`` 与
    ``POST /local/import/{batch}/rollback``），恢复特有的那三段报告并进同一行的
    ``counts_json``（``counts["restore"]``）。

    服务器档：``None``。那一档的会话就是权威，而"整库替换"是另一件事（方案 §3.4 末尾
    那条干净路径：停边车 → 挪 ``kylab.db*`` → 再恢复）。

    为什么带默认值：同 ``provider``——"没有它"是合法状态。
    """

    kb_cache: KbMetaCacheService | None = None
    """**知识库元数据快照服务**（M4 阶段 3 建；阶段 4 起 ``/local/kb-cache/*`` 用它）。

    本机档：这一份是**全进程唯一**的那一个——reader 面（``ChatService.kb_prompt`` 经
    ``stores.meta.kb``）与页面面（``/local/kb-cache/*`` 那族端点）读的是同一份快照、
    同一套排程（单飞 / 15s 最短间隔 / 60s 失败退避）。两个入口各建一个就会各排各的，
    而 R3 的"再验证风暴"正是那么来的。

    它身上没有第二份事实：真话永远在 NAS 上，删了只丢速度（快照严格可弃，v0.3 §5.3）。

    服务器档：``None``。那一档没有"抄一份 NAS 快照"这条动作——它的知识库就是它自己，
    页面读到的已经是权威数据，再留一份只会多出一份会说谎的副本。

    为什么带默认值：与 ``provider`` 同一条理由——"没有它"是一个合法状态，
    而不是配置漏项。
    """

    secrets: SecretStore | None = None
    """**系统钥匙串**（M5 阶段 6）：凭据的家（本机档就是 Windows 凭据管理器）。

    两个服务从它取：``runtime``（收编过的那几个设置键）与 ``models``（供应商的 API Key）。
    这一位是**进程级那一个**对象——两处各建一个就会出现"设置页存进去了、聊天那边读不到"
    这类最难查的分叉（两边都"成功"了）。

    服务器档：``NullSecretStore``（R14）。那一档**没有**系统钥匙串，它库里那份凭据照旧
    是凭据的家；`secrets.use_keychain()` 为假，两个服务走原来的库路径。
    手工构造的 ``Services``（用例、脚本）留 ``None``——同样是"没有钥匙串"那一档。

    为什么带默认值：同 ``provider``——"没有它"是合法状态。
    """

    credentials: CredentialsService | None = None
    """**旧明文收编**（M5 阶段 6）：把库里的明文凭据搬进钥匙串的那个服务。

    它只有三个动作（``status`` / ``migrate`` / NAS 钥匙那三个方法），而且是**显式的**：
    没有任何调用点会顺手调 ``migrate``（不静默迁移，方案 §4.2）。

    两种档都建：钥匙串不可用时 ``status()`` 如实回 ``store: unavailable`` 且
    ``pending_migration: 0``——那种机器上"等着迁"这件事不存在（库就是凭据的家）。
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

    @property
    def supports_media(self) -> bool:
        """当前配置的实现能不能嵌图片 / 视频。

        **问的是"这一档配置"而不是自己**：这一层只是个转发壳，真正的能力在
        `build_embedder` 按协议建出来的那个实现身上（`EmbeddingProvider.supports_media`）。
        摄入与解析路由据此决定"媒体文件走不走媒体接口"。
        """
        return bool(self.current.supports_media)

    def embed(self, texts):  # type: ignore[no-untyped-def]
        started = time.monotonic()
        vectors = self.current.embed(texts)
        self._record(texts, started)
        return vectors

    def embed_media(self, data: bytes) -> list[float]:
        """媒体向量：**转发给当前配置的实现**（不支持时它自己会报错说明原因）。

        用量**不在这里记**：`_record` 记的是文本条数与按字符数估的 token，
        对一份几 MB 的视频没有意义（会得出一个荒唐的"token 数"）。媒体那条路的
        耗时与成败在日志里可见——宁可少一行仪表，也不要一行假数字。
        """
        return self.current.embed_media(data)

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

    def rerank(
        self, *, query: str, documents: Sequence[str], top_n: int
    ) -> list[tuple[int, float]]:
        return build_reranker(self._runtime).rerank(
            query=query, documents=documents, top_n=top_n
        )




def _build_graph(
    settings: Settings | None = None, stores: StoreBundle | None = None
) -> tuple[KbServices, Services]:
    """一条链装配出两个根（共享件在两边是同一个实例）。"""

    resolved = settings or get_settings()
    bundle = stores or build_stores(resolved)

    # 系统钥匙串（M5 阶段 6）：**先建它**，因为下面两个服务都要从它取。
    # 本机用这台机器上真正的钥匙串（Windows 凭据管理器；别的平台是 Null）。
    secrets: SecretStore = platform_store()
    # 注册器先建、再交给 runtime：runtime 的快照要**优先取注册表里绑定的模型**，
    # 未绑定时才回退到设置页那套字段（叠加层，见 services/model_registry.py）
    registry = ModelRegistryService(bundle, secrets=secrets)
    runtime = RuntimeConfigService(bundle, resolved, registry=registry, secrets=secrets)
    # 旧明文收编（M5 阶段 6）：**显式动作**的服务，没有任何调用点会顺手调它
    # （不静默迁移）。钥匙串不可用时它如实报 `store: unavailable`
    # 且 `pending_migration: 0`（那种机器上"等着迁"这件事不存在）。
    credentials = CredentialsService(bundle, secrets)
    # 工作区放在数据目录下（见 services/memory.py 与设计文档 §2.2）：
    # 与其它数据一起备份/迁移，一个部署只有一处要备份。
    # 它也要 data_dir：要拦住「把数据目录当工作区」这种配置
    # （指向那里等于绕过账号隔离，见 services/workspace.py 的第三道校验）
    workspace_service = WorkspaceService(bundle, resolved.data_dir)
    # 技能：扫描仓库自带 skills/ 与数据目录 data/skills/（见 services/skills.py）
    # 技能的门控要读运行期配置（`requires.config`）：把"读一个配置键"的能力注进去，
    # 而不是把整个 runtime 塞给技能服务——技能层只需要这一个动作。
    # 单条技能的启停（`chat.disabled_skills`）也存在运行期配置里。
    skill_service = SkillService(
        resolved.data_dir, config_value=runtime.get, config_set=runtime.set
    )
    # 技能市场（v0.16）：安装/卸载。**只写 data/skills/**——仓库自带的那份动不了
    skill_market_service = SkillMarketService(resolved.data_dir, skill_service)
    # 技能源（v0.27）：从 GitHub 仓库浏览技能。**出站只在这一层**——
    # 前端永远不直接打 GitHub（匿名配额 60 次/小时，一分钟就能打爆，见该模块说明）
    skill_source_service = SkillSourceService(resolved.data_dir, token=resolved.github_token or "")
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

    # 记忆服务：**内容全在本地**（`data/memory/` 下的 Markdown）。出网只有一个动作
    # ——隐式捕获在信号出现的那一轮问一次对话模型（`memory.capture`，**默认关**），
    # 而它用的是运行期绑定的那条模型通道（见 `MemoryService._ask_model`）。
    # 所以这个服务不需要嵌入能力，也不需要存储：构造它是纯本地的。
    memory_service = MemoryService(runtime, resolved.data_dir)

    # 对话的 token 用量通过回调记（G7）：ChatService 不该依赖统计服务，
    # 那会让"记不记账"变成它的必需前提
    def _record_chat_usage(**kwargs: object) -> None:
        usage.record(**kwargs)  # type: ignore[arg-type]

    conversations_service = ConversationService(bundle)

    # 斜杠命令（v0.44，P1-2）：扫数据目录与仓库自带的 `commands/`（放进来一个 md 文件
    # 就是一条命令）。`conversations` 只用来读"这条会话上一轮的档"——模式观测的基线
    # （见 services/commands.ModeWatch），进程内不重复读。
    #
    # `skills` 是"技能即命令"那一半：每个技能注册一条 `/<技能名> [任务]`，
    # 正文仍由 `ChatService.skill_prompt` 注入（只有一处实现）。
    # `skill_summaries` 给菜单那一行用中文简介，与能力页读的是同一份数据
    # （市场装的在安装清单里、仓库自带的在 SKILL.md 的 frontmatter 里）。
    def _skill_summaries() -> dict[str, str]:
        """技能的中文简介（技能名 → 简介）；读不出来就当没有。

        两个来源，与能力页（api/v1/skills.py 的 `_out`）**同一份数据、同一套优先序**：
        市场装的技能在安装清单里（`data/installed.json`），仓库自带的写在
        `SKILL.md` 的 frontmatter 里（`SkillRecord.summary`）。**两边都有时以清单那份
        为准**（市场那份是为中文界面存的、更短更贴；frontmatter 那份常是英文），
        所以下面先收 frontmatter 那批、再用清单覆盖——顺序必须与 `_out` 的
        `summary or record.summary` 一致，反了就会出现"能力页一句、菜单里另一句"。

        坏掉只是菜单里少几行中文，不该让命令表跟着 500。
        """
        out: dict[str, str] = {}
        try:
            for record in skill_service.list():
                if record.summary:
                    out[record.name] = record.summary
        except Exception:  # 扫技能失败不影响命令表的其余部分
            logger.warning("读技能自带的中文简介失败", exc_info=True)
        try:
            records = skill_market_service.installed_records()
        except Exception:  # 清单坏了不影响命令表（只是少几行中文简介）
            return out
        for name, item in records.items():
            summary = str(item.get("summary") or "")
            if summary:
                out[name] = summary
        return out

    commands_service = CommandService(
        resolved.data_dir,
        conversations=conversations_service,
        skills=skill_service,
        skill_summaries=_skill_summaries,
    )
    # 知识库提供者（M3 阶段 3）：本机打知识库的唯一出口（握手 / 检索 / 入库 / 元数据，
    # 见 `services/knowledge_provider.py`）。
    #
    # **恒建，不看地址有没有值**：地址与钥匙是**每次调用现取**的（`provider.target()`
    # 现读运行期设置），所以"现在没配、设置页填上之后立刻生效"这条要成立，对象就得先在这儿。
    # 没配时它如实回 `unconfigured`，两个网关的 `submit` 抛 `KnowledgeBaseUnavailable`
    # （既有 503 映射）——而不是回一个假的空结果，也不是 500。
    #
    # **它就是进程级那一个实例**：`/local/provider` 的判定源、边车工具表门控被它
    # 一起回答，于是不可能出现"端点说 ready、工具表说不 ready"这种两处各答一半的局面。
    provider = KnowledgeProviderClient(settings=resolved, get_setting=runtime.get)
    # **知识库元数据快照（M4 阶段 3）**：页面面与 reader 面共用的那一份服务。
    #
    # 建在**这里**：① `bundle.kb_cache` 是本机那张缓存表；② 键空间的第一列是
    # **提供者地址**，而地址是每次现取的能力（`provider.target()` 现读运行期设置），
    # 那份能力只有服务层有；③ 它得是**全进程唯一的一个**（reader 面与
    # `/local/kb-cache/*` 共用同一套排程），所以与 `provider` 一样挂在 `Services` 上
    # 由端点去取。
    #
    # 地址**每次现取**：`provider_key` 是个闭包而不是装配那一刻算出来的字符串——
    # 设置页改完地址，下一次读/写/清立刻落在新的那片键空间上。
    local_provider = provider
    kb_cache = KbMetaCacheService(
        bundle.kb_cache, provider_key=lambda: local_provider.target().base_url
    )
    # **KB 侧那一条读线的装配就是这一处**：把 reader 挂到本机档 `stores.meta.kb` 上
    # （`_Router.kb` 是公开属性，`split_impl/router.py`）。
    #
    # 为什么是后挂、不是构造参数：① **层序**——`core/storage.py` 先于本文件跑
    # （上面那行 `bundle = stores or build_stores(resolved)`），reader 那时还没出生；
    # ② **运行期配置**——reader 要的是"能随设置改地址"（`provider.target()` 每次现取），
    # 那份能力只有服务层有。这一处注入**只在装配期发生一次**，也不动
    # `split_impl` 的"路由表构造时定下"那条纪律。
    #
    # **为什么缓存包在 reader 外面**：`stores.meta` 与 `services/` 的调用点因此
    # 一个字不用改，缓存只在对象图上多一个节点；而"页面面"读的是**同一个服务**的
    # 另一面，两个读面共一份快照、一套排程。
    bundle.meta.kb.bind_reader(
        CachedKnowledgeMetaReader(inner=provider.knowledge_meta(), cache=kb_cache)
    )  # type: ignore[attr-defined]

    # **下载签名密钥**：本机**没有任何初始化流程**（它不挂 `/auth/*`），而它的
    # `kylab.db` 是全新的——不在装配时补这一下，`auth.url_signing_secret` 就永远是
    # 空的，于是"下载签名"这条线上的每个端点都回 503（笔记配图 / 产物下载 / 会话文件）。
    #
    # 放在这里的三个理由：① 它只要 `bundle.meta`，而这一层手上有完整的库；
    # ② 与"本机独有的那几件"同一处，读代码的人一眼看得到补了哪些东西；
    # ③ 它是**幂等**的（见 `core/signing.ensure_url_signing_secret`）——
    # 已有就不动，绝不每次启动换一把（换了的话已经发出去的链接会一起失效）。
    ensure_url_signing_secret(bundle.meta)

    # **备份那几件**（M5 阶段 4/5）。
    #
    # 分工是一条直线（与上面"提供者 + 缓存"同构）：
    #   BackupSnapshotService（打包：库 + 记忆 + 选择性产物 → 擦洗过的 tar.gz）
    #     → BackupQueueService（排队与补传：退避、上限、那一个 backup-upload 线程）
    #       → BackupProviderClient（上传者：先 blob 后 manifest 两次 PUT）
    # 而 `backup_provider` **同时**是 `/local/backup` 的状态源与恢复点清单源（两个读面、
    # 一个对象、一份 30s 缓存）。几件都在这一层建的理由与 `provider` / `kb_cache` 一样：
    # 它们要的是"能随设置改地址/改开关"的运行期能力，而那份能力只有服务层有。
    #
    # 设备身份从引导级来（壳的 `--device-id` → `KYLAB_DEVICE_ID` → Settings）：
    # **没有就是没有**（`create()` 会如实拒绝打快照，绝不编一个 id）。
    backup_snapshot = BackupSnapshotService(
        stores=bundle,
        data_dir=resolved.data_dir,
        device_id=resolved.device_id,
        runtime_config=runtime,
    )
    backup_provider = BackupProviderClient(settings=resolved, get_setting=runtime.get)
    backup_queue = BackupQueueService(
        stores=bundle,
        data_dir=resolved.data_dir,
        uploader=backup_provider,
        snapshotter=backup_snapshot,
        runtime_config=runtime,
    )
    # **线程与崩溃复位的唯一起点**：`start()` = 复位 `uploading → pending` + 起那一个
    # `backup-upload` 线程。放在组合根而不是放进某个端点：被谁先问到不该决定
    # "这台机器有没有在补传"。
    backup_queue.start()
    # 按点恢复：它读的是**同一个** `bundle`（快照读面 + 导入台账），
    # 打本地兜底用的是上面那一个打包器——几件共用一份对象，不各建各的。
    backup_restore = BackupRestorer(
        stores=bundle,
        data_dir=resolved.data_dir,
        provider=backup_provider,
        snapshotter=backup_snapshot,
        runtime_config=runtime,
    )

    chat_service = ChatService(
        runtime,
        # stores 用于读库级提示词与文档摘要
        stores=bundle,
        usage_recorder=_record_chat_usage,
        # 会话读写（v20.1）：上下文压缩要读历史、写摘要
        conversations=conversations_service,
        # 长期记忆（v0.14）：非空时把 MEMORY.md / SOUL.md 注入 system prompt
        memory=memory_service,
        # 技能（v0.15）：把技能目录（名字 + 何时用）注入 system prompt，
        # 正文由 `use_skill` 按需展开——见 services/skills.py 的模块头
        skills=skill_service,
        # KB 检索（M2 §2.2）：整段委托给提供者客户端（每次调用现取地址与钥匙）。
        # **它是从进程里查知识库的唯一一条路**（`ChatService.retrieve_sources`）。
        knowledge=provider,
    )
    # 技能源的中文化（v0.28）：浏览器里那一屏是给中文用户看的，而技能描述基本都是英文。
    # 在这里接上而不是在源服务里 new：源服务只认识一个"翻译函数"，
    # 不该认识 ChatService（测试里注入一个 lambda 就够）。
    skill_source_service.use_translator(SkillBlurbService(chat_service))

    # **入库那两个接缝就是这一处**：产品件的三个构造点（产物服务、笔记服务、
    # `Services` 上那两格）共用同一对网关对象。"提交一份字节"与"入队"都归提供者客户端
    # ——知识库在别处，本机不落库、不解析、也没有队列可管。
    ingest_gateway = provider.ingest_gateway()
    # 空操作：上传口带 `start=true`，远端那边自己入队了。理由与实现都在
    # `knowledge_provider._EnqueueGateway` 上，不在这里再抄一份。
    enqueue_gateway = provider.enqueue_gateway()

    artifacts_service = ArtifactService(
        bundle, ingest=ingest_gateway, documents=enqueue_gateway
    )

    # 会话导出（M2 阶段 5）：`GET /conversations/export` 背后那一段。
    export_service = ConversationExportService(
        bundle, conversations=conversations_service, artifacts=artifacts_service
    )
    # 旧会话导入（M2 阶段 5）：来源与令牌从引导配置来（`KYLAB_SERVER_URL` /
    # `KYLAB_TOKEN`，壳起边车时传的就是它们）——**令牌不经过 HTTP 请求体**，
    # 也就没有第二条让它进日志/落库的路。
    legacy_importer = LegacyImporter(
        bundle,
        data_dir=resolved.data_dir,
        source=(resolved.server_url or "").rstrip("/"),
        token=resolved.token or "",
    )

    # 定时任务的执行体需要一个**装配好的 Services**（工具表、执行器、会话……都从它上面取），
    # 而 Services 要到这一行之下才存在。用一格可变的"槽"接住它：回调在应用起来之后
    # 才会被调用，那时槽里一定有值（不是懒加载的托词——这条链路上没有第二个时机）。
    runner_slot: list[Services] = []

    def _run_scheduled(scheduled_id: str) -> str:
        return run_scheduled_task(runner_slot[0], scheduled_id)

    kb = KbServices(
        api_keys=ApiKeyService(),
        ingest=ingest_gateway,
        documents=enqueue_gateway,
    )
    load = SystemLoadService(
        bundle,
        concurrency=resolved.worker_concurrency,
        mineru_quota_pages=resolved.mineru_daily_page_quota,
        # "配没配 MinerU"问运行期配置（设置页可改），不能问启动期 Settings——
        # 用户填完令牌不重启就该生效
        mineru_configured=lambda: runtime.mineru().is_configured,
    )
    services = Services(
        chat=chat_service,
        runtime=runtime,
        models=registry,
        usage=usage,
        embedder=embedder,
        reranker=reranker,
        conversations=conversations_service,
        artifacts=artifacts_service,
        conversation_export=export_service,
        legacy_import=legacy_importer,
        notes=NotesService(bundle, ingest=ingest_gateway, documents=enqueue_gateway),
        note_ai=NoteAiService(chat_service),
        load=load,
        memory=memory_service,
        workspaces=workspace_service,
        skills=skill_service,
        skill_market=skill_market_service,
        skill_sources=skill_source_service,
        plugins=plugins_service,
        commands=commands_service,
        mcp=mcp_service,
        schedules=schedule_service,
        # **进程级那一个提供者实例**：上面建的 `provider` 直接挂在这里。
        # 挂它的理由与用途见字段说明——一句话是"让全进程只有一份握手缓存"，
        # 而 `/local/provider`（判定源）与边车的工具表门控都从它取。
        provider=provider,
        # **进程级那一个快照服务**：`/local/kb-cache/*` 那族端点从 `Services` 上取它。
        kb_cache=kb_cache,
        # **备份那几件**：`/local/backup` 那一族从它们取数；补传线程已经起好了。
        backup_snapshot=backup_snapshot,
        backup_provider=backup_provider,
        backup_queue=backup_queue,
        backup_restore=backup_restore,
        # **钥匙串与收编**：上面建的那两份。`/local/secrets` 那两个端点从它们取数；
        # 两个服务（runtime / models）已经拿着同一个 `secrets` 对象了。
        secrets=secrets,
        credentials=credentials,
        kb=kb,
    )
    # 槽里放进刚装好的这一份：定时任务的执行体从这一刻起可用
    # （`_run_scheduled` 在调度器领到到点的任务时被调用，那时这里早已填上）
    runner_slot.append(services)
    # 登记它那一个**守护线程**（见 `_BACKUP_QUEUES` 的说明）：`reset_services`
    # 要把"这份服务图被扔掉了"这件事对线程也说到，否则它会继续碰旧的数据目录。
    _BACKUP_QUEUES.append(backup_queue)
    return kb, services


def build_kb_services(
    settings: Settings | None = None, stores: StoreBundle | None = None
) -> KbServices:
    """装配 **KB 面的根**（进程里只有一份图，它就是 `Services.kb`）。"""
    return _build_graph(settings, stores)[0]


def build_services(
    settings: Settings | None = None, stores: StoreBundle | None = None
) -> Services:
    """装配 **服务根**（含 `Services.kb` 那一格）。"""
    return _build_graph(settings, stores)[1]


@lru_cache
def get_services() -> Services:
    """进程级单例，供 FastAPI 依赖注入使用。"""
    return build_services()


def get_kb_services() -> KbServices:
    """KB 面的根（供 `api/auth.py` 那几处注入）。

    **它就是根上那一格**：进程里只有一份图，不二次装配——否则会出现两个
    `StoreBundle`、两个补传线程、两份运行期配置。与 `get_services()` 一样是
    进程级单例（`reset_services()` 会一起清掉）。
    """
    return get_services().kb


_BACKUP_QUEUES: list[BackupQueueService] = []
"""本进程建过的待传队列（**只为让 `reset_services` 能停掉它们那一个线程**）。

为什么需要这一份登记：``backup-upload`` 是**守护线程**，它按节拍去碰本机库与
``backup/pending/``——而 ``reset_services()`` 的语义是"把这份进程级服务图扔掉"。
不登记的话，被扔掉的那一份会让线程接着跑：测试里表现为"tmp 目录都被清了它还在写"
（Windows 上就是一句 `PermissionError`），生产里则是"重装服务图之后还有旧线程在传"。
登记进来，`reset_services()` 就有东西可停（`stop()` 幂等，停一次就够）。
"""


def reset_services() -> None:
    for queue in _BACKUP_QUEUES:
        queue.stop()
    _BACKUP_QUEUES.clear()
    get_services.cache_clear()
