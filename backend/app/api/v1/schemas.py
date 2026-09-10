"""API 请求/响应模型（协议层）。

命名与字段刻意贴近期望的界面：``stage`` 给状态列，``channels``/``raw_scores`` 给调试台，
``image_ids`` 给图片锚点。**不在此处做业务判断**，只做形状定义（工程规范 §3.3）。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import DataSourceKind, DocumentStage, TaskKind, TaskState

_RECORD_CONFIG = ConfigDict(from_attributes=True)
"""记录类响应模型直接由服务/存储的记录对象构建。

调用方写 ``DocumentOut.model_validate(record)``，字段名对不上会在改字段时立刻报错，
比手写一遍 ``_to_out`` 映射少一处"加了字段忘了同步"的漏点。
这也是协议层不 import ``app.storage`` 还能拼出响应的原因（工程规范 §3.3 L1）。
"""

# --------------------------------------------------------------------- 知识库


class KnowledgeBaseCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    chunk_size: int = Field(default=512, gt=0, le=8000)
    chunk_overlap: int = Field(default=64, ge=0, le=4000)


class KnowledgeBaseOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    name: str
    embedding_model_id: str
    embedding_dim: int
    chunk_strategy: str
    chunk_size: int
    chunk_overlap: int
    created_at: datetime | None = None


class KnowledgeBaseList(BaseModel):
    items: list[KnowledgeBaseOut]


# --------------------------------------------------------------------- 文档


class DocumentOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    knowledge_base_id: str
    name: str
    source_kind: DataSourceKind
    stage: DocumentStage
    size_bytes: int
    mime_type: str | None = None
    page_count: int | None = None
    is_split: bool = False
    error: str | None = None
    chunk_count: int = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None


class DocumentList(BaseModel):
    items: list[DocumentOut]


class DocumentPartOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    part_index: int
    page_start: int
    page_end: int
    stage: DocumentStage
    error: str | None = None


class DocumentPartList(BaseModel):
    items: list[DocumentPartOut]


class UploadAccepted(BaseModel):
    """上传响应。``is_duplicate`` 对应架构 §6.3 的"检测到相同文件"提醒。"""

    document: DocumentOut
    is_duplicate: bool
    task_id: str | None = None


# --------------------------------------------------------------------- 任务


class TaskOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    kind: TaskKind
    state: TaskState
    document_id: str | None = None
    attempts: int
    max_attempts: int
    error: str | None = None
    next_run_at: datetime | None = None
    lease_expires_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class TaskList(BaseModel):
    items: list[TaskOut]


# --------------------------------------------------------------------- 检索


class MetadataFilterIn(BaseModel):
    document_ids: list[str] | None = None
    source_kinds: list[DataSourceKind] | None = None
    created_after: datetime | None = None
    created_before: datetime | None = None


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    kb_ids: list[str] = Field(min_length=1)
    top_k: int = Field(default=8, gt=0, le=100)
    mode: str = "hybrid"
    candidate_k: int = Field(default=40, gt=0, le=500)
    score_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    rerank: bool = False
    filters: MetadataFilterIn | None = None


class SearchHitOut(BaseModel):
    model_config = _RECORD_CONFIG

    chunk_id: str
    document_id: str
    document_name: str | None = None
    knowledge_base_id: str
    text: str
    score: float
    page: int | None = None
    heading_path: str | None = None
    image_ids: list[str] = Field(default_factory=list)
    channels: list[str] = Field(default_factory=list)
    ranks: dict[str, int] = Field(default_factory=dict)
    raw_scores: dict[str, float] = Field(default_factory=dict)
    rerank_score: float | None = None


class ChannelStatOut(BaseModel):
    model_config = _RECORD_CONFIG

    channel: str
    count: int
    elapsed_ms: float


class SearchResponse(BaseModel):
    hits: list[SearchHitOut]
    mode: str
    reranked: bool
    filtered_out: int = 0
    stats: list[ChannelStatOut] = Field(default_factory=list)
    embedding_is_development: bool = False
    """当前 embedding 是否为开发兜底实现：界面据此提示"检索质量不代表真实效果"。"""
