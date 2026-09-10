"""领域枚举。

集中放置跨层共享的枚举，避免各层各写一套字符串常量。
pip 线状态序列的权威定义见《架构设计 v0.2》§4，本模块与之逐字对齐，并由
``tests/unit/models/test_enums.py`` 守住。
"""

from enum import StrEnum

__all__ = [
    "PIPELINE_STAGE_ORDER",
    "TERMINAL_STAGES",
    "ApiKeyPermission",
    "DataSourceKind",
    "DocumentStage",
    "TaskKind",
    "TaskState",
    "TrashKind",
]


class DocumentStage(StrEnum):
    """文档摄入流水线状态（《架构设计 v0.2》§4）。

    主链路：``uploaded → probing → parsing → parsed → chunking → chunked → embedding → indexed``。
    ``enriching/enriched`` 是可选增强分支（图谱/Wiki，默认关闭，失败不影响主链路）。
    """

    UPLOADED = "uploaded"
    PROBING = "probing"
    PARSING = "parsing"
    PARSED = "parsed"
    CHUNKING = "chunking"
    CHUNKED = "chunked"
    EMBEDDING = "embedding"
    INDEXED = "indexed"

    # 可选增强分支
    ENRICHING = "enriching"
    ENRICHED = "enriched"

    # 异常态
    FAILED = "failed"


PIPELINE_STAGE_ORDER: tuple[DocumentStage, ...] = (
    DocumentStage.UPLOADED,
    DocumentStage.PROBING,
    DocumentStage.PARSING,
    DocumentStage.PARSED,
    DocumentStage.CHUNKING,
    DocumentStage.CHUNKED,
    DocumentStage.EMBEDDING,
    DocumentStage.INDEXED,
)
"""主链路顺序，供 M2 的状态机校验"只允许向前一步"与"断点续跑定位"。"""

TERMINAL_STAGES: frozenset[DocumentStage] = frozenset({DocumentStage.INDEXED, DocumentStage.FAILED})
"""终态：到达后不再自动推进。"""


class TaskKind(StrEnum):
    """任务类型。每个摄入阶段与数据源动作都是独立任务，便于按阶段重试。"""

    PROBE = "probe"
    PARSE = "parse"
    CHUNK = "chunk"
    EMBED = "embed"
    ENRICH = "enrich"
    DELETE = "delete"
    FETCH_SOURCE = "fetch_source"


class TaskState(StrEnum):
    """任务状态。

    ``RUNNING`` 依赖租约（lease）+ 心跳回收：进程崩溃后超时任务回到 ``PENDING`` 实现断点续跑。
    """

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELED = "canceled"


class DataSourceKind(StrEnum):
    """数据源类型（《架构设计 v0.2》§10）。

    ``WEBDAV`` 为框架预留，MVP 不实现（架构 §14「缓做」）。
    """

    UPLOAD = "upload"
    HTML = "html"
    RSS = "rss"
    WEBDAV = "webdav"


class ApiKeyPermission(StrEnum):
    """API Key 权限（《架构设计 v0.2》§3.2：只读 / 读写 两种）。"""

    READONLY = "readonly"
    READWRITE = "readwrite"


class TrashKind(StrEnum):
    """回收站条目类型（《架构设计 v0.2》§6.2：原文保留 7 天冷备，向量立即删除）。"""

    ORIGINAL = "original"
    IMAGE = "image"
