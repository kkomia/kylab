"""API 请求/响应模型（协议层）。

命名与字段刻意贴近期望的界面：``stage`` 给状态列，``channels``/``raw_scores`` 给调试台，
``image_ids`` 给图片锚点。**不在此处做业务判断**，只做形状定义（工程规范 §3.3）。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.enums import ApiKeyPermission, DataSourceKind, DocumentStage, TaskKind, TaskState
from app.services.chunking import (
    CHUNK_OVERLAP_MAX,
    CHUNK_SIZE_MAX,
    CHUNK_SIZE_MIN,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_OVERLAP,
)
from app.services.knowledge_base import (
    SYSTEM_PROMPT_MAX_CHARS as KB_SYSTEM_PROMPT_MAX_CHARS,
)
from app.services.memory import MAX_ENTRY_CHARS as MAX_MEMORY_ENTRY_CHARS
from app.services.memory import MAX_RECALL as MAX_MEMORY_RECALL
from app.services.memory_files import MAX_WRITE_CHARS as MAX_MEMORY_FILE_CHARS
from app.services.suggested_questions import (
    DEFAULT_QUESTIONS_PER_CHUNK as DEFAULT_SUGGESTED_COUNT,
)
from app.services.suggested_questions import (
    MAX_QUESTIONS as SUGGESTED_COUNT_MAX,
)
from app.services.suggested_questions import (
    MIN_QUESTIONS as SUGGESTED_COUNT_MIN,
)
from app.services.suggested_questions import (
    PROMPT_MAX_CHARS as SUGGESTED_PROMPT_MAX_CHARS,
)

_RECORD_CONFIG = ConfigDict(from_attributes=True, use_attribute_docstrings=True)
"""记录类响应模型直接由服务/存储的记录对象构建。

调用方写 ``DocumentOut.model_validate(record)``，字段名对不上会在改字段时立刻报错，
比手写一遍 ``_to_out`` 映射少一处"加了字段忘了同步"的漏点。
这也是协议层不 import ``app.storage`` 还能拼出响应的原因（工程规范 §3.3 L1）。

``use_attribute_docstrings=True``（v0.2）：把**字段下面那段文档字符串**放进 OpenAPI 的
description。不加它，前端的派生类型只能拿到字段名——而 `schema.d.ts` 是生成的，
手写的字段说明会在迁移时丢掉。加上它，说明跟着契约走：后端写一处，
生成的类型、Swagger、前端的 IDE 提示都有。
"""

# --------------------------------------------------------------------- 知识库


class KnowledgeBaseCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    #: 切分参数。**范围与 `services/chunking.py` 的常量同源**——在这里写死一份
    #: 迟早会与真正生效的那套漂移（这一层只声明"形状"，业务判断仍在服务层）。
    #: 单个字段的越界在这里就是 422；"重叠 < 块长"这种**跨字段**约束服务层才能
    #: 判断（PATCH 可能只传其中一个），所以那种情况由服务层回 400 + 可读文案。
    chunk_size: int = Field(default=DEFAULT_CHUNK_SIZE, ge=CHUNK_SIZE_MIN, le=CHUNK_SIZE_MAX)
    chunk_overlap: int = Field(default=DEFAULT_OVERLAP, ge=0, le=CHUNK_OVERLAP_MAX)
    embedding_model_pk: str | None = None
    """建库时选定的嵌入模型（注册表主键）。留空 = 用服务端默认。

    嵌入模型是**知识库属性**：文档量小的库可以选高精度模型，量大的选小模型提速。
    模型 ID 与维度在建库时冻结，换模型必须新建库（架构 §6.4 模型锁）。
    """

    #: 分段问题生成（v19 起，v23 起是"入库时为每个分段出题"）。**建库时就能定**，
    #: 之后在「知识库设置 → 切块策略」里改——它与分段同属"入库时怎么处理文本"。
    #: 四个字段与库设置同源，范围常量取自服务层。**默认关**：生成发生在上传之后，要花钱。
    suggested_enabled: bool = False
    suggested_count: int = Field(
        default=DEFAULT_SUGGESTED_COUNT, ge=SUGGESTED_COUNT_MIN, le=SUGGESTED_COUNT_MAX
    )
    suggested_model_pk: str | None = None
    """出题用哪个对话模型（注册表主键）。留空 = 跟随对话页当前选的模型。"""
    suggested_prompt: str = Field(default="", max_length=SUGGESTED_PROMPT_MAX_CHARS)
    """自定义出题提示词。留空 = 用内置提示词。"""

    wiki_enabled: bool = False
    """库形态（v24）：要不要把这个库的已录入内容整理成 Wiki 页面。

    **默认关**：生成要把库里的片段喂给模型（每页一次调用），属于要花钱的产物，
    不该在用户没选之前就开始跑。老库可以在设置里随时打开。"""


class KnowledgeBaseUpdate(BaseModel):
    """改知识库的可编辑属性：名称 / 简介 / 切分参数。**都可选**，只传要改的那个。

    名称与建库同一个上限（120），改名不该比建库更宽松；简介上限 200（卡片两行）。
    空简介（``""``）是合法值 = 清空，所以不加 min_length。

    切分参数（v17）改的是**之后摄入的文档**怎么切；已经切好的块不会自己变，
    界面据此提示"已有文档需要重新摄入"。范围常量与建库同源。
    """

    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=200)
    chunk_size: int | None = Field(default=None, ge=CHUNK_SIZE_MIN, le=CHUNK_SIZE_MAX)
    chunk_overlap: int | None = Field(default=None, ge=0, le=CHUNK_OVERLAP_MAX)

    #: 分段问题生成设置（v19/v23）。四个字段一起提交，但都可不传（不传 = 不改）；
    #: ``suggested_model_pk`` 传空串表示"清除"= 回到跟随对话模型（与简介空串同一套约定）。
    #:
    #: **只对之后摄入的文档生效**：问题是在切块那一步生成的，已入库的块不会自己
    #: 长出新问题——要生效得重新摄入（「重新摄入全部文档」，不重新解析）。
    suggested_enabled: bool | None = None
    suggested_count: int | None = Field(
        default=None, ge=SUGGESTED_COUNT_MIN, le=SUGGESTED_COUNT_MAX
    )
    suggested_model_pk: str | None = None
    suggested_prompt: str | None = Field(default=None, max_length=SUGGESTED_PROMPT_MAX_CHARS)
    wiki_enabled: bool | None = None
    """库形态（v24）：要不要生成 Wiki 页面。不传 = 不改。"""
    system_prompt: str | None = Field(default=None, max_length=KB_SYSTEM_PROMPT_MAX_CHARS)
    """**库级提示词**（v0.19）：回答这个库的问题时的额外要求。

    从对话页搬过来的（原先挂在全局设置 `chat.system_prompt` 上）。空串是合法值
    = 清除（回到只剩内置提示词），所以不加 min_length——与简介同一套约定。
    它不是"替换内置提示词"，而是**追加**在内置那两条底线之后，
    见 `services/chat.build_messages` 里的说明。
    """


class KBPromptGenerateIn(BaseModel):
    """生成库提示词的入参（v0.19）。"""

    model_pk: str | None = Field(
        default=None,
        description="用哪个对话模型来生成；留空用设置里的默认对话模型",
    )


class KBPromptSourceOut(BaseModel):
    """生成时用到的某一篇文档摘要，以及它**有没有被生成的文本引用**。"""

    model_config = _RECORD_CONFIG

    document_id: str
    name: str
    summary: str
    cited: bool = False
    """生成的提示词里有没有 `[来源: 这篇]`。

    ``False`` **不代表这篇没用上**——它可能只提供了背景，而没贡献具体事实。
    界面据此把"被引用的"排在前面。"""


class KBPromptDraftOut(BaseModel):
    """生成结果。**不落库**：用户在设置里看着改完再保存。"""

    model_config = _RECORD_CONFIG

    prompt: str
    sources: list[KBPromptSourceOut] = Field(default_factory=list)
    filename_style_citations: list[str] = Field(default_factory=list)
    """这段提示词里仍在要求把文件名写进正文的地方（旧口径，v0.41 起改成编号式引用）。

    非空 = 模型没听那句"别把文件名写进正文"，界面据此提示核对。
    """
    """模型标了来源、但文件名不在给定清单里的那些。

    **这是"编造"的直接证据**（它引了一篇不存在的文件），界面据此提示核对后再保存。"""


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
    suggested_enabled: bool = False
    """是否为每个分段生成推荐问题（v23）。界面据此回显。"""
    suggested_count: int = DEFAULT_SUGGESTED_COUNT
    suggested_model_pk: str | None = None
    """出题模型。``None`` = 跟随对话页当前选的模型。"""
    suggested_prompt: str = ""
    """自定义出题提示词；空串 = 用内置提示词。"""
    system_prompt: str = ""
    """库级提示词；空串 = 只用内置提示词。界面在库设置里回显与编辑。"""
    wiki_enabled: bool = False
    """库形态（v24）：``False`` = 仅向量检索；``True`` = 向量检索 + Wiki 页面。

    界面据此决定要不要给「Wiki」入口、以及在设置里回显勾选态。"""
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


class DocumentProgressOut(BaseModel):
    """列表行上那条分段进度所需要的信息（§12.115）。

    **不给百分比**（用户也这么要求）：6 个环节的耗时极不均（解析几分钟、切分几秒），
    百分比只会编出一个对不上的数字——"第 3/6 步 · 解析内容 · 已用 2 分 14 秒"
    每一项都能和实际对上。
    """

    status: str = "running"
    """``running`` / ``done`` / ``failed`` / ``canceled``。"""
    step_index: int = 1
    """当前第几步（1-based）。失败时是**停下那一步**，所以能读出"炸在哪"。"""
    step_total: int = 0
    step_label: str = ""
    elapsed_ms: int = 0
    """当前这一步已花的时间。跑着时每次轮询都在涨——这是"还在动"的证据。"""
    total_ms: int = 0
    """整条流水线累计（含重试与重新摄入）。"""
    retries: int = 0
    """这一步重试过几次。"卡住"与"反复重试"要看的处置完全不同。"""
    stalled: bool = False
    """执行租约已过期 = 没有 worker 在续约。**唯一能确定说"卡住"的情形**。"""


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
    question_count: int = 0
    """该文档各分段已生成问题的**总条数**（v24）。0 = 还没出过题。"""
    questioned_chunk_count: int = 0
    """有题的分段数。配合 ``chunk_count`` 显示"几段里有几段出了题"。"""
    questions_pending: bool = False
    """是否还有出题任务在队列里/在跑（v24）。

    列表据此显示"生成中…"，也据此决定继续轮询——出题**不改变文档阶段**，
    只看 ``stage`` 的话前端永远等不到它完成。"""
    summary: str = ""
    """入库时生成的文档摘要（v25）。**问答上下文靠它省 token**，
    界面也把它当一句话说明（抽屉里显示、列表行悬浮显示）。空串 = 还没生成。"""
    progress: DocumentProgressOut | None = None
    """分段进度的摘要（§12.115）。列表行的进度条吃它；完整那棵树在
    ``GET /documents/{id}/timeline``。``None`` = 这条路径没算（老调用点）。"""


class DocumentList(BaseModel):
    """一页文档。

    ``total`` 是**这套筛选条件下的总数**（不是 ``items`` 的长度）：界面要显示
    "共 N 篇 · 第 X / Y 页"，只回一页数据的话前端算不出总页数。
    ``limit`` / ``offset`` 原样回显，调用方不必自己记住请求时传了什么。
    """

    items: list[DocumentOut]
    total: int
    limit: int
    offset: int


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
    """批量动作：``delete``（进回收站）、``reprocess``（重新摄入）、``move``（移目录）、
    ``enable`` / ``disable``（停用或恢复检索）或 ``questions``（为已索引文档补生成分段问题）。

    ``document_ids`` 设上限而不是"随便多少"：一次勾几千篇会把请求体、逐条查询
    与响应都拉大，而界面上的多选本来也到不了那个量级。

    ``all=True``（v17）表示**对这个库的全部文档**执行，忽略 ``document_ids``。
    它服务的场景是"切分参数改了、要整库重跑"：由服务端自己解析全集，
    界面不必先翻页取 id 再回传（那个列表接口一次回全量，本身就是瓶颈）。
    """

    action: Literal["delete", "reprocess", "move", "enable", "disable", "questions"]
    document_ids: list[str] = Field(default_factory=list, max_length=500)
    folder_id: str | None = None
    """``move`` 的目标目录；``None`` 表示移回根目录。其它动作忽略此字段。"""
    all: bool = False

    @model_validator(mode="after")
    def _require_target(self) -> DocumentBatchIn:
        """两者都不给是写错了，当场说清——否则服务层会执行一个空批次、看起来像成功。"""
        if not self.all and not self.document_ids:
            raise ValueError("document_ids 与 all 至少要给一个")
        return self


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
    questions: list[str] = Field(default_factory=list)
    """入库时为这一段生成的问题（v23）。**只读展示**——它由模型产出，
    用户要判断"出题质量如何、值不值得开着"，就得看得见它。"""


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


class HardwareLoadOut(BaseModel):
    """机器与本进程的资源占用（负载面板）。"""

    cpu_percent: float | None = None
    """0–100；**首次采样为 null**（没有上一次采样就没有差值可算），界面显示"—"。"""
    cpu_count: int = 1
    memory_used_bytes: int = 0
    memory_total_bytes: int = 0
    memory_percent: float = 0.0
    process_rss_bytes: int | None = None


class QueueLoadOut(BaseModel):
    """队列深度与并发槽位。"""

    running: int = 0
    pending: int = 0
    slots: int = 1
    """并发上限（``KYLAB_WORKER_CONCURRENCY``）。"""
    pending_by_kind: dict[str, int] = Field(default_factory=dict)
    """排队任务按类型分布——"积压全是出题"和"积压全是解析"该做的事完全不同。"""
    oldest_pending_seconds: float | None = None
    stalled: int = 0
    overdue: int = 0


class ParserQuotaOut(BaseModel):
    """云端解析器的当日额度。"""

    parser_name: str = ""
    configured: bool = False
    pages_used: int = 0
    calls: int = 0
    daily_quota: int = 0
    remaining: int = 0
    exhausted: bool = False
    """额度用尽。**不是错误**：云端只是不再优先处理，任务会继续但变慢。"""


class SystemLoadOut(BaseModel):
    """负载面板（§12.115）：CPU / 内存 / 队列 / 槽位 / 云端额度。"""

    hardware: HardwareLoadOut
    queue: QueueLoadOut
    quota: ParserQuotaOut
    sampled_at: datetime


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
    kb_ids: list[str] = Field(
        default_factory=list,
        description="这一轮依据哪些知识库；**空 = 不使用知识库**（界面上那个开关关掉时）",
    )
    skill_names: list[str] = Field(
        default_factory=list,
        description="本轮钉住（必定展开正文）的技能名，来自输入框「加号 → 技能」",
    )
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


class ChatResumeIn(BaseModel):
    """续跑上一轮的请求体。**没有 query**——问题在会话里，不在这次请求里。

    这一轮的模型档位、思考档位、库范围都取**会话已存的**（续跑是"接着同一轮做"，
    不是新一轮提问，所以不给它换模型的机会）。唯一从界面来的是钉住的技能：
    它存在输入框的偏好里、不入库，而续跑同样需要那几个技能在场。
    """

    skill_names: list[str] = Field(
        default_factory=list,
        description="本轮钉住的技能名（与提问时同一份，来自输入框「加号 → 技能」）",
    )
    model_pk: str | None = Field(default=None, description="留空用会话已存的；一般不必给")
    thinking: bool | None = Field(default=None, description="留空用会话已存的")
    thinking_effort: Literal["low", "medium", "high"] | None = Field(default=None)


class ChatApprovalIn(BaseModel):
    """对一条待确认的工具调用做出决定（v0.41）。

    **只有三个取值**，都是用户在确认条上明确点出来的：允许一次 / 这类都允许 / 拒绝。
    "超时"与"这条链路没人可问"不是请求参数——它们是执行侧自己的结论，
    不该能从外面伪造（伪造了就等于给了一条绕过"等用户点头"的路）。
    """

    decision: Literal["allow_once", "allow_always", "deny"] = Field(
        description="允许一次 / 这类都允许（写进放行清单）/ 拒绝"
    )
    reason: str = Field(
        default="",
        max_length=500,
        description=(
            "拒绝时给模型的一句理由（P2-1，可空）。它会拼进回灌给模型的工具结果"
            "（「对方拒绝了这次执行，理由是：…」），让下一轮模型据此改路子，"
            "而不是把同一条命令原样再试一次；留空则与加这个字段之前完全一样。"
        ),
    )


class ChatApprovalOut(BaseModel):
    """决定有没有真的交到那一头。"""

    accepted: bool
    """``True`` = 正在等的那次执行已经收到它，会立刻接着往下跑。"""
    detail: str = ""
    """给人看的一句话（没送到时说清为什么）。"""


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
    #: 出处所属知识库，界面用它把引用直连到库页抽屉。
    #: 默认空串：历史会话里存的快照没有这个字段，读出来要能兼容。
    knowledge_base_id: str = ""
    #: 这篇文档的摘要（v25）。**它进了提示词**（每条资料后面跟一行"文档背景"，
    #: 同一篇只带一次），在这里回给前端是为了**可核对**：用户能看见模型
    #: 到底拿到了什么背景，而不是只能猜"它为什么这么答"。
    document_summary: str = ""


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
    workspace_id: str | None = None
    """挂到哪个工作区（v0.15）。``None`` = 未归档。

    传了工作区而 ``kb_ids`` 留空时，**知识库范围继承工作区的**（见设计文档 §5）：
    "进入项目，资料范围就定了"——用户不必每次重勾一遍。"""
    model_pk: str | None = None
    """本条会话选用的对话模型（v12）。``None`` = 跟随全局默认。"""
    thinking: bool | None = None
    """本条会话是否开启思考（v16）。``None`` = 跟随全局默认。"""
    thinking_effort: Literal["low", "medium", "high"] | None = None
    """本条会话的思考强度（v16）。``None`` = 跟随全局默认。"""


class ConversationUpdateIn(BaseModel):
    """改会话的可编辑属性：标题 / 置顶。**都可选**，只传要改的那个。

    从一个字段扩成两个而不是新加一个端点：两者都是"整理这条会话"的同一类动作，
    分两个端点只会让前端的"改完刷新"写两遍。
    """

    title: str | None = Field(default=None, min_length=1, max_length=64)
    pinned: bool | None = None
    archived: bool | None = None
    """归档 / 取消归档（v0.17）。与 ``workspace_id`` 的区别是不需要哨兵：
    它只有真/假两种意图，没有"不传"与"传空"的歧义。"""
    workspace_id: str | None = None
    """改归属：传工作区 id = 挂进去，传 ``null`` = 退回未归档。

    这个字段与上两个的区别是它**必须能区分"不传"与"传 null"**——
    所以用了一个哨兵（``UNSET``）在服务端判断，见 conversations.py 的说明。"""


class ConversationRewindIn(BaseModel):
    """回退最近 N 轮问答（「重新生成」用）。默认一轮。"""

    turns: int = Field(default=1, ge=1, le=20)


class ConversationRewindOut(BaseModel):
    """回退结果：``query`` 是被删掉的那句提问，调用方拿它重新发一次。

    没有可回退的内容时 ``query`` 为空串——调用方据此提示，而不是发一次空提问。
    """

    query: str = ""
    removed: int = 0


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
    pinned: bool = False
    """置顶（v17）。置顶的会话排在列表最前，且聊天不改变它的名次。"""
    workspace_id: str | None = None
    """所属工作区（v0.15）；``None`` = 未归档。"""
    archived_at: datetime | None = None
    """归档时间（v0.17）。非空 = 已归档——**归档不是删除**：
    默认列表里看不到它，但内容还在，随时可以取消归档。"""
    preview: str = ""
    """最近一条回答的开头一段（历史会话面板的两行预览）。

    给回答而不是给提问：用户回看历史时想认出的是"这次聊出了什么"，
    而问题往往几条都长得很像（"帮我看看这个"）。
    """
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
    steps: list[dict[str, object]] = Field(default_factory=list)
    """当轮的过程步骤（工具调用、组织回答…，v0.25）。

    与 ``sources`` 同为快照：回看旧回答时，当时调了哪些工具、每步拿到什么，
    都该是当时的样子。老消息没有这一项，返回空列表。
    """

    thinking: str = ""
    """当轮的思考过程全文（v0.25）。空串 = 这一轮没有思考。"""

    created_at: datetime | None = None


class ConversationDetailOut(ConversationOut):
    messages: list[ChatMessageOut] = Field(default_factory=list)


class SessionEventOut(BaseModel):
    """会话日志里的一条事件（P0-2，只追加）。

    抄的是 ZCode 的会话事件日志（开发计划 §12.225）：会话是一串不可变事件，
    消息里的 ``steps`` 是它的投影。字段刻意贴着存储的列（``seq`` / ``kind`` /
    ``payload``）——读的人要能照着日志判断"当时到底发生了什么"，
    在这里再包一层"好看的形状"只会让日志与它的读取方变成两件事。

    ``kind`` 是**词表**取值（``turn/start``、``turn/end``、``step``、
    ``tool_call``、``thinking``、``error``、``interrupted``、``mode/changed``、
    ``command``），定义在 ``services/session_events.py`` 一处。
    """

    model_config = _RECORD_CONFIG

    id: int
    seq: int
    """**会话内**单调递增的序号。同一条会话不会出现两个相同的 ``seq``
    （表上有唯一约束），所以它同时是"事件只追加"的判据。"""
    kind: str
    payload: dict[str, object] = Field(default_factory=dict)
    created_at: datetime | None = None


class SessionEventListOut(BaseModel):
    items: list[SessionEventOut] = Field(default_factory=list)


class ContextUsageItemOut(BaseModel):
    """上下文用量分解里的**一项来源**（P1-3，抄 ZCode 的 ``chat.contextUsage.breakdown``）。

    ``kind`` 是稳定取值（``messages`` / ``system_prompt`` / ``skills`` / ``tools`` /
    ``memory`` / ``other``），``label`` 是界面上显示的那几个字——**界面不要自己翻译
    ``kind``**：分解的口径是服务端定的（比如"记忆与人设"包含哪几份文件），
    两处各写一份迟早会对不上。
    """

    model_config = _RECORD_CONFIG

    kind: str
    """来源：消息 / 系统提示词 / 技能目录 / 工具定义 / 记忆与人设 / 其它。"""
    label: str
    """给人看的中文名。"""
    chars: int = 0
    """这一来源的字符数（估算所依据的那个数）。"""
    tokens: int = 0
    """按字符数估的 token（见 ``estimated``）。"""
    share: float = 0.0
    """占**已用**的比例（0~1）。界面画分解条用它，比每次自己除一遍稳。"""


class ContextUsageOut(BaseModel):
    """这一轮上下文的占用与分解（P1-3 的仪表）。

    **是估算**：按字符数算（中日韩 1 字 ≈ 1 token、其余 4 字符 ≈ 1，刻意偏高），
    真实用量只有端点返回的 ``usage`` 才知道。所以 ``estimated`` 恒为真、
    ``note`` 里写明这句话——仪表上不能把估算画成账单。
    """

    items: list[ContextUsageItemOut] = Field(default_factory=list)
    used: int = 0
    """各项之和（token，估算）。**与 ``items`` 的 ``tokens`` 求和相等**（有用例钉住）。"""
    total: int = 0
    """上下文窗口（token，设置项 ``chat.context_window``）。"""
    ratio: float = 0.0
    """``used / total``（0~1）。"""
    compress_at: int = 0
    """触发自动压缩的阈值（百分比，设置项 ``chat.compress_at``）。界面画那条线要用它。"""
    estimated: bool = True
    """恒为真：这些数字是**按字符数估的**，不是分词器给的。"""
    note: str = ""


class ConversationArtifactOut(BaseModel):
    """会话产出的一份文件（v0.26）。

    与 ``ChatStep.artifacts`` 是**同一个形状**（由 ``ArtifactService.describe``
    生成），这不是巧合：步骤里那一份是流式当时的样子，这里这一份是**现在的样子**。
    两者分叉的话，"刷新之后卡片突然显示已入库"就成了必然。
    """

    artifact_id: str
    name: str
    size_bytes: int = 0
    format: str = ""
    """扩展名小写（``docx`` / ``pdf`` / …），界面据此选图标。"""
    storage: str = "object"
    """``workspace``（落在工作区目录）或 ``object``（落在会话的临时区）。"""
    where: str = ""
    """给人看的那句话：「工作区「我的项目」」/「本会话」。"""
    path: str | None = None
    """工作区那份的绝对路径；对象存储那份没有。"""
    knowledge_base_id: str | None = None
    """进了哪个知识库。``None`` = 没进（默认），界面据此决定要不要给「存进知识库」。"""
    document_id: str | None = None
    created_at: datetime | None = None


class ConversationArtifactListOut(BaseModel):
    items: list[ConversationArtifactOut]


class FileDownloadUrlOut(BaseModel):
    """一条文件链接（预览与下载共用）。**相对路径**：对外域名只有部署时才知道。"""

    url: str
    expires_at: int
    name: str


class FileEntryOut(BaseModel):
    """文件区里的一行（v0.26）。

    ``key`` 是**在这个文件区里唯一指代它**的东西，界面拿它当不透明字符串用：
    工作区模式是相对路径（``报告/初稿.docx``），临时区是产物 id。
    """

    key: str
    name: str
    is_dir: bool = False
    size_bytes: int = 0
    modified_at: datetime | None = None
    kind: str = ""
    """扩展名小写（``docx`` / ``md`` / ``png``…）或 ``dir``。**界面按它选渲染器**，
    服务端算好——两处各算一遍迟早会分叉。"""


class FileListingOut(BaseModel):
    """一层目录（临时区是唯一的一层）。"""

    mode: str
    """``workspace``（能进子目录）/ ``object``（平铺的会话临时区）。"""
    label: str
    """给人看的那句话：「工作区「我的项目」」/「本会话」。"""
    path: str = ""
    parent: str | None = None
    entries: list[FileEntryOut] = Field(default_factory=list)
    truncated: bool = False
    """条目被截断过。界面要如实说"只显示了前 N 项"——
    否则"这个项目只有 300 个文件"与"我只给你看了 300 个"看起来一模一样。"""


class IngestArtifactIn(BaseModel):
    """把一份产物存进知识库。**库必须由调用方点明**——服务端不替他挑。"""

    knowledge_base_id: str = Field(min_length=1, max_length=64)


class StorageOverviewOut(BaseModel):
    """存储空间概览（v17，管理员）。

    ``data_bytes + free_bytes`` 就是数据库文件大小——拆成两个数是因为
    "可回收"才是用户能动手改的那部分：删掉的行留下**死元组**，
    ``VACUUM (ANALYZE)`` 之后那部分空间才可被复用。
    **文件本身不会因此变小**（那是 ``VACUUM FULL`` 的事，它要独占重写整库，本项目不做）。
    """

    model_config = _RECORD_CONFIG

    file_bytes: int
    data_bytes: int
    free_bytes: int
    partitions: int
    """向量分区数。每个分区写入第一个向量就占一个 4MB 块，所以它值得单独看。"""
    orphans: list[str] = Field(default_factory=list)
    """无主的向量分区（知识库已删、表还留在库里）。「整理存储」会丢掉它们。"""


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
    avatar_url: str = ""
    """头像链接（签名 URL，v0.29）。空 = 没有头像 → 界面用名字生成默认头像。"""


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


# --------------------------------------------------------------------- 笔记（v20）


class NoteCreateIn(BaseModel):
    title: str = Field(default="", max_length=80)
    content_md: str = ""
    source_kind: Literal["manual", "chat", "clip"] = "manual"
    source_ref: str | None = None
    tags: list[str] = Field(default_factory=list)


class NoteUpdateIn(BaseModel):
    """全部字段可空：只传要改的字段。``None`` = 不动这一项。"""

    title: str | None = Field(default=None, max_length=80)
    content_md: str | None = None
    pinned: bool | None = None
    tags: list[str] | None = None


class NoteAttachIn(BaseModel):
    kb_id: str = Field(min_length=1)


class NoteOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    title: str
    content_md: str
    source_kind: str
    source_ref: str | None = None
    kb_id: str | None = None
    doc_id: str | None = None
    pinned: bool = False
    tags: list[str] = Field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None


class NoteListItemOut(NoteOut):
    """列表项不带正文：列表页只要标题、标签与时间，带上正文会让响应体积翻很多倍。"""

    content_md: str = ""
    preview: str = ""


class NoteListOut(BaseModel):
    items: list[NoteListItemOut] = Field(default_factory=list)
    total: int = 0
    limit: int = 0
    offset: int = 0


class NoteTagOut(BaseModel):
    tag: str
    count: int


class NoteTagListOut(BaseModel):
    items: list[NoteTagOut] = Field(default_factory=list)


class NoteAiIn(BaseModel):
    """笔记 AI 处理请求。

    ``action`` 三档：``format`` 只排版 / ``polish`` 只润色 / ``both`` 两者一起。
    """

    action: Literal["format", "polish", "both"]
    model_pk: str | None = None
    """用哪个对话模型；留空用全局默认。"""


class NoteAiOut(BaseModel):
    content_md: str
    """处理后的 Markdown。**不自动落库**：由调用方决定要不要写回，用户可先看再存。"""


class NoteImageOut(BaseModel):
    url: str
    """可直接放进 ``<img src>`` 的相对地址（带签名，无需自定义请求头）。"""

    name: str
    alt: str


# --------------------------------------------------------------------- Wiki（v24）


class WikiSourceOut(BaseModel):
    """Wiki 页面的一条出处。``index`` 就是正文里 ``[n]`` 的 n。"""

    index: int
    chunk_id: str
    document_id: str
    document_name: str = ""
    """后端解析好的文档名——前端拿 id 还得再查一次。"""
    heading_path: str | None = None
    page: int | None = None


class WikiPageOut(BaseModel):
    """目录里的一个页面（不含正文，导航树只需要这些）。"""

    id: str
    parent_id: str | None = None
    level: int = 0
    ord: int = 0
    title: str
    brief: str = ""
    status: str = "ready"
    generated_at: datetime | None = None


class WikiOverviewOut(BaseModel):
    """Wiki 页头需要的全部信息 + 页面目录。

    ``status`` 只有四档（``idle`` / ``generating`` / ``ready`` / ``failed``），
    **由后端推出来**（有没有在跑的任务 + 有没有页面），前端不自己组合状态。
    """

    kb_id: str
    enabled: bool
    status: str
    page_count: int = 0
    generated_at: datetime | None = None
    model: str | None = None
    last_error: str | None = None
    """上次失败的原文（任务里的 error）。只在 ``status='failed'`` 时有值。"""
    pages: list[WikiPageOut] = Field(default_factory=list)


class WikiPageDetailOut(WikiPageOut):
    kb_id: str
    content_md: str = ""
    model: str | None = None
    updated_at: datetime | None = None
    sources: list[WikiSourceOut] = Field(default_factory=list)


class WikiGenerateOut(BaseModel):
    task_id: str
    kb_id: str


class TaskCancelIn(BaseModel):
    """取消还没结束的任务（v24）。

    **两种用法**，都支持：

    - 点名取消：给 ``task_ids``；
    - 一键清空排队：不给 ids，只给 ``state``（默认 ``pending``），
      服务端按调用方**可见范围**解析出全部候选——这才是"几十条堵在队列里"时
      真正想点的那个按钮。
    """

    task_ids: list[str] = Field(default_factory=list, max_length=500)
    state: Literal["pending", "running", "all"] = "pending"


class TaskCancelItemOut(BaseModel):
    task_id: str
    ok: bool
    error: str | None = None


class TaskCancelOut(BaseModel):
    """逐条结果：批量里"30 条撤下 28 条"是正常结果，界面要能指出剩下两条为什么没成。"""

    succeeded: int
    failed: int
    items: list[TaskCancelItemOut] = Field(default_factory=list)


class TimelineStepOut(BaseModel):
    """时间线上的一个环节。"""

    key: str
    label: str
    status: Literal["done", "running", "pending", "failed", "canceled"]
    duration_ms: int
    visits: int
    """进入过几次；>1 = 重试或重新摄入过。"""
    error: str | None = None


class DocumentTimelineOut(BaseModel):
    """一篇文档的处理进度：共几步、现在第几步、共耗时多少、每步各花多久。

    **不给百分比**：摄入的环节耗时不均（解析可能几分钟、切分几秒），
    百分比只会编出一个骗人的数字；"第 3/6 步 + 每步实际耗时"才是能对得上的信息。
    """

    document_id: str
    status: Literal["running", "done", "failed", "canceled"]
    current_index: int
    step_total: int
    total_ms: int
    steps: list[TimelineStepOut] = Field(default_factory=list)
    stalled: bool = False
    """执行租约已过期 = 没有 worker 在续约（§12.115）。

    抽屉要显示它，而它是**唯一能确定说"卡住"**的判据——光看"某一步跑了一小时"
    说明不了问题（解析大文件本来就慢）。判据来自 ``ObservabilityService``，
    与任务中心那一列同源。"""


# ------------------------------------------------------------------ 沙箱（v0.16）


class SandboxCapabilityOut(BaseModel):
    """这台机器上的内核级隔离能力。"""

    backend: Literal["bwrap", "sandbox-exec", "docker", "none"]
    available: bool
    detail: str = ""
    """人话说明（为什么可用/不可用）。界面直接显示它。"""
    max_output_chars: int = 0
    default_timeout_seconds: float = 0


class SandboxExecIn(BaseModel):
    """一次沙箱执行。``argv`` 是**命令数组**（不是 shell 字符串）——
    数组没有引号解析、没有管道、没有重定向，省掉一整类注入面。"""

    argv: list[str] = Field(min_length=1, max_length=64)
    workspace_id: str | None = None
    """在哪个工作区里跑。不给就只在沙箱里跑，不挂任何真实工作区。"""
    session_id: str = ""
    """沙箱按会话分（同一会话的多次尝试共享一份，见设计文档 §4）。"""
    allow_network: bool = False
    """**默认断网**：Agent 跑的命令绝大多数不需要网络，
    而"能联网"是数据外泄那条路上最省事的一环。"""
    timeout_seconds: float | None = Field(default=None, gt=0, le=600)
    approved: bool = False
    """``ask`` 政策下第一次不带它（回 409），用户确认后再带上重调。"""
    remember: bool = False
    """确认之后**把这条规则写进放行清单**（「以后都允许」）。

    写入的是**建议的词前缀**（``Bash(git status:*)``）而不是完整命令——
    记住完整命令等于没记住（下次参数就不同了）。
    """


class SandboxPlanOut(BaseModel):
    """隔离后的命令行——**给用户核对的**。"""

    backend: str
    available: bool
    detail: str = ""
    argv: list[str] = Field(default_factory=list)
    workdir: str = ""


class SandboxExecOut(BaseModel):
    exit_code: int
    stdout: str = ""
    stderr: str = ""
    truncated: bool = False
    timed_out: bool = False
    backend: str = ""


# ------------------------------------------------------------------ 工作区（v0.15）


class WorkspaceCreateIn(BaseModel):
    """新建工作区。``root_path`` 是**用户指定的真实目录**——
    这是"可以指定路径作为工作区"的落点。"""

    name: str = Field(min_length=1, max_length=120)
    root_path: str = Field(min_length=1, max_length=1000)
    """根目录的绝对路径（或带 ``~``）。服务端校验：存在、是目录、
    不是文件系统根、不指向数据目录。"""
    description: str = Field(default="", max_length=500)
    kb_ids: list[str] = Field(default_factory=list)
    """这个工作区绑定的知识库（"知识库与 Agent 天生融合"的落点）。
    新会话默认继承它们，所以用户不必每开一次会话重勾一遍。"""


class WorkspaceUpdateIn(BaseModel):
    """改工作区。**都可选**，只改传了的那些（``None`` = 不动）。"""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    root_path: str | None = Field(default=None, min_length=1, max_length=1000)
    description: str | None = Field(default=None, max_length=500)
    kb_ids: list[str] | None = None


class WorkspaceOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    name: str
    root_path: str
    description: str = ""
    kb_ids: list[str] = Field(default_factory=list)
    conversation_count: int = 0
    """这个工作区下的会话数。侧栏每个工作区后面那个数字。"""
    created_at: datetime | None = None
    updated_at: datetime | None = None


class WorkspaceListOut(BaseModel):
    items: list[WorkspaceOut] = Field(default_factory=list)


class DirectoryEntryOut(BaseModel):
    """目录浏览里的一行：一个子目录，或一个"起点"。

    **三对字段**（v0.41）：能不能选、能不能在它里面新建目录、能不能给它改名——
    各带各的原因。合成一个 ``reason`` 会让人分不清"不能选"还是"不能建"，
    而这两件事的下一步动作不一样（换一个目录 vs 换一个地方动手）。"""

    name: str
    path: str
    selectable: bool = True
    """能不能直接拿它当工作区。**与建工作区时同一份判定**（``root_path_problem``），
    所以界面上灰掉的那些，点"选择"也一定建不出来。"""
    reason: str = ""
    """不能选的原因（原样显示给用户）。"""
    creatable: bool = True
    """能不能在**它里面**新建目录（判定在 ``workspace.create_problem``）。

    只有专用区域（``<data_dir>/workspaces``）里为真——容器里除了数据目录几乎处处只读，
    与其让用户逐个试，不如把"能建"标在还能建的那一处、把"不能建"的原因标在别的行上。
    界面据此把"新建文件夹"灰掉并把 ``create_reason`` 摆出来。"""
    create_reason: str = ""
    """不能在它里面新建目录的原因（原样显示）。"""
    renamable: bool = True
    """能不能给它改名（判定在 ``workspace.rename_problem``）。"""
    rename_reason: str = ""
    """不能改名的原因（原样显示）。"""


class DirectoryCreateIn(BaseModel):
    """在服务器上新建一个目录（``POST /workspaces/dirs``，v0.36）。"""

    parent: str = Field(min_length=1, max_length=1000)
    """建在哪一层（绝对路径，来自浏览接口给的 ``path``）。"""
    name: str = Field(min_length=1, max_length=80)
    """新目录名。**只建一层**：名字里带分隔符会当场被拒，不替你递归造父目录。"""


class DirectoryRenameIn(BaseModel):
    """给服务器上的一个目录改名（``PATCH /workspaces/dirs``，v0.36）。**只改名，不搬位置**。"""

    path: str = Field(min_length=1, max_length=1000)
    """要改名的那个目录（绝对路径）。"""
    name: str = Field(min_length=1, max_length=80)
    """新名字。"""


class WorkspaceBrowseOut(BaseModel):
    """浏览服务器目录的结果（``GET /workspaces/browse``，v0.35）。

    **为什么这件事在服务端做**：工作区根目录是**服务器上**的路径（后端跑在 NAS 上），
    而浏览器既拿不到、也不该拿到服务器上的绝对路径——客户端的目录选择器指向的是
    另一台机器。所以"选择"只能是"服务端列给你看"。"""

    path: str
    current: DirectoryEntryOut
    """**当前这一层自己**（名字 + 能不能选 + 不能选的原因 + 能不能建 + 不能建的原因）。

    服务端给而不是让界面自己判：那几条判定只有一份，界面再猜一次就会出现
    "按钮亮着、点了却建不出来"。"""
    parent: str | None = None
    """上一级；已经在最上层时为 ``None``（界面把"上一级"置灰）。"""
    entries: list[DirectoryEntryOut] = Field(default_factory=list)
    roots: list[DirectoryEntryOut] = Field(default_factory=list)
    """起点（**专用区域** / 家目录 / 盘符 / 已有工作区的目录）：路径很深时不用从根一路点下来。"""
    note: str = ""
    """一句人话说明（"共有 N 个，只列了前 M 个"这类）。空串 = 没什么要说的。"""
    area: str = ""
    """专用可写区域（``<data_dir>/workspaces``）：选择器的默认落脚点，也是唯一能
    新建/改名目录的地方。

    界面用它认出"现在站的这一层就是区域"（给一句"在这里可以新建"的提示）。
    由服务端给而不是前端拼：数据目录在哪只有服务端知道。"""


# ------------------------------------------------------------------ MCP（v0.15）


class MCPServerCreateIn(BaseModel):
    """登记一个外部 MCP 服务。见《Agent-工作区与能力层设计》§6.2。"""

    name: str = Field(min_length=1, max_length=120)
    transport: Literal["stdio", "http"]
    """``stdio`` 会**起一个本地子进程**；``http`` 连远端服务。"""
    target: str = Field(min_length=1, max_length=1000)
    """stdio = 要执行的命令（如 ``python``）；http = 服务的 URL。"""
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    """子进程的环境变量。**可能含凭据，接口不回显它的值。**"""
    headers: dict[str, str] = Field(default_factory=dict)
    """http 服务的请求头（如 ``Authorization``）。同上，不回显。"""
    policy: Literal["allow", "ask", "deny"] = "ask"
    """**默认 ask**：外部工具会以用户的名义执行动作，接进来就默认静默执行
    是这一层最不该有的默认。"""


class MCPServerUpdateIn(BaseModel):
    """改配置。**凭据是整份替换**（合并语义下"删掉"与"没传"分不开）。"""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    transport: Literal["stdio", "http"] | None = None
    target: str | None = Field(default=None, min_length=1, max_length=1000)
    args: list[str] | None = None
    env: dict[str, str] | None = None
    headers: dict[str, str] | None = None
    policy: Literal["allow", "ask", "deny"] | None = None
    enabled: bool | None = None


class MCPToolOut(BaseModel):
    name: str
    qualified: str
    """限定名 ``mcp__<服务>__<工具>``：外部工具名我们无法约束，
    撞上内置工具（``search``）会让"在调哪个"变得无解。"""
    description: str = ""
    server_id: str = ""
    server_name: str = ""


class MCPServerOut(BaseModel):
    id: str
    name: str
    transport: Literal["stdio", "http"]
    target: str
    args: list[str] = Field(default_factory=list)
    policy: Literal["allow", "ask", "deny"] = "ask"
    enabled: bool = True
    secret_keys: list[str] = Field(default_factory=list)
    """配过凭据的**键名**（不含值）。界面据此显示"已配置"。"""
    has_secrets: bool = False
    tool_prefix: str = ""
    """该服务工具的限定名前缀，界面上照它拼全名。"""
    reachable: bool | None = None
    """只有 ``probe`` 会给：``None`` = 没探过（列表里就是这样）。"""
    detail: str = ""
    tools: list[MCPToolOut] = Field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None


class MCPServerListOut(BaseModel):
    items: list[MCPServerOut] = Field(default_factory=list)


class MCPCallIn(BaseModel):
    tool: str = Field(min_length=1, max_length=200)
    arguments: dict[str, Any] = Field(default_factory=dict)
    approved: bool = False
    """``ask`` 策略下：第一次调用不带它（回 409），用户确认后再带上它重调。"""
    remember: bool = False
    """确认之后把这条工具的规则写进放行清单（「以后都允许」）。"""


class MCPCallOut(BaseModel):
    server_id: str
    tool: str
    text: str
    """工具返回的**文本**内容。非文本（图片、资源引用）不往上下文里塞。"""


# ------------------------------------------------------------------- 技能（v0.15）


class SkillOut(BaseModel):
    """一个技能（列表项，不含正文）。"""

    name: str
    description: str = ""
    summary: str = ""
    """**中文简介**（v0.28）。空 = 没有（随代码发布的、手放的技能都没有）。

    它只是界面上的那一行说明：技能的 ``description`` 一个字都不改——
    那是模型判断"何时该用"的触发文本（见 services/skill_blurb.py）。"""
    source: Literal["builtin", "user", "agents"] = "builtin"
    """``builtin`` = 随代码发布（仓库 ``skills/``）；``user`` = 数据目录 ``data/skills/`` 里
    用户放的；``agents`` = ``~/.agents/skills``（跨工具共享的用户级目录，P0-3）。"""
    path: str = ""
    """``SKILL.md`` 的绝对路径。排错时要能找到它。"""
    directory: str = ""
    """技能目录（``references/`` 相对它解析）。"""
    used_by_prompt: bool = True
    """会不会进 system prompt 的目录。被安全扫描拦下、依赖没满足、被丢弃的都是 false。"""
    flagged: list[str] = Field(default_factory=list)
    """没进目录的原因（人话）。空 = 没问题。"""
    discarded: bool = False
    """**被丢弃**（P0-3）：frontmatter 缺 ``name``/``description`` 或描述超长，
    照 ZCode 的规则整个技能不加载。它仍然出现在列表里（带着 ``flagged`` 那条理由），
    但既不进提示词，也读不出正文——能力页要能看见"装了但没通过校验"的那些。"""


class SkillDetailOut(SkillOut):
    body: str = ""
    """正文（frontmatter 之后的部分）。**按需展开的那一段**。"""


class SkillMarketIn(BaseModel):
    """浏览一个源。``source`` 可以是目录 / ``catalog.json`` / 它们的 URL。"""

    source: str = Field(min_length=1, max_length=2000)


class SkillMarketEntryOut(BaseModel):
    name: str
    description: str = ""
    source: str = ""
    installed: bool = False
    """已经装过——界面上据此把"安装"按钮换成"已安装"。"""


class SkillMarketOut(BaseModel):
    source: str
    items: list[SkillMarketEntryOut] = Field(default_factory=list)


class SkillInstallIn(BaseModel):
    """安装一个技能。"""

    name: str = Field(min_length=1, max_length=120)
    source: str = Field(min_length=1, max_length=2000)
    """目录 / zip / URL。三种形态服务端都认（见 services/skill_market.py）。"""
    catalog: str = ""
    """可选的源目录：``source`` 只是源里的条目名时，由它定位。"""


class SkillInstalledOut(BaseModel):
    """已装清单：``技能名 → 来源``。"""

    items: dict[str, str] = Field(default_factory=dict)
    total: int = 0


# --------------------------------------------------------------------- 技能源（v0.27）
#
# 与上面那组"市场"的区别：那组面向**一个源地址**（目录 / zip / catalog.json），
# 这组面向**一个线上仓库**（浏览 → 看清单 → 按 SHA 装）。
# 调研见《技能仓库与技能市场调研-v0.1》§4.6。


class SkillSourceOut(BaseModel):
    """一个可浏览的技能源（就是"一个 GitHub 仓库"）。"""

    id: str
    name: str
    repo: str
    """``owner/repo``。**与显示名分开**：名字会改，仓库地址不会。"""
    ref: str = ""
    """分支 / 标签。空 = 用仓库的默认分支。"""
    subpath: str = ""
    """只在这个子目录里找技能（空 = 全仓递归扫）。"""
    builtin: bool = True
    enabled: bool = True
    why: str = ""
    """为什么内置它（一句话）。空 = 用户自己加的源。"""


class SkillSourceListOut(BaseModel):
    items: list[SkillSourceOut] = Field(default_factory=list)


class SkillSourceIn(BaseModel):
    """添加一个自定义源。``repo`` 认 ``owner/repo`` 与 GitHub 的仓库 / 子目录 URL。"""

    repo: str = Field(min_length=1, max_length=500)


class SkillSourcePatchIn(BaseModel):
    enabled: bool


class MarketSkillOut(BaseModel):
    """浏览结果里的一条（还没装）。"""

    name: str
    description: str = ""
    summary: str = ""
    """中文简介（v0.28）。空 = 没翻成，界面退回 ``description``。"""
    path: str
    """技能目录在仓库里的相对路径（安装时按它取文件）。"""
    source_id: str = ""
    repo: str = ""
    installed: bool = False


class SkillBrowseIn(BaseModel):
    source_id: str = Field(min_length=1, max_length=120)
    refresh: bool = False
    """忽略缓存重新抓一次。**默认用缓存**：GitHub 匿名配额 60 次/小时。"""


class SkillBrowseOut(BaseModel):
    source: SkillSourceOut
    items: list[MarketSkillOut] = Field(default_factory=list)
    cached: bool = True
    """这一份是不是缓存——界面上要说清楚"看到的是几小时前的清单"。"""


class SkillFileOut(BaseModel):
    """技能目录里的一个文件。``kind`` = doc / code / asset。"""

    path: str
    size: int = 0
    kind: str = "doc"


class SkillInspectIn(BaseModel):
    source_id: str = Field(min_length=1, max_length=120)
    path: str = Field(min_length=1, max_length=1000)


class SkillBundleOut(BaseModel):
    """**装之前**摊给用户看的那一份：文件清单 + 版本 + 体积。"""

    source_id: str
    repo: str
    sha: str = ""
    """40 位 commit SHA。安装按它取——分支会在两步之间变。"""
    path: str
    name: str
    description: str = ""
    ref: str = ""
    license: str = ""
    files: list[SkillFileOut] = Field(default_factory=list)
    total_bytes: int = 0
    summary: str = ""
    """中文简介（v0.28）：装完会跟着记进安装清单，能力页上还能看到。"""
    code_count: int = 0
    """其中会被当作代码执行的文件数。装之前要显眼地提示。"""
    truncated: bool = False
    """仓库太大、GitHub 的文件树被截断：**清单可能不全**，界面要如实说。"""


class SkillSourceInstallIn(BaseModel):
    """从线上源安装：``source_id`` + 浏览结果里的 ``path``。"""

    source_id: str = Field(min_length=1, max_length=120)
    path: str = Field(min_length=1, max_length=1000)


class SkillListOut(BaseModel):
    items: list[SkillOut] = Field(default_factory=list)
    usable: int = 0
    """其中真正会进模型目录的条数——界面上一眼看出"装了 N 个，能用 M 个"。"""


# ------------------------------------------------------------------ 斜杠命令（P1-2）


class CommandOut(BaseModel):
    """一条斜杠命令（照 ZCode 的内置表 + ``commands/*.md`` 自定义命令）。

    前四个字段 ``{name, summary, usage, group}`` 就是前端那个 ``/`` 菜单吃的东西
    （``details`` 给 ``/help <命令名>`` 展开用；``shadowed_by`` / ``error`` 是排错用的）。
    技能注册来的那批也在里面（``/技能名 [任务]``）——它们取 ``group="skill"``：
    技能是**单独一档**（``CommandDef.group``），不混进"内置 / 你放的 / 随代码发布"
    里，那三档装不下二十多条命令、也辨认不出技能。
    """

    name: str
    summary: str = ""
    """一句话：这条命令是干什么的（菜单那一行）。

    **技能那批是短的**：有中文简介用它，没有就取技能描述的第一句并截到约 40 个字
    （``commands.SKILL_SUMMARY_CHARS``）——技能的 ``description`` 是给模型看的
    触发文本，整段塞进菜单会被前端再截一次，读起来只剩一句半。
    """
    usage: str = ""
    """怎么用（形如 ``/mode [plan|build|edit|yolo]``）。"""
    group: Literal["builtin", "user", "repo", "skill"] = "builtin"
    """菜单分组：**内置 / 你放的（数据目录 commands/）/ 随代码发布 / 技能**。"""
    details: list[str] = Field(default_factory=list)
    """展开说明（``/help <命令名>`` 用它，与菜单同一份数据）。"""
    argument_hint: str = ""
    """自定义命令 frontmatter 里的 ``argument-hint``（照 ZCode）。"""
    short_circuit: bool = True
    """**这条通常要不要模型**：为真的是 ``/help`` ``/mode`` 这一类。

    **界面不拿它分流**（见 ``_CommandResult.short_circuit`` 与前端 ``ChatView.runCommand``）：
    它是**表级**的保守口径，而 ``/plan`` 是"看有没有参数"的两面派——不带描述时只是切档，
    带上描述时那段描述就是这一轮的提示。真正的判据是**这一轮的结果**：出了内容
    （步骤 / 出处 / 正文）就按普通一轮渲染，没出才算"只回一句系统提示"。
    """
    shadowed_by: str = ""
    """**被谁遮蔽**（空 = 没被遮蔽）：同名时内置 > 用户 > 仓库 > 技能，first match wins。
    被遮蔽的**仍然在列表里**（照插件列表的做法）——静默藏掉会让人以为文件没生效。"""
    error: str = ""
    """加载失败的原因（人话）。空 = 没问题。失败的也留在列表里，带原因。"""
    path: str = ""
    """md／``SKILL.md`` 的绝对路径（内置命令为空）。排错时要能找到它。"""


class CommandListOut(BaseModel):
    """``GET /api/v1/chat/commands`` 的返回：菜单 + 两条发现源。"""

    items: list[CommandOut] = Field(default_factory=list)
    total: int = 0
    user_dir: str = ""
    builtin_dir: str = ""
    """两条发现源——**放进 ``user_dir`` 的 md 文件就是一个命令**（零注册、零重启）。
    空串 = 这个目录不存在，扫描时跳过。"""


class ChatCommandEventOut(BaseModel):
    """短路类命令那一轮的事件体（SSE 里的 ``type=command``，P1-2）。

    **刻意不进 OpenAPI**：这条流没有 ``response_model``（SSE 是一串裸载荷），
    所以这个类不是"接口文档"，而是**契约的唯一落点**——协议层按它拼载荷、
    前端的 ``ChatCommandResult`` 按它对齐，两边都改的时候有个共同的地方可看。

    两个可选的字段（``action`` / ``refill``）**没有就不出现在载荷里**：
    老客户端不认它们时行为一个字都不变（``wire()`` 那道判断就是这件事的实现）。
    """

    type: Literal["command"] = "command"
    name: str
    """命令名（``/help`` → ``help``）。"""
    text: str = ""
    """回给用户看的那段话（界面按普通文本渲染，**不进模型上下文**）。"""
    ok: bool = True
    """失败的命令也走这条事件：那句解释就是回话，不是 HTTP 500。"""
    action: dict[str, object] | None = None
    """界面要顺手做的事（开新会话 / 切到某档 / 停掉这一轮 / 换模型）。"""
    refill: str = ""
    """要**回填到输入框**的文字（``/rewind`` 交回被撤掉的那句提问）。

    与前端约定死的可选字段：有就填上（用户改一版就能重发，Claude/Gemini 里
    ``/rewind`` 的手感），没有就什么都不做。
    """

    def wire(self) -> dict[str, object]:
        """给 SSE 用的那一条：**可选字段没有就不出现**（向后兼容的唯一实现处）。

        不用 ``model_dump(exclude_none=True)``：那样 ``action`` 里的 ``None`` 会被
        剔掉，而 ``/model`` 那条动作里 ``kind`` 与 ``model_pk`` 是并列的，
        "哪些字段该永远在、哪些该消失"是这条流的语义，值得写出来而不是靠默认行为。
        """
        event: dict[str, object] = {
            "type": self.type,
            "name": self.name,
            "text": self.text,
            "ok": self.ok,
        }
        if self.action:
            event["action"] = dict(self.action)
        if self.refill:
            event["refill"] = self.refill
        return event


# ------------------------------------------------------------------ 插件包（v0.43）


class PluginComponentOut(BaseModel):
    """插件提供的一样东西（四类能力面之一）。

    照 QwenPaw 的 ``register(api)`` 四类收窄而来（provider / 生命周期 hook /
    控制命令 / 工具配置），见 `docs/设计/插件与技能-v0.1.md` §3。
    """

    kind: Literal["skill", "command", "hook", "tool"]
    name: str
    description: str = ""
    path: str = ""
    """相对插件根的路径（``tool`` 那一类就是 manifest 里写的 ``entry``）。"""
    status: str = ""
    """这一类**现在到底能不能用**。做不到的明说"未实现"——四类都还没接执行。"""


class PluginOut(BaseModel):
    """一个插件（本地市场里的一条）。

    **加载失败的也在列表里**（``loaded=false`` 且 ``error`` 非空），照 DSH
    "失败的 preset 也列出"：静默藏掉会让用户以为插件没装上。
    """

    name: str
    version: str = "0.0.0"
    description: str = ""
    author: str = ""
    homepage: str = ""
    source: Literal["builtin", "user"] = "user"
    """``user`` = 数据目录里用户放的（本地市场）；``builtin`` = 随代码发布。"""
    path: str = ""
    """插件目录的绝对路径。"""
    manifest_path: str = ""
    enabled: bool = True
    blocked: bool = False
    """内置且被用户屏蔽（照 ZCode 的屏蔽标记）：**不是删除**，只是不要再启用。"""
    loaded: bool = True
    """校验过了没有。``false`` 时 ``error`` 一定非空。"""
    error: str = ""
    """加载失败的原因（人话）。空 = 加载成功。"""
    components: list[PluginComponentOut] = Field(default_factory=list)
    kinds: list[str] = Field(default_factory=list)
    """提供了哪几类能力（``skill``/``command``/``hook``/``tool`` 的子集）。"""
    user_config: list[str] = Field(default_factory=list)
    """manifest 里 ``userConfig`` 声明的字段名。**本轮只登记名字**（录入未实现）。"""


class PluginListOut(BaseModel):
    items: list[PluginOut] = Field(default_factory=list)
    total: int = 0
    enabled: int = 0
    failed: int = 0
    """加载失败的条数。它们**也在 items 里**（带着原因），这个数只是给状态栏用。"""
    user_dir: str = ""
    builtin_dir: str = ""
    """两条发现源——**本地市场就是这两个目录**（放进来的目录就是"上架"）。
    空串 = 这个目录不存在，扫描时跳过。"""


# --------------------------------------------------------------------- 记忆（v0.14 三期）


class MemoryFileOut(BaseModel):
    """记忆工作区里的一个文件（列表项，不含正文）。"""

    path: str
    name: str
    title: str
    kind: Literal["core", "daily", "digest", "other"]
    summary: str = ""
    tags: list[str] = Field(default_factory=list)
    size_bytes: int = 0
    modified_at: str = ""
    links: list[str] = Field(default_factory=list)
    retrievable: bool = False
    """``recall`` 找不找得到它。

    **必须显示出来**：只有 ``daily/`` 与 ``digest/`` 在 ReMe 的 ``watch_dirs`` 里、
    才进检索索引；``MEMORY.md`` / ``SOUL.md`` 走注入。用户改完一个不参与检索的
    文件却搜不到时，界面得能解释"这是位置决定的"，而不是让他怀疑索引坏了。
    """

    injected: bool = False
    """每轮对话会不会被注入 system prompt（只有两个核心文件）。"""

    consolidated: bool = False
    """``daily`` 专有：有没有被 ``digest/`` 里的文件链到（= 是否已被整合）。"""


class MemoryFilesOut(BaseModel):
    files: list[MemoryFileOut] = Field(default_factory=list)
    total: int = 0
    truncated: bool = False
    """文件数达到扫描上限被截断了——列表不完整这件事要让用户知道。"""


class MemoryFileDetailOut(MemoryFileOut):
    content: str = ""
    """原文，**含 frontmatter**：编辑器要能逐字存回去，不能因为我们"顺手格式化"
    而丢掉用户手写的东西。"""

    meta: dict[str, Any] = Field(default_factory=dict)
    truncated: bool = False
    consolidated: bool | None = None
    """**这里恒为 None**（= "没算"）：整合状态要跨文件才知道，而读单个文件不该
    扫整个工作区。覆盖父类的同名布尔字段，就是为了不让界面把一个"恒 False"
    显示成"未整合"——那是在说假话。列表接口里它是真值。"""


class MemoryFileWriteIn(BaseModel):
    content: str = Field(max_length=MAX_MEMORY_FILE_CHARS)
    """整份内容（含 frontmatter）。**是覆盖不是追加**——编辑器里看到什么就存什么。"""


class MemoryStatusOut(BaseModel):
    """记忆层的状态。

    ``enabled`` 与 ``reachable`` 是**两件事**：前者是"有没有打开"，后者是
    "记忆服务活着吗"。分开是因为它们对应完全不同的处置——没打开要去设置里开，
    服务没起要去把进程拉起来。揉成一个"不可用"会让用户不知道该动哪里。
    """

    enabled: bool
    base_url: str = ""
    workspace: str = ""
    core_file_exists: bool = False
    reachable: bool | None = None
    """**三态**：``None`` = 这次没探测（``GET /memory`` 从不打远端），
    ``True``/``False`` = ``POST /memory/probe`` 真探过。

    用布尔的话，页头会在服务健康时挂出"记忆服务未连接"——因为没有谁去连过。
    没测过就别下结论。"""
    detail: str = ""
    file_count: int = 0
    retrievable_count: int = 0
    unconsolidated_count: int = 0
    """``daily/`` 里还没被 ``digest/`` 链到的条数——"哪些还没被整合"（设计文档三期）。"""


class MemoryOverviewOut(BaseModel):
    status: MemoryStatusOut
    files: list[MemoryFileOut] = Field(default_factory=list)
    truncated: bool = False


class MemoryRecallIn(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    limit: int | None = Field(default=None, ge=1, le=MAX_MEMORY_RECALL)


class MemoryHitOut(BaseModel):
    text: str
    path: str = ""
    start_line: int | None = None
    end_line: int | None = None
    score: float | None = None


class MemoryLinkOut(BaseModel):
    path: str
    direction: Literal["out", "in"]
    name: str = ""


class MemoryRecallOut(BaseModel):
    query: str
    hits: list[MemoryHitOut] = Field(default_factory=list)
    links: list[MemoryLinkOut] = Field(default_factory=list)
    note: str = ""
    """一句话提醒这是记忆而不是知识库原文（与 MCP 那份同口径）。"""


class MemoryRememberIn(BaseModel):
    content: str = Field(min_length=1, max_length=MAX_MEMORY_ENTRY_CHARS)
    tags: list[str] = Field(default_factory=list, max_length=20)


class MemoryRememberOut(BaseModel):
    saved: bool
    entries: int = 0
    reason: str = ""


class MemoryGraphNodeOut(BaseModel):
    path: str
    title: str
    kind: Literal["core", "daily", "digest", "other"]
    degree: int = 0


class MemoryGraphOut(BaseModel):
    nodes: list[MemoryGraphNodeOut] = Field(default_factory=list)
    edges: list[tuple[str, str]] = Field(default_factory=list)
    dangling: list[tuple[str, str]] = Field(default_factory=list)
    """写了但没解析到文件的链接 ``(来自哪份, 原始目标)``——界面提示"有 N 条链接指空"。"""


class MemoryProbeOut(BaseModel):
    reachable: bool
    detail: str = ""


class MemoryActionOut(BaseModel):
    """无返回值的动作（重建索引）统一用它回一句人话。"""

    detail: str = ""


# ------------------------------------------------------------------ 定时任务（v0.33）


class ScheduledTaskCreateIn(BaseModel):
    """新建一条定时任务。见《Agent-工作区与能力层设计》§6.6。"""

    name: str = Field(min_length=1, max_length=80)
    """叫什么（同时会成为它那条会话的标题）。"""
    prompt: str = Field(min_length=1, max_length=4000)
    """**到点要问它的那句话**——它就是每次运行的用户消息，写具体一点：
    "把昨天的构建日志汇总成三条结论"比"看看日志"得到的东西有用得多。"""
    kind: Literal["cron", "once"] = "cron"
    cron: str = Field(default="", max_length=120)
    """5 字段表达式（分 时 日 月 周），按**服务器时区**解释。例：``0 9 * * *``。"""
    run_at: datetime | None = None
    """一次性任务的时刻。**不带时区的按服务器本地时间解释**
    （界面上的 datetime-local 就是这个形状）。"""
    kb_ids: list[str] = Field(default_factory=list)
    """到点检索哪些库。留空 = 不查资料（只靠模型自己的知识与工具）。"""
    model_pk: str | None = None
    thinking: bool | None = None
    thinking_effort: str | None = None


class ScheduledTaskUpdateIn(BaseModel):
    """改一条。**只改传进来的字段**（``None`` = 不动）。"""

    name: str | None = Field(default=None, min_length=1, max_length=80)
    prompt: str | None = Field(default=None, min_length=1, max_length=4000)
    kind: Literal["cron", "once"] | None = None
    cron: str | None = Field(default=None, max_length=120)
    run_at: datetime | None = None
    kb_ids: list[str] | None = None
    enabled: bool | None = None
    model_pk: str | None = None


class ScheduledTaskOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    name: str
    prompt: str
    kind: Literal["cron", "once"]
    cron: str = ""
    run_at: datetime | None = None
    next_run_at: datetime | None = None
    enabled: bool = True
    kb_ids: list[str] = Field(default_factory=list)
    model_pk: str | None = None
    thinking: bool | None = None
    thinking_effort: str | None = None
    conversation_id: str | None = None
    """结果落在哪条会话里（首次运行后才会有）。界面据此给"看跑过的结果"一个落点。"""
    last_run_at: datetime | None = None
    last_status: str = ""
    """``ok`` / ``degraded`` / ``failed`` / 空串（还没跑过）。
    ``degraded`` = 跑完了但没跑完（撞上步数或时间闸，可以在那条会话里点「继续」）。"""
    last_error: str = ""
    run_count: int = 0
    schedule_text: str = ""
    """给人看的一句话（"每天 09:00" / "2026-09-21 09:00 跑一次"）。由服务端生成——
    界面自己把 cron 翻成人话，就得再维护一份解析。"""
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ScheduledTaskListOut(BaseModel):
    items: list[ScheduledTaskOut] = Field(default_factory=list)
    timezone: str = ""
    """当前服务器时区（如 ``CST UTC+08:00``）。cron 按它解释，
    所以界面必须显示出来——否则"每天 9 点"是哪个 9 点就成了猜。"""


class ScheduledTaskRunOut(BaseModel):
    """「立即跑一次」的结果：任务已经入队。"""

    task_id: str
    detail: str = ""
