"""API 请求/响应模型（协议层）。

命名与字段刻意贴近期望的界面：``stage`` 给状态列，``channels``/``raw_scores`` 给调试台，
``image_ids`` 给图片锚点。**不在此处做业务判断**，只做形状定义（工程规范 §3.3）。
"""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import ApiKeyPermission, DataSourceKind, DocumentStage, TaskKind, TaskState

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


class ChunkOut(BaseModel):
    """切块（文档详情页的正文预览）。

    与 `SearchHitOut` 是两件事：命中带分数与通道，切块只描述"文档被切成了什么"。
    """

    model_config = _RECORD_CONFIG

    chunk_id: str
    document_id: str
    ordinal: int
    text: str
    heading_path: str | None = None
    page: int | None = None
    image_ids: list[str] = Field(default_factory=list)
    disabled: bool = False
    """被禁用的块不再参与检索，但仍留在库里（§G3）。"""


class ChunkList(BaseModel):
    items: list[ChunkOut]
    total: int = Field(description="该文档的切块总数，与 items 长度无关（items 可能被 limit 截断）")


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


# --------------------------------------------------------------------- 设置


class SettingFieldOut(BaseModel):
    """一个配置项。密钥只给掩码，``configured`` 说明是否已填。"""

    key: str
    label: str
    type: str
    value: str
    configured: bool


class SettingGroupOut(BaseModel):
    key: str
    label: str
    fields: list[SettingFieldOut]


class SettingsViewOut(BaseModel):
    """设置页要的全部信息：分组字段 + 当前实际生效的模型与模式。"""

    groups: list[SettingGroupOut]
    embedding_model_id: str
    embedding_dim: int
    embedding_is_development: bool
    rerank_enabled: bool


class SettingValueIn(BaseModel):
    key: str
    value: str = ""


class SettingsPatchIn(BaseModel):
    values: list[SettingValueIn]


class SettingsPatchOut(BaseModel):
    updated: int
    rejected: list[str] = Field(default_factory=list)
    """被拒绝的键：拼错键名时报出来，而不是静默"保存成功"。"""


class TestConnectionOut(BaseModel):
    ok: bool
    detail: str


# --------------------------------------------------------------------- 统计


class ActivityPointOut(BaseModel):
    """一天的活跃度。"""

    model_config = _RECORD_CONFIG

    day: date
    documents: int
    chunks: int
    tasks: int


class KbStatOut(BaseModel):
    # 嵌套模型也要 from_attributes：外层配了不代表内层能从 dataclass 读
    model_config = _RECORD_CONFIG

    id: str
    name: str
    embedding_model_id: str
    embedding_dim: int
    documents: int
    chunks: int
    last_activity: datetime | None = None


class DashboardOut(BaseModel):
    """驾驶舱要的全部数字。"""

    model_config = _RECORD_CONFIG

    generated_at: datetime
    window_days: int
    total_knowledge_bases: int
    total_documents: int
    total_chunks: int
    indexed_documents: int
    failed_documents: int
    running_tasks: int
    failed_tasks: int
    storage_bytes: int
    recent_documents: int
    activity: list[ActivityPointOut] = Field(default_factory=list)
    by_stage: dict[str, int] = Field(default_factory=dict)
    by_suffix: dict[str, int] = Field(default_factory=dict)
    by_source_kind: dict[str, int] = Field(default_factory=dict)
    knowledge_bases: list[KbStatOut] = Field(default_factory=list)


# --------------------------------------------------------------------- 对话


class ChatHistoryIn(BaseModel):
    """历史消息：只带 role 与 content，不落库（会话持久化不在本轮范围）。"""

    role: str = Field(pattern="^(user|assistant)$")
    content: str


class ChatRequestIn(BaseModel):
    query: str = Field(min_length=1)
    kb_ids: list[str] = Field(min_length=1)
    top_k: int | None = Field(default=None, gt=0, le=20, description="留空用设置里的条数")
    history: list[ChatHistoryIn] = Field(default_factory=list)
    conversation_id: str | None = Field(
        default=None,
        description="指定则把这一轮存进该会话，并以库里的历史为准（忽略上方的 history）",
    )


class ChatSourceOut(BaseModel):
    """回答引用的原文出处。带 preview，界面点开就能看到依据。"""

    model_config = _RECORD_CONFIG

    index: int
    chunk_id: str
    document_id: str
    document_name: str
    heading_path: str | None = None
    page: int | None = None
    score: float = 0.0
    preview: str = ""


class ChatTurnOut(BaseModel):
    answer: str
    sources: list[ChatSourceOut] = Field(default_factory=list)


class ChatResponseOut(ChatTurnOut):
    """一次性问答的响应（与流式共用同一套 source 结构）。"""


# --------------------------------------------------------------------- API Key


class ApiKeyCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    permission: ApiKeyPermission = ApiKeyPermission.READONLY
    """默认只读：**默认值要取最保守的那个**。给外部集成发一把能删库的钥匙，
    不应该是因为"没填那个字段"。"""
    knowledge_base_ids: list[str] = Field(default_factory=list)
    """空列表表示不限制范围（可访问全部知识库），见 services/api_key.py 的说明。"""


class ApiKeyOut(BaseModel):
    """列表展示用。**绝不回显 key_hash 或明文**——只有创建响应里有明文。"""

    model_config = _RECORD_CONFIG

    id: str
    name: str
    permission: ApiKeyPermission
    knowledge_base_ids: list[str] = Field(default_factory=list)
    created_at: datetime | None = None
    last_used_at: datetime | None = None
    prefix: str = ""
    """展示用前缀（``kylab_sk_ab12…``），让用户能分辨"哪把是哪把"。"""


class ApiKeyIssuedOut(ApiKeyOut):
    """创建响应：``token`` 是明文**唯一一次**出现的地方。"""

    token: str


class ApiKeyListOut(BaseModel):
    items: list[ApiKeyOut]


# --------------------------------------------------------------------- 对话留存


class ConversationCreateIn(BaseModel):
    title: str = Field(default="", max_length=64)
    kb_ids: list[str] = Field(default_factory=list)


class ConversationRenameIn(BaseModel):
    title: str = Field(min_length=1, max_length=64)


class ConversationOut(BaseModel):
    """会话摘要。列表用它，所以带上 ``message_count`` 让界面能写"6 条消息"。"""

    model_config = _RECORD_CONFIG

    id: str
    title: str
    kb_ids: list[str] = Field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    message_count: int = 0


class ConversationListOut(BaseModel):
    items: list[ConversationOut]


class ChatMessageOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    role: str
    content: str
    sources: list[ChatSourceOut] = Field(default_factory=list)
    created_at: datetime | None = None


class ConversationDetailOut(ConversationOut):
    messages: list[ChatMessageOut] = Field(default_factory=list)


# --------------------------------------------------------------------- 切块干预（G3）


class ChunkUpdateIn(BaseModel):
    """改块的正文。

    只允许改文本：标题路径与页码来自解析器的版面分析，用户在这一页没有可对照的
    依据去"修正"它们，开放了只会制造不一致。要改那些应当重新解析。
    """

    text: str = Field(min_length=1)


class ChunkToggleIn(BaseModel):
    """禁用 / 恢复一个块。"""

    disabled: bool


# --------------------------------------------------------------------- 模型注册器（G1）


class ProviderCreateIn(BaseModel):
    """新建供应商。"""

    kind: str = Field(description="llm / embedding / rerank / parser")
    name: str = Field(min_length=1, max_length=64)
    base_url: str = Field(default="", max_length=512)
    api_key: str = Field(default="", max_length=512)
    enabled: bool = True


class ProviderUpdateIn(BaseModel):
    """改供应商。

    **字段全部可选，且 ``api_key`` 用 ``str | None``**：``None`` 表示"没改"，
    空串表示"清空"。设置页把密钥掩码显示成占位符，用户不动它时前端回传的是掩码；
    若把掩码当新值写库，密钥就被毁了——所以"没改"必须能与"清空"区分开。
    """

    name: str | None = Field(default=None, min_length=1, max_length=64)
    base_url: str | None = Field(default=None, max_length=512)
    api_key: str | None = Field(default=None, max_length=512)
    enabled: bool | None = None


class ProviderOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    kind: str
    name: str
    base_url: str
    enabled: bool
    created_at: datetime | None = None
    updated_at: datetime | None = None
    api_key_configured: bool = False
    """**只回"配没配"，绝不回密钥本身**（与设置页同一纪律）。"""
    api_key_hint: str = ""
    """掩码后的尾巴，够用户认出"是哪一把"，不足以还原。"""
    model_count: int = 0


class ProviderListOut(BaseModel):
    items: list[ProviderOut]


class ModelRegisterIn(BaseModel):
    """登记一个模型。"""

    provider_id: str
    model_id: str = Field(min_length=1, max_length=128)
    label: str = Field(default="", max_length=64)
    dim: int | None = Field(default=None, gt=0)
    capabilities: list[str] = Field(default_factory=list)
    options: dict[str, object] = Field(default_factory=dict)


class ModelUpdateIn(BaseModel):
    model_id: str | None = Field(default=None, min_length=1, max_length=128)
    label: str | None = Field(default=None, max_length=64)
    dim: int | None = Field(default=None, gt=0)
    capabilities: list[str] | None = None
    options: dict[str, object] | None = None


class ModelOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    provider_id: str
    provider_name: str = ""
    provider_kind: str = ""
    model_id: str
    label: str = ""
    dim: int | None = None
    capabilities: list[str] = Field(default_factory=list)
    options: dict[str, object] = Field(default_factory=dict)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    bound_slots: list[str] = Field(default_factory=list)
    """这个模型被哪些用途绑定了——界面上要能一眼看出"它正被用着"。"""


class ModelListOut(BaseModel):
    items: list[ModelOut]


class SlotOut(BaseModel):
    """一个用途（任务槽位）的当前状态。"""

    slot: str
    label: str
    capability: str
    bound_model_pk: str | None = None
    bound_model_label: str = ""
    provider_name: str = ""
    configured: bool = False
    """最终是否可用于该用途（注册表绑定了，或设置页那套字段填过）。"""
    source: str = "none"
    """``registry`` / ``settings`` / ``none``——说清当前生效的是哪一套，
    否则用户会疑惑"我在设置页填了为什么还提示要绑定"。"""


class SlotBindIn(BaseModel):
    """绑定用途到模型；``model_pk`` 为 ``None`` 表示解绑（回退到设置页配置）。"""

    model_pk: str | None = None


class RegistryOut(BaseModel):
    """注册器总览：界面一次拿全，免得开设置页要打四个请求。"""

    providers: list[ProviderOut] = Field(default_factory=list)
    models: list[ModelOut] = Field(default_factory=list)
    slots: list[SlotOut] = Field(default_factory=list)
    provider_kinds: dict[str, str] = Field(default_factory=dict)
    capabilities: dict[str, str] = Field(default_factory=dict)
