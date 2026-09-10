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
    TaskKind,
    TaskState,
    TrashKind,
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
    """四个仓储的聚合视图（由组合根填充）。

    ``services/`` 依赖这个类型就能拿到全部存储能力，而**不必 import 任何具体实现**——
    字段类型全是接口，组合根 `app/core/storage.py` 负责把实现塞进来。
    """

    meta: MetaStore
    vectors: VectorStore
    fulltext: FullTextStore
    objects: ObjectStore


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
    created_at: datetime | None = None
    updated_at: datetime | None = None


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
    def list_documents(self, kb_id: str) -> list[DocumentRecord]: ...

    @abstractmethod
    def update_document_stage(
        self, document_id: str, stage: DocumentStage, *, error: str | None = None
    ) -> None: ...

    @abstractmethod
    def delete_document(self, document_id: str) -> None: ...

    # ---- 子文件 ----
    @abstractmethod
    def create_document_parts(self, records: Sequence[DocumentPartRecord]) -> None: ...

    @abstractmethod
    def list_document_parts(self, document_id: str) -> list[DocumentPartRecord]: ...

    @abstractmethod
    def update_part_stage(
        self, part_id: str, stage: DocumentStage, *, error: str | None = None
    ) -> None: ...

    # ---- chunk ----
    @abstractmethod
    def replace_chunks(self, document_id: str, chunks: Sequence[ChunkRecord]) -> None: ...

    @abstractmethod
    def iter_chunks(self, document_id: str) -> Iterable[ChunkRecord]: ...

    @abstractmethod
    def get_chunks(self, chunk_ids: Sequence[str]) -> list[ChunkRecord]:
        """按 ID 批量取回 chunk。

        检索时向量只给得出 chunk_id，正文/页码/图片锚点都得回表取——
        逐个查会变成 N 次查询，所以接口层就要求批量。
        """

    @abstractmethod
    def count_chunks(self, document_id: str) -> int: ...

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
        self, task_id: str, state: TaskState, *, error: str | None = None
    ) -> None: ...

    @abstractmethod
    def reclaim_expired_tasks(self, *, now: datetime | None = None) -> int: ...

    @abstractmethod
    def list_tasks(self, state: TaskState | None = None) -> list[TaskRecord]: ...

    # ---- 数据源 / 凭据 / webhook ----
    @abstractmethod
    def create_data_source(self, record: DataSourceRecord) -> DataSourceRecord: ...

    @abstractmethod
    def list_data_sources(self, kb_id: str) -> list[DataSourceRecord]: ...

    @abstractmethod
    def create_api_key(self, record: ApiKeyRecord) -> ApiKeyRecord: ...

    @abstractmethod
    def get_api_key_by_hash(self, key_hash: str) -> ApiKeyRecord | None: ...

    @abstractmethod
    def create_webhook(self, record: WebhookRecord) -> WebhookRecord: ...

    @abstractmethod
    def list_webhooks(self) -> list[WebhookRecord]: ...

    # ---- 回收站 ----
    @abstractmethod
    def add_to_trash(self, record: TrashRecord) -> None: ...

    @abstractmethod
    def list_trash(self) -> list[TrashRecord]: ...

    @abstractmethod
    def purge_expired_trash(self, *, now: datetime | None = None) -> list[TrashRecord]: ...

    # ---- 设置 ----
    @abstractmethod
    def get_setting(self, key: str) -> str | None: ...

    @abstractmethod
    def set_setting(self, key: str, value: str) -> None: ...


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
