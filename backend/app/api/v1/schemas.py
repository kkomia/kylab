"""API 请求/响应模型（协议层）。

命名与字段刻意贴近期望的界面：``stage`` 给状态列，``channels``/``raw_scores`` 给调试台，
``image_ids`` 给图片锚点。**不在此处做业务判断**，只做形状定义（工程规范 §3.3）。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

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
    embedding_model_pk: str | None = None
    """建库时选定的嵌入模型（注册表主键）。留空 = 用服务端默认。

    嵌入模型是**知识库属性**：文档量小的库可以选高精度模型，量大的选小模型提速。
    模型 ID 与维度在建库时冻结，换模型必须新建库（架构 §6.4 模型锁）。
    """


class KnowledgeBaseUpdate(BaseModel):
    """改知识库的可编辑属性：名称与简介。**两者都可选**，只传要改的那个。

    名称与建库同一个上限（120），改名不该比建库更宽松；简介上限 200（卡片两行）。
    空简介（``""``）是合法值 = 清空，所以不加 min_length。
    """

    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=200)


class KnowledgeBaseOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    name: str
    description: str = ""
    """库简介（v15）。空串 = 未填写，卡片上显示"暂无简介"。"""
    embedding_model_id: str
    embedding_dim: int
    chunk_strategy: str
    chunk_size: int
    chunk_overlap: int
    created_at: datetime | None = None
    can_manage: bool = False
    """当前调用主体能否管理这个库的分享（owner / 管理员）。

    **由后端算而不是前端推**：判定规则在 `services/share.py`（"看得见"与"管得动"
    是两次判定），前端再实现一遍必然与它漂。界面据此决定要不要显示「分享」入口。
    """
    can_write: bool = False
    """能否写入这个库（上传/删除）。只读分享的成员看得见但写不动，界面据此收起写入口。"""
    document_count: int = 0
    """库内文档数。**由列表接口一并算出**（一条 GROUP BY），
    前端不必再"逐库拉一次文档列表只为了数数"——那会随库数量线性放大请求数。"""
    last_activity: datetime | None = None
    """库内文档的最近更新时间；没有文档时为 None（界面显示占位符，而不是一个含糊的 0）。"""


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
    uploaded_by: str | None = None
    """上传者的使用者 id（G6）。``None`` = 未记录，界面显示"未记录"而不是编一个名字。"""
    uploaded_by_name: str = ""
    """解析后的名字。**由后端解析**：前端拿 id 还得再查一次名册，
    列表里就会有 N 次多余请求。"""
    folder_id: str | None = None
    """所在目录（v13）。``None`` = 未归档（根目录）。"""
    disabled: bool = False
    """停用（v14）。停用后不参与检索（两条通道都过滤），其余一切保留。"""
    original_kind: str = "binary"
    """原件能不能在这页里渲染出来（``pdf`` / ``image`` / ``docx`` / ``pptx`` / ``excel``）。

    界面据此决定首页要不要给「原文版式 / 解析文本」这个切换、以及**先取哪一个**——
    判在后端是为了不让前端去猜文件后缀（同 ``content_kind`` 的理由）。
    """
    created_at: datetime | None = None
    updated_at: datetime | None = None


class DocumentList(BaseModel):
    items: list[DocumentOut]


class FolderOut(BaseModel):
    """知识库内的目录（v13）。``document_count`` 由后端算——列表要显示"几篇"。"""

    model_config = _RECORD_CONFIG

    id: str
    kb_id: str
    name: str
    document_count: int = 0
    created_at: datetime | None = None


class FolderListOut(BaseModel):
    items: list[FolderOut]


class FolderCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class FolderRenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class DocumentFolderIn(BaseModel):
    """把文档移进目录；``folder_id`` 为 ``None`` 表示移回根目录。"""

    folder_id: str | None = None


class DocumentRenameIn(BaseModel):
    """改文件名。上限与服务层的常量一致（``DOCUMENT_NAME_MAX_CHARS``）。"""

    name: str = Field(min_length=1, max_length=200)


class DocumentDisabledIn(BaseModel):
    """停用/恢复检索。**只动标记**：不删切块与向量，恢复零成本。"""

    disabled: bool


class DocumentBatchIn(BaseModel):
    """批量动作：``delete``（进回收站）、``reprocess``（重新摄入）或 ``move``（移目录）。

    ``document_ids`` 设上限而不是"随便多少"：一次勾几千篇会把请求体、逐条查询
    与响应都拉大，而界面上的多选本来也到不了那个量级。
    """

    action: Literal["delete", "reprocess", "move", "enable", "disable"]
    document_ids: list[str] = Field(min_length=1, max_length=500)
    folder_id: str | None = None
    """``move`` 的目标目录；``None`` 表示移回根目录。其它动作忽略此字段。"""


class DocumentBatchItemOut(BaseModel):
    document_id: str
    ok: bool
    error: str | None = None


class DocumentBatchOut(BaseModel):
    """逐条结果。**部分失败是常态**，所以要给出每一篇的成败而不是一个总数。"""

    action: str
    succeeded: int
    failed: int
    items: list[DocumentBatchItemOut]


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
    knowledge_base_id: str | None = None
    """任务所属文档的知识库（v14 后随列表带回）。

    界面的"按知识库筛选"靠它——没有它，任务中心就得逐个库拉文档来反查归属。
    没有挂文档的任务（数据源拉取）为 None。"""
    document_name: str = ""
    """关联文档名。**由后端批量解析**：否则任务中心要为每个库各拉一次文档列表
    只为把 id 换成名字（实测那是这一页最慢的一段）。"""
    attempts: int
    max_attempts: int
    error: str | None = None
    next_run_at: datetime | None = None
    lease_expires_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    health: str = "idle"
    """``running`` / ``stalled`` / ``overdue`` / ``idle`` / ``done``（M7 / T7.4）。

    **由后端判定而不是前端猜**：它要比较租约到期时间与当前时刻，
    还要知道租约时长，那些只有后端有。前端只负责按这个值上色。
    """
    health_label: str = ""
    health_detail: str = ""


class TaskList(BaseModel):
    items: list[TaskOut]
    """任务列表。每项都带 ``health``，界面据此标出"可能卡住"。"""


class TaskHealthOut(BaseModel):
    task_id: str
    status: str
    label: str
    detail: str = ""


class HealthOverviewOut(BaseModel):
    """运行态总览（T7.4）。"""

    total: int = 0
    running: int = 0
    queued: int = 0
    stalled: int = 0
    overdue: int = 0
    problems: list[TaskHealthOut] = Field(default_factory=list)
    """需要用户注意的任务（卡住 / 长时间未执行），最多 20 条。"""
    worker_enabled: bool = True
    """内嵌消费线程是否开着。**关掉时任务不会自己跑**——
    这是"任务一直排队"最常见的原因，界面必须能解释它。"""


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
    embedding_configured: bool = True
    """是否配了嵌入模型。为假时本次只做了全文通道，界面要如实说明。"""
    embedding_is_development: bool = False
    """是否为开发用确定性嵌入（仅显式开着开发开关时）：界面提示"检索质量不代表真实效果"。"""


# --------------------------------------------------------------------- 设置


class SettingFieldOptionOut(BaseModel):
    value: str
    label: str


class SettingFieldOut(BaseModel):
    """一个配置项。密钥只给掩码，``configured`` 说明是否已填。"""

    key: str
    label: str
    type: str
    value: str
    configured: bool
    options: list[SettingFieldOptionOut] = Field(default_factory=list)
    """``type == "select"`` 时的候选值；其余类型为空。"""


class SettingGroupOut(BaseModel):
    key: str
    label: str
    fields: list[SettingFieldOut]


class SettingsViewOut(BaseModel):
    """设置页要的全部信息：分组字段 + 当前实际生效的模型与模式。"""

    groups: list[SettingGroupOut]
    embedding_model_id: str
    embedding_dim: int
    embedding_configured: bool
    """是否已选定嵌入模型。为假时不能建库，界面要给出去哪儿配的指引。"""
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
    model_pk: str | None = Field(
        default=None,
        description="这一轮用哪个注册对话模型；留空则用会话已存的，再留空用全局默认",
    )
    thinking: bool | None = Field(
        default=None,
        description="这一轮是否开启思考；留空则用会话已存的，再留空用全局默认（默认开）",
    )
    thinking_effort: Literal["low", "medium", "high"] | None = Field(
        default=None, description="这一轮的思考强度；同上，留空逐级回退"
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


class SuggestedQuestionsOut(BaseModel):
    """对话页空状态的示例问题。

    ``generated`` 为假（``questions`` 为空）时前端回退到静态样例——
    生成不出来不是错误，只是没有语料依据的建议可给。
    """

    questions: list[str] = Field(default_factory=list)
    generated: bool = False


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
    model_pk: str | None = None
    """本条会话选用的对话模型（v12）。``None`` = 跟随全局默认。"""
    thinking: bool | None = None
    """本条会话是否开启思考（v16）。``None`` = 跟随全局默认。"""
    thinking_effort: Literal["low", "medium", "high"] | None = None
    """本条会话的思考强度（v16）。``None`` = 跟随全局默认。"""


class ConversationRenameIn(BaseModel):
    title: str = Field(min_length=1, max_length=64)


class ConversationOut(BaseModel):
    """会话摘要。列表用它，所以带上 ``message_count`` 让界面能写"6 条消息"。"""

    model_config = _RECORD_CONFIG

    id: str
    title: str
    kb_ids: list[str] = Field(default_factory=list)
    model_pk: str | None = None
    """本条会话选用的对话模型（v12）；``None`` = 全局默认。界面据此回填模型选择器。"""
    thinking: bool | None = None
    """本条会话是否开启思考（v16）；``None`` = 全局默认。界面据此回填思考开关。"""
    thinking_effort: str | None = None
    """本条会话的思考强度（v16）；``None`` = 全局默认。"""
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


class AvailableModelOut(BaseModel):
    """上游 ``GET /models`` 列表里的一条。

    ``owned_by`` 是给用户辨认的旁注（上游不一定给），不参与任何逻辑。
    """

    model_id: str
    owned_by: str = ""


class AvailableModelsOut(BaseModel):
    """供应商可用模型探测结果。

    **不落库**：上游动辄列出几十上百个模型，全登记进来只是噪声；
    "选哪一个"才是用户的决定（界面据此喂下拉框，仍允许手写）。
    """

    models: list[AvailableModelOut]
    count: int


class SlotOut(BaseModel):
    """一个用途（任务槽位）的当前状态。"""

    slot: str
    label: str
    capability: str
    bound_model_pk: str | None = None
    bound_model_label: str = ""
    provider_name: str = ""
    configured: bool = False
    """最终是否可用于该用途（v0.8 起只看注册表里有没有绑定）。"""
    source: str = "none"
    """``registry`` / ``none``——保留字段以便将来出现第二种来源时不用改接口形状。"""


class SlotBindIn(BaseModel):
    """绑定用途到模型；``model_pk`` 为 ``None`` 表示解绑（回退到设置页配置）。"""

    model_pk: str | None = None


class DataSourceCreateIn(BaseModel):
    """登记一个数据源（M6 / T6.1）。"""

    kind: str = Field(description="html 或 rss")
    name: str = Field(default="", max_length=64)
    url: str = Field(min_length=1, max_length=1024)
    max_items: int | None = Field(default=None, gt=0, le=500)


class DataSourceOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    knowledge_base_id: str
    kind: str
    name: str
    url: str
    max_items: int | None = None
    enabled: bool = True
    etag: str | None = None
    last_pulled_at: datetime | None = None


class DataSourceListOut(BaseModel):
    items: list[DataSourceOut] = Field(default_factory=list)


class SyncResultOut(BaseModel):
    """一次拉取的结果。

    ``duplicates`` 与 ``created`` 分开报：用户看到"取回 20 条但新入库 0 条"
    时该立刻明白"这个源没更新"，而不是以为抓取失败了。
    """

    task_id: str | None = None
    """入队模式返回的任务 id；同步模式为 None。"""
    source_id: str = ""
    fetched: int = 0
    created: int = 0
    duplicates: int = 0
    not_modified: bool = False
    """服务端回了 304：源没有任何变化。"""
    errors: list[str] = Field(default_factory=list)


class TableRowsOut(BaseModel):
    """表格文档的结构化副本（M2 / T2.11）。

    ``rows`` 是**字符串矩阵**而不是对象数组：表格副本刻意不做类型推断
    （``007`` 变成 ``7`` 是数据损失），所以返回时也保持原样。
    """

    document_id: str
    columns: list[str] = Field(default_factory=list)
    rows: list[list[str]] = Field(default_factory=list)
    total: int = 0
    """该表总行数，与 ``rows`` 长度无关（``rows`` 会被 limit 截断）。"""


class ImpactOut(BaseModel):
    """删除会波及什么（M6 / T6.3）。

    **数字要具体**：说"这会删除该知识库及其内容"没人会有感觉；
    说"3 份文档、412 个切块"才会让人停一下。这是二次确认能有意义的前提。
    """

    kind: str
    id: str
    name: str
    documents: int = 0
    chunks: int = 0
    parts: int = 0
    size_bytes: int = 0
    running_tasks: int = 0
    document_names: list[str] = Field(default_factory=list)
    restorable: bool = True
    """能否从回收站恢复。知识库级删除不可恢复，界面据此显示不同的警示强度。"""


class TrashEntryOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    document_id: str
    kind: str
    expires_at: datetime
    created_at: datetime | None = None


class TrashListOut(BaseModel):
    items: list[TrashEntryOut] = Field(default_factory=list)


class UserCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=32)
    note: str = Field(default="", max_length=64)
    # 账号字段（v10）：带了 username 就是开通账号，不带就是纯名册条目
    username: str | None = Field(default=None, min_length=1, max_length=64)
    password: str | None = Field(default=None)
    role: Literal["admin", "member"] = "member"


class UserPasswordIn(BaseModel):
    """管理员重置某人的密码。"""

    password: str = Field(min_length=1)


class UserDisabledIn(BaseModel):
    disabled: bool


class UserOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    name: str
    note: str = ""
    username: str | None = None
    role: str = "member"
    disabled: bool = False
    created_at: datetime | None = None
    document_count: int = 0
    """这个人传过多少文档——删他之前要能说清"会影响什么"。"""


class UserListOut(BaseModel):
    items: list[UserOut]
    header: str = ""
    """前端应当把操作者放在哪个请求头里。由后端给出，免得两边各写一份会漂。"""


class UsageBucketOut(BaseModel):
    """一档用量。``day`` / ``kind`` / ``model`` 三选一出，其余留空。"""

    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    items: int = 0
    unreported: int = 0
    """这一档里有多少次调用**供应商没报用量**。"""
    estimated: int = 0
    """这一档里有多少次调用是**我们自己估算**的（向量化接口通常不返回用量）。"""


class UsageDayOut(UsageBucketOut):
    day: str


class UsageKindOut(UsageBucketOut):
    kind: str
    label: str


class UsageModelOut(UsageBucketOut):
    model: str


class UsageTotalsOut(UsageBucketOut):
    pass


class UsageOut(BaseModel):
    """模型用量汇总（G7）。

    **刻意不含费用**：单价随供应商与版本变化，内置价目表必然过期，
    而过期的价钱比不给更糟。只给客观的 token 与调用量，让用户自己换算。
    """

    days: int
    total: UsageTotalsOut
    by_day: list[UsageDayOut] = Field(default_factory=list)
    by_kind: list[UsageKindOut] = Field(default_factory=list)
    by_model: list[UsageModelOut] = Field(default_factory=list)
    reported_calls: int = 0
    """实测调用数（供应商真的回了 usage）。"""
    estimated_calls: int = 0
    """估算调用数（我们按字符数估的，主要是向量化）。"""
    unreported_calls: int = 0
    """既没实测也没得估的调用数。"""
    estimated_tokens: int = 0
    """估算出来的 token 总数（已包含在 total 里）。

    **界面必须把这块单独说清**——假精度比没数字更糟：用户会拿估算值
    去做成本判断，而它可能偏离好几倍。
    """


class PresetModelOut(BaseModel):
    """预设里的一条模型建议。"""

    model_id: str
    label: str = ""
    capabilities: list[str] = Field(default_factory=list)
    dim: int | None = None


class ProviderPresetOut(BaseModel):
    """常见供应商预设：一键填好名称 / 类别 / 接口地址与几条常见模型。"""

    id: str
    label: str
    kind: str
    base_url: str
    hint: str = ""
    models: list[PresetModelOut] = Field(default_factory=list)


class RegistryOut(BaseModel):
    """注册器总览：界面一次拿全，免得开设置页要打四个请求。"""

    providers: list[ProviderOut] = Field(default_factory=list)
    models: list[ModelOut] = Field(default_factory=list)
    slots: list[SlotOut] = Field(default_factory=list)
    provider_kinds: dict[str, str] = Field(default_factory=dict)
    capabilities: dict[str, str] = Field(default_factory=dict)
    provider_presets: list[ProviderPresetOut] = Field(default_factory=list)
    """常见供应商预设。只给"添加供应商"填表单用，**不落库**——用户选了什么才存什么。"""


class WebhookCreateIn(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    events: list[str] = Field(default_factory=list)
    """留空 = 订阅全部事件。显式列出更安全，但默认全订更省事。"""
    secret: str | None = Field(default=None, max_length=256)
    enabled: bool = True


class WebhookUpdateIn(BaseModel):
    """PATCH 只改开关。

    **单独一个模型而不是复用 ``WebhookCreateIn``**：复用会强迫调用方
    在改开关时也传 ``url``，而那个字段会被静默忽略——"传了但没用"是最迷惑人的
    一类接口。真传了 url 就明确报错（多出来的字段被忽略，见下方注释），
    想换地址请删了重建，那一步是有意识的。
    """

    enabled: bool


class WebhookOut(BaseModel):
    id: str
    url: str
    events: list[str] = Field(default_factory=list)
    enabled: bool = True
    has_secret: bool = False
    secret_masked: str | None = None
    secret: str | None = None
    """**明文只在新建成的那一次返回**，之后永远是 ``null``。

    这不是小气：能反复读到签名密钥就等于签名没有意义——任何能列出订阅的人
    都能伪造一份"验签通过"的载荷。
    """


class WebhookListOut(BaseModel):
    items: list[WebhookOut] = Field(default_factory=list)


class WebhookEventListOut(BaseModel):
    events: list[str] = Field(default_factory=list)
    signature_header: str = ""
    max_attempts: int = 0
    delivery_semantics: str = ""
    """``at-least-once``。**必须让接收端知道这件事**——
    不知道的话它会把重复投递当成故障去查，而那是契约的一部分。"""
