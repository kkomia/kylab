"""存储抽象层：接口与数据记录。

纪律（工程规范 §3.3）：

- ``services/`` 只允许 import 本模块的接口，**禁止 import** ``storage/sqlite_impl/``；
- 本模块内不得出现任何 SQLite 方言（SQL、连接对象、``rowid`` 语义），
  以保证未来平级新增 PostgreSQL 实现时接口不用改（《架构设计 v0.2》§8.3 迁移后门）。

关于 embedding 维度（M1 决策 D4）：维度**不是全局常量**，而是每个知识库的属性
（``KnowledgeBaseRecord.embedding_model_id`` / ``embedding_dim``），
向量表按知识库分区、建表时使用该库的维度。这样换模型/换 endpoint 的规则
（《架构设计 v0.2》§6.4）可以在运行时校验，而不必锁死 schema。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from app.models.enums import (
    ApiKeyPermission,
    DataSourceKind,
    DocumentStage,
    SharePermission,
    TaskKind,
    TaskState,
    TrashKind,
    UserRole,
)

__all__ = [
    "ApiKeyRecord",
    "ChunkRecord",
    "DataSourceRecord",
    "DocumentPartRecord",
    "DocumentRecord",
    "FullTextStore",
    "ImageRecord",
    "KnowledgeBaseRecord",
    "MetaStore",
    "ObjectStore",
    "ParseResultRecord",
    "SearchHit",
    "SessionRecord",
    "ShareRecord",
    "StorageError",
    "StoreBundle",
    "TaskRecord",
    "TrashRecord",
    "VectorDimensionMismatch",
    "VectorMatch",
    "VectorStore",
    "WebhookRecord",
]


@dataclass(frozen=True, slots=True)
class StoreBundle:
    """五个仓储的聚合视图（由组合根填充）。

    ``services/`` 依赖这个类型就能拿到全部存储能力，而**不必 import 任何具体实现**——
    字段类型全是接口，组合根 `app/core/storage.py` 负责把实现塞进来。
    """

    meta: MetaStore
    vectors: VectorStore
    fulltext: FullTextStore
    objects: ObjectStore
    tabular: TabularStore
    """表格结构化副本（DuckDB）。只有 CSV/Excel 会用，其余文档不碰它。"""


class StorageError(Exception):
    """存储层错误基类：让 services 不必 import 具体实现就能捕获。"""


class VectorDimensionMismatch(StorageError):
    """向量维度与既有分区不一致。

    架构 §6.4：维度相同不等于向量空间兼容，**维度不同更是绝对不能混写**——
    静默写入只会让检索结果悄悄错掉，所以这里必须硬失败。
    """


# --------------------------------------------------------------------- 对象存储的
# 逻辑布局与寻址规则放在接口层：services 需要按同样的规约生成 Key，
# 但**不能**去 import 具体实现（那会踩到工程规范 §3.3 的 L2 规则）。

ORIGINALS = "originals"
MARKDOWN = "markdown"
IMAGES = "images"

SAFE_KEY_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
)
"""存储 Key 与回收站 ID 允许的字符：它们会拼进文件路径，必须白名单化。"""


def content_key(kind: str, content_hash: str, suffix: str = "") -> str:
    """按内容 hash 生成存储 Key，例如 ``content_key(ORIGINALS, sha, ".pdf")``。

    两级散列目录（``originals/ab/abcdef…pdf``）避免单目录堆几万文件；
    相同内容天然同路径，重复上传不会产生第二份。
    """
    if not content_hash:
        raise ValueError("content_hash 不能为空")
    digest = "".join(char for char in content_hash if char in SAFE_KEY_CHARS)
    if not digest:
        raise ValueError(f"content_hash 不含可用字符：{content_hash!r}")
    return f"{kind}/{digest[:2]}/{digest}{suffix}"


# --------------------------------------------------------------------------- 记录（值对象）


@dataclass(slots=True)
class KnowledgeBaseRecord:
    """知识库。

    ``embedding_model_id`` 一旦入库即冻结：库内已有向量时不允许更换模型，
    换 endpoint 时模型 ID 必须一致（《架构设计 v0.2》§6.4）。
    """

    id: str
    name: str
    embedding_model_id: str
    embedding_dim: int
    embedding_base_url: str | None = None
    chunk_strategy: str = "fixed"
    chunk_size: int = 512
    chunk_overlap: int = 64
    owner_id: str | None = None
    """归属账号（v10）。``None`` = 账号体系启用前的老数据，
    由 setup 向导认领给首个管理员（`services/auth.py`）。"""
    embedding_model_pk: str | None = None
    """所选的**注册模型**主键（v11）。嵌入模型是知识库属性而非全局设置：
    建库时从注册表里挑一个（文献量小的库可用高精度模型，量大的用小模型提速）。
    ``None`` = 没显式选，运行时回退到注册表的默认槽位 / 设置页配置。
    凭据不落这里——只在注册表存一份，运行时按 pk 解析。"""
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(slots=True)
class DocumentRecord:
    """文档。大文件切分后，本记录代表用户看到的那一个文件。"""

    id: str
    knowledge_base_id: str
    name: str
    source_kind: DataSourceKind
    content_hash: str
    stage: DocumentStage
    size_bytes: int = 0
    mime_type: str | None = None
    page_count: int | None = None
    is_split: bool = False
    error: str | None = None
    uploaded_by: str | None = None
    """上传者的使用者 id（G6）。``None`` = 系统摄入或名册启用前的老数据，
    界面据此显示"未记录"，而不是编一个名字出来。"""
    folder_id: str | None = None
    """所在目录（v13）。``None`` = 未归档（根目录）。"""
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(slots=True)
class FolderRecord:
    """知识库内的目录（v13）。

    **单层、不嵌套**：个人知识库的规模下，一层分类就够把不同用途的文件分开，
    而嵌套会立刻带来拖拽跨层、路径拼接、删除策略一串复杂度。
    """

    id: str
    kb_id: str
    name: str
    created_at: datetime | None = None


@dataclass(slots=True)
class DocumentPartRecord:
    """子文件（大文件强制切分后的页范围片段，UI 显示为可展开的子文件树）。

    页码偏移用于合并时把子文件的页号重映射回原文（《架构设计 v0.2》§4.2）。
    """

    id: str
    document_id: str
    part_index: int
    page_start: int
    page_end: int
    stage: DocumentStage
    error: str | None = None


@dataclass(slots=True)
class ChunkRecord:
    """切块。``chunk_id`` 稳定、``content_hash`` 用于增量更新时对齐新旧序列。"""

    chunk_id: str
    document_id: str
    knowledge_base_id: str
    part_id: str | None
    ordinal: int
    text: str
    content_hash: str
    heading_path: str | None = None
    page: int | None = None
    image_ids: Sequence[str] = field(default_factory=tuple)
    disabled: bool = False
    """人工禁用（§G3）。被禁用的块**不再参与检索**，但仍留在库里——
    表格切碎、公式拆开这类"切得不好"的块，用户往往想留着待改，而不是直接删掉。"""


@dataclass(slots=True)
class ImageRecord:
    """图片（位置锚点方案，图片不入向量库，只记位置）。"""

    image_id: str
    document_id: str
    storage_path: str
    page: int | None = None
    bbox: str | None = None
    caption: str | None = None


@dataclass(slots=True)
class ParseResultRecord:
    """解析中间产物（分层持久化，升级解析器时只重跑下游）。"""

    document_id: str
    part_id: str | None
    parser_name: str
    markdown_path: str
    probe_meta: dict[str, Any] = field(default_factory=dict)
    created_at: datetime | None = None


@dataclass(slots=True)
class TaskRecord:
    """任务。租约字段支撑"进程崩溃后超时回收 → 断点续跑"。"""

    id: str
    kind: TaskKind
    state: TaskState
    payload: dict[str, Any] = field(default_factory=dict)
    document_id: str | None = None
    part_id: str | None = None
    attempts: int = 0
    max_attempts: int = 5
    lease_owner: str | None = None
    lease_expires_at: datetime | None = None
    next_run_at: datetime | None = None
    error: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(slots=True)
class DataSourceRecord:
    """数据源（本地上传 / HTML / RSS / WebDAV 预留）。"""

    id: str
    knowledge_base_id: str
    kind: DataSourceKind
    name: str
    config: dict[str, Any] = field(default_factory=dict)
    etag: str | None = None
    last_pulled_at: datetime | None = None
    enabled: bool = True


@dataclass(slots=True)
class ApiKeyRecord:
    """API Key：绑定知识库范围 + 只读/读写（《架构设计 v0.2》§3.2）。"""

    id: str
    name: str
    key_hash: str
    permission: ApiKeyPermission
    knowledge_base_ids: Sequence[str] = field(default_factory=tuple)
    key_prefix: str = ""
    """明文的前若干位，**仅用于界面分辨"哪把是哪把"**。

    明文本身永不落库；这一段来自高熵随机串，不足以定位任何密钥（见 migrations 002）。
    """
    created_by: str | None = None
    """创建这把钥匙的账号 id（v10）。``None`` = 账号体系启用前发放的老钥匙。"""
    created_at: datetime | None = None
    last_used_at: datetime | None = None


@dataclass(slots=True)
class WebhookRecord:
    """Webhook 订阅（异步事件推送通道）。"""

    id: str
    url: str
    events: Sequence[str] = field(default_factory=tuple)
    secret: str | None = None
    enabled: bool = True


@dataclass(slots=True)
class TrashRecord:
    """回收站条目：原文保留 7 天，向量已立即删除（《架构设计 v0.2》§6.2）。"""

    id: str
    document_id: str
    kind: TrashKind
    storage_path: str
    expires_at: datetime
    created_at: datetime | None = None


@dataclass(slots=True)
class IdempotencyRecord:
    """一次带幂等键的请求。

    ``response`` 为空表示"已经占住这个键，但业务还没跑完"——重放时据此回 409
    而不是让人以为没收到。见 ``services/idempotency.py``。
    """

    key: str
    request_hash: str
    response: dict[str, object] | None = None
    created_at: datetime | None = None


@dataclass(slots=True)
class ConversationRecord:
    """一次对话（会话）。

    ``title`` 由首轮提问生成——让用户自己起名字的对话工具，最后满屏都是"新对话"。
    """

    id: str
    title: str = ""
    kb_ids: Sequence[str] = field(default_factory=tuple)
    owner_id: str | None = None
    """归属账号（v10）。``None`` = 老数据，setup 时认领给首个管理员。"""
    model_pk: str | None = None
    """该会话选用的注册模型（v12）。``None`` = 走全局默认（注册表 chat 槽位）。"""
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(slots=True)
class ChatMessageRecord:
    """会话里的一条消息。

    ``sources`` 是**引用快照**（当轮命中的原文出处），不是每轮重新检索的结果：
    历史回答当时依据的是哪几段，事后回看必须还是那几段，否则引用编号就对不上了。
    """

    id: str
    conversation_id: str
    role: str
    content: str
    sources: Sequence[dict[str, object]] = field(default_factory=tuple)
    created_at: datetime | None = None


@dataclass(slots=True)
class UserRecord:
    """使用者。**v10 起是名册与账号的合体**：

    - 只有 ``name`` 的是名册条目（纯归属标注，历史数据）；
    - 有 ``username`` + ``password_hash`` 的才是可登录账号。

    两件事共用一张表而不是分开：账号本来就要回答"这是谁"，
    另起一张表会让"归属标注"与"登录主体"成为两套需要互查的身份。
    """

    id: str
    name: str
    note: str = ""
    username: str | None = None
    """登录名。``None`` = 纯名册条目，不能登录。"""
    password_hash: str | None = None
    """argon2 哈希。慢哈希是口令的底线（`core/security.py` 的 SHA-256 不得用于口令）。"""
    role: UserRole = UserRole.MEMBER
    disabled: bool = False
    """被管理员禁用的账号：登录拒绝，既有 session 在下次校验时失效。"""
    created_at: datetime | None = None


@dataclass(slots=True)
class SessionRecord:
    """一条登录会话。``id`` 是明文 token 的 SHA-256——**明文不落库**（与 API Key 同纪律）。"""

    id: str
    user_id: str
    expires_at: datetime
    created_at: datetime | None = None
    last_seen_at: datetime | None = None


@dataclass(slots=True)
class ShareRecord:
    """知识库分享：owner 把库授给另一个成员（读/写两档）。"""

    kb_id: str
    user_id: str
    permission: SharePermission
    created_at: datetime | None = None


@dataclass(slots=True)
class UsageEventRecord:
    """一次模型调用的用量（调研报告 G7）。

    ``reported`` 记录"供应商到底报没报用量"：OpenAI 兼容协议里 ``usage`` 是可选的，
    很多自建网关不回。**必须与"真的用了 0 token"区分开**——
    否则统计页会把"没报"画成"没用"，那是在撒谎。
    """

    id: str
    kind: str
    """``chat`` / ``embedding`` / ``rerank``。"""
    provider: str = ""
    model_id: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    items: int = 0
    """这一批处理了几条（向量化按条数，对话为 1）。供应商不报 token 时，
    条数是唯一还能反映"干了多少活"的量。"""
    duration_ms: int = 0
    source: str = "none"
    """这个数字哪来的：``reported``（供应商实测）/ ``estimated``（我们估算）/
    ``none``（供应商没报，也没得估）。

    **三态而不是布尔**：把"自己按字符数估的"和"供应商真报的"混成一类，
    会让统计页显示一个假精度——用户拿它做成本判断就偏了。
    """
    created_at: datetime | None = None

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    @property
    def reported(self) -> bool:
        """是否实测（供应商真的报了）。"""
        return self.source == "reported"


@dataclass(slots=True)
class ModelProviderRecord:
    """模型供应商：一个 base_url + 一把凭据（调研报告 G1）。

    **为什么不复用 ``app_settings`` 里的 ``embedding.base_url`` 那套**：
    那套的口径是"全局各一套凭据"，换模型就得覆盖旧凭据；而成熟产品（6/6）
    都是"供应商可注册多条、模型可注册多个"——同一个 base_url 下往往同时要用
    好几个模型（便宜的做向量化、贵的做对话）。两者不是同一件事。
    """

    id: str
    kind: str
    """``llm`` / ``embedding`` / ``rerank`` / ``parser``：这家供应商提供哪类服务。"""
    name: str
    base_url: str = ""
    api_key: str = ""
    enabled: bool = True
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(slots=True)
class RegisteredModelRecord:
    """模型目录里的一条（G1）。

    ``capabilities`` 用集合存（落库为 JSON 数组）：一个模型能做什么随供应商与版本而变，
    用固定布尔列会僵化——每加一种能力就要改表。
    """

    id: str
    provider_id: str
    model_id: str
    label: str = ""
    dim: int | None = None
    capabilities: Sequence[str] = field(default_factory=tuple)
    options: dict[str, object] = field(default_factory=dict)
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(slots=True)
class SearchHit:
    """检索命中。``score`` 的含义随来源不同（向量距离 / BM25 / RRF 融合分）。"""

    chunk_id: str
    document_id: str
    knowledge_base_id: str
    text: str
    score: float
    source: str
    page: int | None = None
    heading_path: str | None = None
    image_ids: Sequence[str] = field(default_factory=tuple)


@dataclass(slots=True)
class VectorMatch:
    """向量召回结果（未融合前的原始命中）。"""

    chunk_id: str
    distance: float


# --------------------------------------------------------------------------- 接口


class MetaStore(ABC):
    """元数据仓储：知识库、文档、子文件、chunk、图片、任务、数据源、凭据、设置。

    任务表放进本接口是有意为之——任务状态属于元数据，且与文档状态同库同事务，
    保证"状态推进"与"任务入队"不会出现半写。
    """

    # ---- 知识库 ----
    @abstractmethod
    def create_knowledge_base(self, record: KnowledgeBaseRecord) -> KnowledgeBaseRecord: ...

    @abstractmethod
    def get_knowledge_base(self, kb_id: str) -> KnowledgeBaseRecord | None: ...

    @abstractmethod
    def list_knowledge_bases(self) -> list[KnowledgeBaseRecord]: ...

    @abstractmethod
    def rename_knowledge_base(self, kb_id: str, name: str) -> None:
        """改显示名。嵌入模型与切分参数都不受影响——名字只是标签。"""

    @abstractmethod
    def update_knowledge_base_embedding(
        self, kb_id: str, *, model_id: str, dim: int, base_url: str | None
    ) -> None: ...

    @abstractmethod
    def delete_knowledge_base(self, kb_id: str) -> None: ...

    @abstractmethod
    def count_kb_chunks(self, kb_id: str) -> int: ...

    # ---- 文档 ----
    @abstractmethod
    def create_document(self, record: DocumentRecord) -> DocumentRecord: ...

    @abstractmethod
    def get_document(self, document_id: str) -> DocumentRecord | None: ...

    @abstractmethod
    def get_document_by_hash(self, kb_id: str, content_hash: str) -> DocumentRecord | None: ...

    @abstractmethod
    def list_documents(
        self,
        kb_id: str,
        *,
        folder_id: str | None = None,
        root_only: bool = False,
        q: str | None = None,
        stage: str | None = None,
        source_kind: str | None = None,
    ) -> list[DocumentRecord]:
        """列某个库的文档。

        - ``root_only=True``：只看未归档的（``folder_id IS NULL``）；
        - ``folder_id`` 给了：只看这个目录里的；
        - ``q``：文件名含该子串（大小写不敏感，``%``/``_`` 按字面匹配）；
        - ``stage`` / ``source_kind``：精确值过滤；
        - 都不给：整个库（默认，保持既有调用点行为不变）。

        过滤**在 SQL 里做而不是取回内存再筛**：一个库上万篇时，
        "把全部读出来再过滤"会把列表接口的耗时和内存随库大小一起放大。
        """

    @abstractmethod
    def update_document_stage(
        self, document_id: str, stage: DocumentStage, *, error: str | None = None
    ) -> None: ...

    @abstractmethod
    def update_document_page_count(self, document_id: str, page_count: int | None) -> None:
        """页数是**解析产物**而不是阶段推进，所以有独立入口。

        ``None`` 或 ``<= 0`` 一律忽略、保持 NULL：写 0 会让界面显示"0 页"，
        而 NULL 渲染成"—"，后者才是诚实的（"没测出来"不等于"有 0 页"）。
        """

    @abstractmethod
    def mark_document_split(self, document_id: str, is_split: bool = True) -> None:
        """标记"这个文档被切成子文件了"。

        界面据此把它渲染成**可展开的父行**（架构 §4.2："UI 显示为单个文件，
        点击展开子文件树"）。没有这个标记，子文件树就永远不会出现——
        用户只能看到一个文档，却不知道它内部被切成了 5 段、其中一段失败了。
        """

    @abstractmethod
    def delete_document(self, document_id: str) -> None: ...

    @abstractmethod
    def rename_document(self, document_id: str, name: str) -> None:
        """改文件名。**只是显示名**：不改 ``content_hash``、不重跑解析，
        下载时用的也是这个名字（``Content-Disposition`` 取的就是它）。
        """

    # ---- 目录（v13）----
    @abstractmethod
    def create_folder(self, record: FolderRecord) -> FolderRecord: ...

    @abstractmethod
    def get_folder(self, folder_id: str) -> FolderRecord | None: ...

    @abstractmethod
    def list_folders(self, kb_id: str) -> list[FolderRecord]:
        """按名字排序——目录是人自己起的名字，按名字找比按创建时间找自然。"""

    @abstractmethod
    def rename_folder(self, folder_id: str, name: str) -> None: ...

    @abstractmethod
    def delete_folder(self, folder_id: str) -> None: ...

    @abstractmethod
    def count_documents_by_folders(self, kb_id: str) -> dict[str, int]:
        """批量取每个目录的文档数（``GROUP BY``）：逐个目录查一次就是 N+1。"""

    @abstractmethod
    def set_document_folder(self, document_id: str, folder_id: str | None) -> None:
        """把文档移进目录；``None`` = 移回根。"""

    # ---- 子文件 ----
    @abstractmethod
    def create_document_parts(self, records: Sequence[DocumentPartRecord]) -> None:
        """建立子文件记录。**必须可重入**：摄入失败重跑时会用同一批 id 再来一次。"""

    @abstractmethod
    def list_document_parts(self, document_id: str) -> list[DocumentPartRecord]: ...

    @abstractmethod
    def delete_document_parts(self, document_id: str) -> None:
        """重跑切分前清一遍：段数可能变少，``INSERT OR REPLACE`` 清不掉多出来的高序号段。"""

    @abstractmethod
    def update_part_stage(
        self, part_id: str, stage: DocumentStage, *, error: str | None = None
    ) -> None: ...

    # ---- chunk ----
    @abstractmethod
    def replace_chunks(self, document_id: str, chunks: Sequence[ChunkRecord]) -> None: ...

    @abstractmethod
    def iter_chunks(self, document_id: str, *, limit: int | None = None) -> Iterable[ChunkRecord]:
        """按 ``ordinal`` 升序取文档的切块。

        ``limit`` 用于"只看前几块"的预览场景（文档详情页）：不设上限时，
        一个上万块的文档会把整份正文读进内存，而这只是为了显示开头几段。
        """

    @abstractmethod
    def get_chunks(self, chunk_ids: Sequence[str]) -> list[ChunkRecord]:
        """按 ID 批量取回 chunk。

        检索时向量只给得出 chunk_id，正文/页码/图片锚点都得回表取——
        逐个查会变成 N 次查询，所以接口层就要求批量。
        """

    @abstractmethod
    def count_chunks(self, document_id: str) -> int: ...

    @abstractmethod
    def sample_chunks(self, kb_ids: Sequence[str], *, limit: int) -> list[ChunkRecord]:
        """从若干知识库里**随机抽**若干切块（跳过人工禁用的）。

        用途是"给示例问题生成提供一点语料"，不是检索：不需要相关性排序，
        只要覆盖面够广——所以按库随机，而不是取每个文档的前几块（那样每个库
        都只看得到第一份文档的开头）。空 ``kb_ids`` 返回空列表。
        """

    @abstractmethod
    def count_chunks_by_documents(self, document_ids: Sequence[str]) -> dict[str, int]:
        """批量查切块数：文档列表页要显示每个文档有多少块。

        逐个 ``count_chunks`` 会变成 N+1（1000 个文档 = 1000 次查询），
        所以接口层直接要求批量。缺席的文档 ID 在返回里补 0。
        """

    # ---- 切块人工干预（§G3）----
    @abstractmethod
    def update_chunk(self, record: ChunkRecord) -> None:
        """就地更新一个块（正文、标题路径、页码）。**不改 chunk_id**。"""
        ...

    @abstractmethod
    def set_chunk_disabled(self, chunk_id: str, *, disabled: bool) -> None: ...

    @abstractmethod
    def delete_chunk(self, chunk_id: str) -> None:
        """删除单个块（含图片关联）。全文索引与向量由调用方一并清理。"""
        ...

    # ---- 图片 ----
    @abstractmethod
    def add_images(self, records: Sequence[ImageRecord]) -> None: ...

    @abstractmethod
    def list_images(self, document_id: str) -> list[ImageRecord]: ...

    # ---- 解析产物 ----
    @abstractmethod
    def save_parse_result(self, record: ParseResultRecord) -> None: ...

    @abstractmethod
    def get_parse_result(self, document_id: str) -> ParseResultRecord | None: ...

    # ---- 任务 ----
    @abstractmethod
    def enqueue_task(self, record: TaskRecord) -> TaskRecord: ...

    @abstractmethod
    def claim_task(self, *, owner: str, lease_seconds: int) -> TaskRecord | None: ...

    @abstractmethod
    def heartbeat_task(self, task_id: str, *, owner: str, lease_seconds: int) -> bool: ...

    @abstractmethod
    def finish_task(
        self,
        task_id: str,
        state: TaskState,
        *,
        owner: str,
        error: str | None = None,
    ) -> bool:
        """落终态，返回是否写成功。

        必须带 ``owner`` 做条件更新：租约被回收后，原消费者仍然可能跑完并回来写终态，
        无条件覆盖会把**新消费者正在跑的任务**改成成功，或者凭空清掉它的租约。
        返回 False 表示"这份任务已经不是你的了"，调用方应记日志而不是当成功。
        """

    @abstractmethod
    def cancel_tasks_for_document(self, document_id: str) -> int:
        """把这个文档还没结束（pending/running）的任务标成 canceled，返回条数。

        与 ``finish_task`` 不同，它**不需要 owner**：这是管理动作，由看到"用户点了取消"
        的 API 进程执行，而不是任务的持有者。它会一并清掉租约——租约还在，worker
        的心跳就还会续，任务也就还"活着"。
        """

    @abstractmethod
    def reschedule_task(
        self, task_id: str, *, owner: str, next_run_at: datetime, error: str | None
    ) -> bool:
        """把任务退回待执行并设定下次可领时间，返回是否写成功（同 ``finish_task``）。

        指数退避靠它实现：``finish_task`` 只能落终态，而重试要求任务**回到队列**，
        同时释放租约、记录本次失败原因。
        """

    @abstractmethod
    def reclaim_expired_tasks(self, *, now: datetime | None = None) -> int: ...

    @abstractmethod
    def list_tasks(self, state: TaskState | None = None) -> list[TaskRecord]: ...

    @abstractmethod
    def get_task(self, task_id: str) -> TaskRecord | None:
        """按主键取单个任务：不要为了找一条而拉全表。"""

    # ---- 数据源 / 凭据 / webhook ----
    @abstractmethod
    def create_data_source(self, record: DataSourceRecord) -> DataSourceRecord: ...

    @abstractmethod
    def list_data_sources(self, kb_id: str) -> list[DataSourceRecord]: ...

    @abstractmethod
    def get_data_source(self, source_id: str) -> DataSourceRecord | None: ...

    @abstractmethod
    def list_all_data_sources(self) -> list[DataSourceRecord]:
        """全部数据源（不分库）。

        定时拉取要遍历所有启用的源，按库找就得先把库读出来再逐个查——
        那是不必要的 N+1。
        """
        ...

    @abstractmethod
    def update_data_source(self, record: DataSourceRecord) -> None: ...

    @abstractmethod
    def delete_data_source(self, source_id: str) -> None: ...

    @abstractmethod
    def mark_data_source_pulled(self, source_id: str, *, etag: str | None) -> None:
        """记下这次拉取的时间与 ETag。

        **ETag 是增量拉取的关键**：下次带上 ``If-None-Match``，没变就返回 304，
        连正文都不用下载。省的不只是流量——解析与向量化才是大头。
        """
        ...

    @abstractmethod
    def create_api_key(self, record: ApiKeyRecord) -> ApiKeyRecord: ...

    @abstractmethod
    def get_api_key_by_hash(self, key_hash: str) -> ApiKeyRecord | None: ...

    @abstractmethod
    def list_api_keys(self) -> list[ApiKeyRecord]: ...

    @abstractmethod
    def delete_api_key(self, key_id: str) -> None: ...

    @abstractmethod
    def touch_api_key(self, key_id: str, *, used_at: datetime | None = None) -> None:
        """记录一次使用时间（只更新 ``last_used_at``，不动权限与范围）。"""
        ...

    @abstractmethod
    def create_webhook(self, record: WebhookRecord) -> WebhookRecord: ...

    @abstractmethod
    def list_webhooks(self) -> list[WebhookRecord]: ...

    @abstractmethod
    def get_webhook(self, webhook_id: str) -> WebhookRecord | None: ...

    @abstractmethod
    def set_webhook_enabled(self, webhook_id: str, enabled: bool) -> WebhookRecord | None:
        """只切开关，**不提供改地址**：换投递目标应当是一次有意识的新建。"""

    @abstractmethod
    def delete_webhook(self, webhook_id: str) -> None: ...

    # ---- 幂等键（架构 §3.2：上传类接口带幂等键，防重试造成重复入库）----
    @abstractmethod
    def create_idempotency_key(self, record: IdempotencyRecord) -> IdempotencyRecord:
        """占住一个幂等键。**键已存在时必须抛 ConflictError**，让调用方据此走重放。"""
        ...

    @abstractmethod
    def get_idempotency_key(self, key: str) -> IdempotencyRecord | None: ...

    @abstractmethod
    def save_idempotent_response(self, key: str, response: dict[str, object]) -> None:
        """把首次执行的结果挂到键上，后续重放直接回它。"""
        ...

    @abstractmethod
    def purge_expired_idempotency_keys(self, *, before: datetime) -> int:
        """清掉 ``created_at < before`` 的键，返回删除条数。

        没有这一步，幂等键表会随每次上传无限增长。客户端重试窗口是分钟级，
        所以保留一天就远远够用。
        """
        ...

    @abstractmethod
    def release_idempotency_key(self, key: str) -> None:
        """放掉一个还没产生结果的键。

        业务执行中途失败时用：键留着但 ``response`` 为空，客户端重试只会拿到
        "正在处理中"——而实际上什么都没在处理了。
        """
        ...

    # ---- 对话留存（架构 §3 的对话层；M6 后续）----
    @abstractmethod
    def create_conversation(self, record: ConversationRecord) -> ConversationRecord: ...

    @abstractmethod
    def get_conversation(self, conversation_id: str) -> ConversationRecord | None: ...

    @abstractmethod
    def list_conversations(self, *, limit: int | None = None) -> list[ConversationRecord]:
        """按最近更新倒序。"""
        ...

    @abstractmethod
    def rename_conversation(self, conversation_id: str, title: str) -> None: ...

    @abstractmethod
    def set_conversation_model(self, conversation_id: str, model_pk: str | None) -> None:
        """记录该会话选用的对话模型（``None`` = 回到全局默认）。

        **不推 ``updated_at``**，与改名同理：切一次模型不该把会话顶到"最近活动"的最前面。
        """
        ...

    @abstractmethod
    def touch_conversation(self, conversation_id: str) -> None:
        """把 ``updated_at`` 推到现在（追加消息后调用）。"""
        ...

    @abstractmethod
    def delete_conversation(self, conversation_id: str) -> None:
        """删除会话**及其全部消息**（外键级联）。"""
        ...

    @abstractmethod
    def append_message(self, record: ChatMessageRecord) -> ChatMessageRecord: ...

    @abstractmethod
    def list_messages(self, conversation_id: str) -> list[ChatMessageRecord]:
        """按写入顺序返回——顺序就是对话顺序，所以按 created_at 排序。"""
        ...

    # ---- 使用者名册（调研报告 G6）----
    @abstractmethod
    def create_user(self, record: UserRecord) -> UserRecord: ...

    @abstractmethod
    def get_user(self, user_id: str) -> UserRecord | None: ...

    @abstractmethod
    def find_user_by_name(self, name: str) -> UserRecord | None:
        """按名字找——请求头里带的是名字（人记不住 id，也不该去记）。"""
        ...

    @abstractmethod
    def list_users(self) -> list[UserRecord]: ...

    @abstractmethod
    def delete_user(self, user_id: str) -> None: ...

    @abstractmethod
    def count_documents_by_user(self, user_id: str) -> int:
        """某人传过多少文档。删使用者前要能告诉他"会影响什么"。"""
        ...

    # ---- 账号与会话（v10：名册升级为账号）----
    @abstractmethod
    def find_user_by_username(self, username: str) -> UserRecord | None:
        """登录按 username 找。与 ``find_user_by_name`` 并存：name 给人看，username 给登录。

        **大小写归一化是调用方的责任**（服务层统一转小写后存储与查询）。
        存储层保持字节精确：在这里悄悄做 NOCASE 会让"库里到底存了什么"变得难追。
        """
        ...

    @abstractmethod
    def update_user_password(self, user_id: str, password_hash: str) -> None: ...

    @abstractmethod
    def set_user_disabled(self, user_id: str, disabled: bool) -> None: ...

    @abstractmethod
    def claim_legacy_ownership(self, owner_id: str) -> dict[str, int]:
        """把 owner 为 NULL 的知识库与会话认领给指定账号（setup 向导用）。

        返回 ``{"knowledge_bases": n, "conversations": n}``——认领了几条要让用户知道，
        静默改掉一堆数据的归属而不吭声是不行的。
        """
        ...

    @abstractmethod
    def create_session(self, record: SessionRecord) -> SessionRecord: ...

    @abstractmethod
    def get_session(self, session_id: str) -> SessionRecord | None:
        """按 id（明文 token 的 SHA-256）查。"""
        ...

    @abstractmethod
    def touch_session(
        self, session_id: str, *, last_seen_at: datetime, expires_at: datetime
    ) -> None:
        """滑动续期：每次用到都把 last_seen 与过期时间推后。"""
        ...

    @abstractmethod
    def delete_session(self, session_id: str) -> None: ...

    @abstractmethod
    def delete_sessions_for_user(
        self, user_id: str, *, except_session_id: str | None = None
    ) -> int:
        """吊销某人的会话（改密/禁用账号时）。``except_session_id`` 保住当前这条。

        返回吊销了几条——改密后界面要告诉用户"其他 N 处登录已退出"。
        """
        ...

    # ---- 知识库分享（v10）----
    @abstractmethod
    def put_share(self, record: ShareRecord) -> ShareRecord:
        """授出/调整分享档位。重复分享同一库同一人 = 改档位（INSERT OR REPLACE）。"""
        ...

    @abstractmethod
    def list_shares_for_kb(self, kb_id: str) -> list[ShareRecord]: ...

    @abstractmethod
    def list_shares_for_user(self, user_id: str) -> list[ShareRecord]:
        """某人被分享了哪些库——可见性过滤（owned + shared）里的 shared 半边。"""
        ...

    @abstractmethod
    def delete_share(self, kb_id: str, user_id: str) -> None: ...

    # ---- 用量（调研报告 G7）----
    @abstractmethod
    def record_usage(self, record: UsageEventRecord) -> UsageEventRecord: ...

    @abstractmethod
    def list_usage(self, *, since: datetime | None = None) -> list[UsageEventRecord]:
        """取某时间点之后的全部用量事件（驾驶舱窗口聚合用）。

        **不做 SQL 聚合**：驾驶舱的口径（按本地日历日分桶、按用途分类）
        属于业务判断，放在服务层更清楚，也便于单测。本地部署的数据量
        （一天几百行）全读回来聚合完全够用。
        """
        ...

    @abstractmethod
    def purge_usage_before(self, before: datetime) -> int:
        """清掉某时间点之前的用量。返回删了几行。

        用量数据只用于看趋势，留太久没有价值；与幂等键同一套保留期思路。
        """
        ...

    @abstractmethod
    def count_messages(self, conversation_id: str) -> int:
        """会话里的消息条数（列表页显示"几轮"，不必把消息全读出来数）。"""
        ...

    # ---- 模型注册器（调研报告 G1）----
    @abstractmethod
    def create_model_provider(self, record: ModelProviderRecord) -> ModelProviderRecord: ...

    @abstractmethod
    def get_model_provider(self, provider_id: str) -> ModelProviderRecord | None: ...

    @abstractmethod
    def list_model_providers(self) -> list[ModelProviderRecord]: ...

    @abstractmethod
    def update_model_provider(self, record: ModelProviderRecord) -> None: ...

    @abstractmethod
    def delete_model_provider(self, provider_id: str) -> None:
        """删供应商要**连同它下面的模型**一起删。

        外键级联在本项目不生效（连接没开 ``PRAGMA foreign_keys``），
        所以存储层显式清理——只删供应商会留下指向不存在供应商的孤儿模型。
        """
        ...

    @abstractmethod
    def create_registered_model(self, record: RegisteredModelRecord) -> RegisteredModelRecord: ...

    @abstractmethod
    def get_registered_model(self, model_pk: str) -> RegisteredModelRecord | None: ...

    @abstractmethod
    def list_registered_models(self, provider_id: str | None = None) -> list[RegisteredModelRecord]:
        """按供应商过滤（留空表示全部）。"""
        ...

    @abstractmethod
    def update_registered_model(self, record: RegisteredModelRecord) -> None: ...

    @abstractmethod
    def delete_registered_model(self, model_pk: str) -> None: ...

    # ---- 回收站 ----
    @abstractmethod
    def add_to_trash(self, record: TrashRecord) -> None: ...

    @abstractmethod
    def list_trash(self) -> list[TrashRecord]: ...

    @abstractmethod
    def purge_expired_trash(self, *, now: datetime | None = None) -> list[TrashRecord]: ...

    @abstractmethod
    def set_trash_expiry(self, trash_id: str, expires_at: datetime) -> None:
        """改一条回收站记录的到期时间。

        正常路径用不到它；测试要靠它模拟"7 天过去了"，
        比在用例里写裸 SQL 干净得多（也免得表结构一变就崩）。
        """
        ...

    @abstractmethod
    def delete_trash(self, trash_id: str) -> None:
        """删掉一条回收站记录（对象已由调用方处理）。

        与 ``purge_expired_trash`` 分开：那个按到期时间批量清，
        这个是"用户主动说这条不要了"，只删一条、不看时间。
        """
        ...

    # ---- 设置 ----
    @abstractmethod
    def get_setting(self, key: str) -> str | None: ...

    @abstractmethod
    def set_setting(self, key: str, value: str) -> None: ...

    @abstractmethod
    def delete_setting(self, key: str) -> None:
        """删掉一个设置项。

        **与"设为空串"不是一回事**：空串仍是一个显式值，会参与
        "是否已配置"的判断；而删除意味着"回到没有这个设置的状态"。
        槽位解绑（G1）依赖这个区别——解绑后应当回退到 ``.env``/设置页那套，
        而不是被一个空值挡住。
        """
        ...


class VectorStore(ABC):
    """向量仓储：按知识库分区（架构 §8.3），维度在分区创建时确定。"""

    @abstractmethod
    def ensure_partition(self, kb_id: str, *, dim: int) -> None:
        """为知识库建向量分区；已存在且维度不一致时必须报错而不是静默写入。"""

    @abstractmethod
    def upsert_vectors(
        self, kb_id: str, *, items: Sequence[tuple[str, Sequence[float]]]
    ) -> None:
        """写入/覆盖向量，``chunk_id`` 为主键。"""

    @abstractmethod
    def delete_vectors(self, kb_id: str, *, chunk_ids: Sequence[str]) -> int: ...

    @abstractmethod
    def search(
        self, kb_id: str, *, query_vector: Sequence[float], top_k: int
    ) -> list[VectorMatch]: ...

    @abstractmethod
    def drop_partition(self, kb_id: str) -> None: ...


class FullTextStore(ABC):
    """全文仓储：FTS5 + 中文分词，与元数据同库。"""

    @abstractmethod
    def index_chunks(self, chunks: Sequence[ChunkRecord]) -> None: ...

    @abstractmethod
    def delete_chunks(self, chunk_ids: Sequence[str]) -> int: ...

    @abstractmethod
    def search(self, *, query: str, top_k: int, kb_id: str | None = None) -> list[SearchHit]: ...


class ObjectStore(ABC):
    """对象存储：原文、Markdown 产物、图片；内容 hash 寻址。"""

    @abstractmethod
    def write(self, key: str, data: bytes) -> str:
        """写入并返回可持久化的存储路径。"""

    @abstractmethod
    def read(self, path: str) -> bytes: ...

    @abstractmethod
    def exists(self, path: str) -> bool: ...

    @abstractmethod
    def move_to_trash(self, path: str, *, trash_id: str) -> str: ...

    @abstractmethod
    def delete(self, path: str) -> None: ...


class TabularStore(ABC):
    """表格结构化副本（M2 / T2.11；DuckDB 实现）。

    **为什么单独一个仓储、而不是又一张 SQLite 表**：它回答的是
    "某份 CSV 的第 3 行第 2 列是什么"这类**按行列定位**的问题。
    DuckDB 是列式分析库，按列读、按行扫都比 SQLite 合适；
    而且它与主库物理分离，"分析型查询拖慢主库"从结构上就不会发生。

    **表名约定为 ``document_id``**（一份文档一张表）：删文档时连带清理很直接，
    也不会出现两份文档的表结构冲突。
    """

    @abstractmethod
    def write_table(
        self, *, table: str, columns: Sequence[str], rows: Sequence[Sequence[str]]
    ) -> int:
        """写入（覆盖）一张表，返回写入行数。

        **覆盖而不是追加**：同一份文档重新摄入应当得到干净的副本。
        追加会让行数翻倍，而用户看到"这份表有两倍的行"时，
        很难联想到是自己点了一次重跑。
        """
        ...

    @abstractmethod
    def table_exists(self, table: str) -> bool: ...

    @abstractmethod
    def drop_table(self, table: str) -> None:
        """删表（删文档时调用）。表不存在不报错——那是幂等。"""
        ...

    @abstractmethod
    def columns(self, table: str) -> list[str]: ...

    @abstractmethod
    def row_count(self, table: str) -> int: ...

    @abstractmethod
    def read_rows(
        self, table: str, *, limit: int = 50, offset: int = 0
    ) -> list[list[str]]:
        """按行列读一段，**按写入顺序返回**。

        DuckDB 不保证无 ``ORDER BY`` 时的行序，而"第 3 行"是用户能对照原文的说法，
        所以实现里另外记行号并据此排序。
        """
        ...
