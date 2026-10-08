"""API 请求/响应模型（协议层）。

**不在此处做业务判断**，只做形状定义（工程规范 §3.3）。这里的长相就是对外契约：
``scripts/gen_api_types.py`` 从 OpenAPI 生成前端的类型，所以字段名与说明都跟着它走。

知识库那一族（库 / 文档 / 切块 / 检索 / 任务 / 表格）的模型**不在这里**：那些端点
随知识库产品剥离一起删了，本仓库只剩本机那些（会话 / 笔记 / 记忆 / 工作区 /
定时任务 / MCP / 技能 / 插件 / 沙箱 / 设置 / 模型注册 / 备份 / 知识库客户端面）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.services.memory import MAX_ENTRY_CHARS as MAX_MEMORY_ENTRY_CHARS

_RECORD_CONFIG = ConfigDict(from_attributes=True, use_attribute_docstrings=True)
"""记录类响应模型直接由服务/存储的记录对象构建。

调用方写 ``ConversationOut.model_validate(record)``，字段名对不上会在改字段时立刻报错，
比手写一遍 ``_to_out`` 映射少一处"加了字段忘了同步"的漏点。
这也是协议层不 import ``app.storage`` 还能拼出响应的原因（工程规范 §3.3 L1）。

``use_attribute_docstrings=True``（v0.2）：把**字段下面那段文档字符串**放进 OpenAPI 的
description。不加它，前端的派生类型只能拿到字段名——而 `schema.d.ts` 是生成的，
手写的字段说明会在迁移时丢掉。加上它，说明跟着契约走：后端写一处，
生成的类型、Swagger、前端的 IDE 提示都有。
"""

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


# --------------------------------------------------------------------- 对话














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


class ConversationBranchIn(BaseModel):
    """**从这里重开**（D11）：从第 ``turn`` 轮分叉出一条新会话。

    ``turn`` 是**第几个提问**（1 起数）。越界（0 / 超过总轮数）不夹到边界、
    也不"取最后一条"，而是报错——静默夹过去会让用户以为分叉点就是他点的那一处，
    而拿到的是另一段历史。``0`` 与小数由这一层的 ``ge=1`` 挡住（422）。
    """

    turn: int = Field(ge=1)


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


class ChatAttachmentOut(BaseModel):
    """用户消息随发的附件快照（v0.55，见 :class:`ChatAttachmentIn`）。

    ``key`` 是文件区里的 key：界面拿它去预览 / 下载（与文件抽屉同一套端点），
    所以就算那份文件后来被删了，这条消息仍然说得清"当时带的是它"。
    """

    key: str
    name: str
    kind: str = ""
    size_bytes: int = 0


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

    attachments: list[ChatAttachmentOut] = Field(default_factory=list)
    """用户消息随发的附件（v0.55）。**只有用户消息会有**；老消息返回空列表。"""

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
    preview: str = ""
    """这一项**实际文本的开头一段**（D09，2026-09-28 走查）。

    这一排原先只有数字：能看出"系统提示词占多少 token"，但"本轮到底给它灌了什么"
    没有入口（同一页里工具结果与出处早就有"加载全部 / 看全文"）。
    截断长度是服务端定的（``services/chat.CONTEXT_PART_PREVIEW_CHARS``，600 字），
    前端只负责显示，别自己再截一遍。"""


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
    compress_budget: int = 0
    """**实际**触发压缩的 token 数：``compress_at`` 与绝对上限（``chat.compress_max_tokens``）
    取小的那个（D37）。界面说"到多少会自动压"要用**这个**——窗口调大之后
    ``total × compress_at`` 会是个永远到不了的数（实测 1M 窗口报 70 万，那条会话才 1.2 万）。"""
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
    """一层目录（v0.26；两档都能进子目录，见 ``mode``）。"""

    mode: str
    """``workspace``（项目目录）/ ``object``（会话文件区）。
    **它不是"平铺 / 分层"那一档**——从 D20 起会话文件区也按名字里的相对路径分层。"""
    label: str
    """给人看的那句话：「工作区「我的项目」」/「本会话」。"""
    path: str = ""
    parent: str | None = None
    entries: list[FileEntryOut] = Field(default_factory=list)
    truncated: bool = False
    """条目被截断过。界面要如实说"只显示了前 N 项"——
    否则"这个项目只有 300 个文件"与"我只给你看了 300 个"看起来一模一样。"""


class ConversationFileImportIn(BaseModel):
    """把**项目目录**里的一份文件取进这条会话的文件区（D20）。

    只给一个相对路径（项目档那一行给的 key）：落点、名字都归服务端算——
    界面不该也不能决定"复制到哪儿"。路径只走工作区那道闸（绝对路径 / ``..`` /
    符号链接出界都拒），与读文件、预览同一条。
    """

    path: str = Field(min_length=1, max_length=1024)


class IngestArtifactIn(BaseModel):
    """把一份产物存进知识库。**库必须由调用方点明**——服务端不替他挑。"""

    knowledge_base_id: str = Field(min_length=1, max_length=64)




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












# --------------------------------------------------------------------- 笔记（v20）


class NoteCreateIn(BaseModel):
    title: str = Field(default="", max_length=80)
    content_md: str = ""
    source_kind: Literal["manual", "chat", "clip"] = "manual"
    source_ref: str | None = None
    tags: list[str] = Field(default_factory=list)
    folder_id: str | None = None
    """建在哪一层（左栏选中文件夹时点「+」）；留空 = 未归档。"""


class NoteUpdateIn(BaseModel):
    """全部字段可空：只传要改的字段。``None`` = 不动这一项。

    **刻意没有 ``folder_id``**：归属走 ``PATCH /notes/{id}/folder``。
    编辑器每 800ms 自动保存一次，如果归属也走这条路径，草稿里那份旧的 folder_id
    会把用户在左栏刚移好的位置刷回去（理由详见服务层 ``NotesService.move_note``）。
    """

    title: str | None = Field(default=None, max_length=80)
    content_md: str | None = None
    pinned: bool | None = None
    tags: list[str] | None = None


class NoteMoveIn(BaseModel):
    """把笔记移动到某个文件夹；``folder_id=None`` = 移回未归档。"""

    folder_id: str | None = None


class NoteFolderCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    parent_id: str | None = None
    """父文件夹；留空 = 建在根级。"""


class NoteFolderRenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class NoteFolderParentIn(BaseModel):
    """把文件夹移动到某个文件夹下；``parent_id=None`` = 挪回根级。"""

    parent_id: str | None = None


class NoteFolderOut(BaseModel):
    model_config = _RECORD_CONFIG

    id: str
    name: str
    parent_id: str | None = None
    note_count: int = 0
    """这个文件夹里**直接**有多少篇笔记（不含子文件夹里的）。"""
    created_at: datetime | None = None
    updated_at: datetime | None = None


class NoteFolderListOut(BaseModel):
    """左栏那棵树的读数：文件夹 + 三个数字（未归档 / 总数）一次给全。

    **为什么不只给树**：树上每个节点都要显示条数，未归档与"全部"也各要一个，
    而它们每次移动笔记都会一起变；拆成"列表 + 额外两次计数请求"只会让
    三个数字有机会对不上（用户看到的是一棵树，数字就该是同一时刻的）。
    """

    items: list[NoteFolderOut] = Field(default_factory=list)
    unfiled_count: int = 0
    total_count: int = 0


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
    folder_id: str | None = None
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


# ------------------------------------------------------------------ 沙箱（v0.16）


class SandboxCapabilityOut(BaseModel):
    """这台机器上的内核级隔离能力。

    ``direct`` 是**降级档**（v0.55）：没有真隔离且没开严格模式时，就是"直接在本机执行、
    未隔离"。它不是沙箱，`detail` 里会如实说明。
    """

    backend: Literal["bwrap", "sandbox-exec", "docker", "direct", "none"]
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
    archived: bool | None = None
    """归档 / 取消归档（v0.55）。**不是删除**：里面的会话与内容都还在。
    与会话那条同一口径（`ConversationUpdateIn.archived`）。"""


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
    archived_at: datetime | None = None
    """归档时间（v0.55）。``None`` = 未归档。"""
    device_id: str | None = None
    """归属设备（v0.59）。``None`` = **服务器端**：这个项目的 ``root_path`` 在服务器的
    盘上（网页版/直连 API 建的）。非空 = 桌面壳那台机器（``X-Kylab-Device``）。"""
    device_name: str = ""
    """设备名（``X-Kylab-Device-Name``，可空）。只给人看，判定按 ``device_id``。"""


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

    **除了数据目录树都是真**（v0.58）：文件系统根、区域外的任意目录、用户自己挑的
    自定义路径都能建。这里标的是"这一条规则允不允许"，**不是"写性探测的结果"**——
    能不能真的写进去由那次真实的 ``mkdir`` 回答，界面照旧会拿到一句具体的失败原因。
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
    """专用可写区域（``<data_dir>/workspaces``）：选择器的默认落脚点，也是**改名**的
    唯一范围（v0.58 起新建不限区域，除了数据目录树）。

    界面用它认出"现在站的这一层就是区域"（给一句"在这里可以新建 / 改名"的提示）。
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
    enabled: bool = True
    """**用户**没把它关掉（D23）。

    与 ``used_by_prompt`` 分开：那个是"实际进没进"（安全扫描、依赖、丢弃都会让它 false），
    这个是"用户的开关在哪一边"。两者都可能为 false 而原因不同——能力页上那颗开关
    只能照着 ``enabled`` 画，理由那一栏照旧读 ``flagged``。
    """
    flagged: list[str] = Field(default_factory=list)
    """没进目录的原因（人话）。空 = 没问题。"""
    category: str = ""
    """**分类**（v0.61）：`skill_categories` 里登记过的 slug（`slides` / `code` / `other`…）。

    技能自己**没有**这个字段（SKILL.md 的格式里没有分类，第三方的 `tags:` 也不认），
    它是按一套可复现的加权信号算出来的（`services/skill_categories.py`），
    与页面读的那张离线映射同源。空串 = 没经过分类（只有手工构造的记录会这样）。

    它**不进提示词目录**：目录里那一行是给模型判断"何时该用"的，分类是给人分组看的。
    """
    featured: bool = False
    """是不是**本类精选**（v0.61：每类前 2 条，判据见 `services/skills.featured_by_category`）。

    **只在列表端点里有意义**：详情端点是"看这一条"，不参与"每类排前 2"的评选，
    那里恒为 `false`。精选**不进提示词目录**——它只回答"界面默认该摆哪几条"。
    """
    discarded: bool = False
    """**被丢弃**（P0-3）：frontmatter 缺 ``name``/``description`` 或描述超长，
    照 ZCode 的规则整个技能不加载。它仍然出现在列表里（带着 ``flagged`` 那条理由），
    但既不进提示词，也读不出正文——能力页要能看见"装了但没通过校验"的那些。"""


class SkillEnabledIn(BaseModel):
    """开/关一条技能（D23）。"""

    model_config = _RECORD_CONFIG

    enabled: bool
    """``False`` = 关掉：不进提示词，模型也不知道有它（文件不动）。"""


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


class SkillCategoryOut(BaseModel):
    """一个分类（v0.61）：页面按它分组，`featured` 是默认要摆出来的那几条。"""

    slug: str
    """稳定标识（`slides` / `documents` / `code`…），技能的 `category` 就是它的取值。"""
    label: str
    """给人看的中文名（`演示与幻灯片`…）。"""
    total: int = 0
    """**全库**落在这一类的条数（与 `usable` 同一口径：不是这一页的，也不只算可用的）。"""
    featured: list[str] = Field(default_factory=list)
    """这一类默认展示的技能名（每类最多 2 条，某类不够就有几条给几条）。

    只从**能用**的里挑（被安全扫描拦下 / 依赖没满足 / 被关掉 / 被丢弃的不参选），
    排序判据是机械可复现的（内置 → 装进来的 → 描述完整度 → 名字可读性）。"""


class SkillListOut(BaseModel):
    items: list[SkillOut] = Field(default_factory=list)
    usable: int = 0
    """其中真正会进模型目录的条数——界面上一眼看出"装了 N 个，能用 M 个"。"""
    categories: list[SkillCategoryOut] = Field(default_factory=list)
    """分类清单（v0.61）：**顺序就是界面分组的顺序**（`skill_categories.CATEGORIES`）。

    它回答的是"界面默认摆什么"：每类给一个中文名、一个全库条数、两条精选
    （见 `SkillCategoryOut`）。**新增字段，老客户端不读它照旧**——
    技能的 `category` / `featured` 两位也一样，都是只增不改。"""


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
    """怎么用（形如 ``/mode [goal|plan]``）。"""
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
    """记忆工作区里的一个文件（不含正文）。"""

    path: str
    name: str
    title: str
    kind: Literal["core", "daily", "digest", "other"]
    summary: str = ""
    tags: list[str] = Field(default_factory=list)
    size_bytes: int = 0
    modified_at: str = ""


class MemoryFileDetailOut(MemoryFileOut):
    content: str = ""
    """原文，**含 frontmatter**：只读展示要逐字还原，不能因为我们"顺手格式化"
    而丢掉用户手写的东西。"""

    meta: dict[str, Any] = Field(default_factory=dict)
    truncated: bool = False


class MemoryStatusOut(BaseModel):
    """记忆层的状态。**全是本地数字**：

    没有"连没连上"这一项——记忆跑在我们自己的进程里，没有第二个进程可连。
    ``development`` 报的是"向量是开发兜底"（没配嵌入模型，退回无语义的词面哈希）：
    界面据此说清"检索质量不代表真实效果"，而不是让它看起来和真嵌入一样。
    """

    enabled: bool
    workspace: str = ""
    detail: str = ""
    items: int = 0
    """记忆库里一共几条（最多数到 200 条，见服务层的 ``MAX_ITEMS``）。"""

    last_changed_at: str = ""
    """记忆内容最后一次改动的时间（界面上写的"上次更新"）。"""

    embedder: str = ""
    """这一轮用的向量化模型 id（``dev/deterministic-hash`` = 兜底）。"""

    development: bool = False
    """``true`` = 向量是开发兜底，检索只反映词面重合。"""


class MemoryOverviewOut(BaseModel):
    """``GET /memory`` 的响应：只有状态。"""

    status: MemoryStatusOut


class MemoryItemOut(BaseModel):
    """库里的一条记忆（D9 的条目列表用它）。"""

    id: str
    text: str
    section: str = ""
    """分区标签：``身份与称呼`` / ``长期偏好与风格`` / ``进行中的项目`` / ``工具与环境``。
    自动捕获的条目入库时还不知道归哪一区，读取时按内容补一个**显示用**的标签。"""

    source: str = ""
    """它是怎么进来的：``显式`` / ``界面`` / ``迁移``（``隐式`` 是自动捕获留下的旧值——
    那条链 2026-10-09 已删，但库里可能还有按它写下的老行，界面上照旧显示）。"""

    created_at: str = ""
    updated_at: str = ""
    score: float | None = None
    """检索给的相似度；列全部（``get_all``）那条路没有它。

    **只在本条查询内可比**，界面上不要当"相关度百分比"读。"""


class MemoryItemsOut(BaseModel):
    """``GET /memory/items`` 的响应。"""

    query: str = ""
    items: list[MemoryItemOut] = Field(default_factory=list)
    total: int = 0
    note: str = ""
    """一句话提醒这是记忆而不是知识库原文（与 MCP 那份同口径）。"""


class MemoryItemCreateIn(BaseModel):
    """``POST /memory/items``：写一条新的（新增或按机械判据顶替）。

    ``section`` 留空或不认识时服务层按内容机械归区；``replaces`` 是"更正一次完成"
    的入口（填要改掉的那条原文）。``content`` 的 ``max_length`` 是协议层的护栏，
    **与真正的单条上限是同一个数**（500）——超过它的内容属于笔记或知识库。
    """

    content: str = Field(min_length=1, max_length=MAX_MEMORY_ENTRY_CHARS)
    section: str = Field(default="", max_length=40)
    replaces: str = Field(default="", max_length=MAX_MEMORY_ENTRY_CHARS)


class MemoryItemPatchIn(BaseModel):
    """``PATCH /memory/items/{id}``：改一条（按 id）。

    两个字段都给了才算改；``content`` 留空 = 只改分区标签。
    """

    content: str = Field(default="", max_length=MAX_MEMORY_ENTRY_CHARS)
    section: str = Field(default="", max_length=40)


class MemoryWriteOut(BaseModel):
    """一次写入的结果与回执。

    ``action`` 四种：``added`` / ``replaced`` / ``existing`` / ``rejected``
    （删除那条路还会给 ``forgotten``）。``receipt`` 是**给人看的那一句话**，
    界面与模型共用同一个来源——谁也不该自己另编一句。
    """

    action: str
    receipt: str = ""
    text: str = ""
    """留在库里的那一条原文（``rejected`` 时是这次想写进去的那条）。"""

    section: str = ""
    replaced: str = ""
    """被改掉 / 删掉的旧值。"""

    item_id: str = ""
    """这条的 id（被拒时是空串）。"""


class MemoryHistoryOut(BaseModel):
    """一条记忆历史上的一步（mem0 自己的 ``history.db``）。"""

    at: str = ""
    event: str = ""
    """mem0 的动作名：``ADD`` / ``UPDATE`` / ``DELETE``。"""

    old: str = ""
    new: str = ""
    deleted: bool = False


class MemoryItemHistoryOut(BaseModel):
    """``GET /memory/items/{id}/history`` 的响应，**最旧在前**。"""

    id: str = ""
    items: list[MemoryHistoryOut] = Field(default_factory=list)


class MemoryImportOut(BaseModel):
    """``POST /memory/import-legacy`` 的报告。"""

    source: str = ""
    entries: int = 0
    """旧档案里读到几条候选。"""

    imported: int = 0
    existing: int = 0
    dropped_sensitive: int = 0
    skipped: bool = False
    """没有新东西可搬（源指纹与水位一致）——此时净改动为零。"""

    changed: bool = False


# ------------------------------------------------- 知识库提供者（M3 握手）


_PROVIDER_CONFIG = ConfigDict(
    from_attributes=True, use_attribute_docstrings=True, populate_by_name=True
)
"""握手这一族模型的公共配置。

- ``use_attribute_docstrings``：字段下面那段说明进 OpenAPI（与 ``_RECORD_CONFIG``
  同理）——客户端认的就是这份契约，说明得跟着它走；
- ``populate_by_name``：``ProviderIngestCapsOut`` 有一个字段的**对外名字是 Python
  关键字**（``async``），属性只能叫 ``async_``；允许按属性名构造，按别名序列化。
"""




















# ------------------------------------------------- 备份提供者（M5 阶段 1 握手）
#
# 与上面那族同一份写法、同一个 `_PROVIDER_CONFIG`：两个提供者的握手结构是平行的
# （provider / protocol_version / capabilities / caller / server_time），差别只在
# 能力集的内容与"带回来的那一批东西"（库清单 ↔ 设备与额度）。
# **协议版本各是一个整数**：备份那边不认识知识库的 1，反过来也一样。
