"""检索服务的类型定义（M3 T3.x）。

这些类型同时服务于**检索调试台**：界面要能展示"每一路召回了什么、融合后排第几"，
所以结果里必须带够中间信息，而不只是最终列表（架构 §3.3）。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime

from app.models.enums import DataSourceKind

__all__ = [
    "ChannelStat",
    "MetadataFilter",
    "RetrievalHit",
    "RetrievalMode",
    "RetrievalQuery",
    "RetrievalResponse",
]


class RetrievalMode:
    """检索模式。``VECTOR`` 与 ``FULLTEXT`` 用于把"召回不行"和"融合不行"分开定位。"""

    HYBRID = "hybrid"
    VECTOR = "vector"
    FULLTEXT = "fulltext"

    ALL = (HYBRID, VECTOR, FULLTEXT)


@dataclass(frozen=True, slots=True)
class MetadataFilter:
    """元数据过滤（架构 §5）。"""

    document_ids: Sequence[str] | None = None
    source_kinds: Sequence[DataSourceKind] | None = None
    created_after: datetime | None = None
    created_before: datetime | None = None

    def is_empty(self) -> bool:
        return not any(
            (self.document_ids, self.source_kinds, self.created_after, self.created_before)
        )


@dataclass(frozen=True, slots=True)
class RetrievalQuery:
    """一次检索请求。"""

    query: str
    kb_ids: Sequence[str]
    top_k: int = 8
    mode: str = RetrievalMode.HYBRID
    candidate_k: int = 40
    """每一路的候选数。融合前多召回一些，给 RRF 留出排序空间。"""
    score_threshold: float | None = None
    """**相对**融合分的下限（该条分 / 最高分）：1.0 = 只保留并列第一。"""
    min_vector_score: float | None = None
    """向量余弦的**绝对**下限（v0.53）。``None`` = 按嵌入模型标定默认，``0`` = 关闭。

    必须绝对：``score_threshold`` 是相对最高分的比例，而"整批都不相关"时最高分
    本身就是噪声，比例永远接近 1（实测传 0.9 仍剩 7 条噪声）。``None`` 时按库的
    嵌入模型查 ``service.MIN_VECTOR_SCORE_BY_MODEL``——没标定过的模型 → 0（不设限）。
    """
    min_term_coverage: float | None = None
    """词面覆盖的绝对下限（v0.53）：查询实词里至少多少比例出现在候选正文里。

    ``None`` = 跟着向量下限走（向量下限 > 0 时为 ``DEFAULT_MIN_TERM_COVERAGE`` = 0.67，
    否则 0），``0`` = 关闭。为什么这一半不挂在全文通道的原始分上：见 ``coverage.py``。
    """
    rerank: bool = False
    filters: MetadataFilter | None = None

    def __post_init__(self) -> None:
        if self.mode not in RetrievalMode.ALL:
            raise ValueError(f"未知检索模式：{self.mode}")
        if self.top_k <= 0:
            raise ValueError("top_k 必须为正整数")
        if self.candidate_k < self.top_k:
            raise ValueError("candidate_k 不能小于 top_k")


@dataclass(slots=True)
class RetrievalHit:
    """融合后的命中。``channels`` 与 ``ranks`` 是给调试台看的：这条是怎么被捞上来的。"""

    chunk_id: str
    document_id: str
    knowledge_base_id: str
    text: str
    score: float
    page: int | None = None
    heading_path: str | None = None
    image_ids: Sequence[str] = field(default_factory=tuple)
    document_name: str | None = None
    channels: Sequence[str] = field(default_factory=tuple)
    ranks: dict[str, int] = field(default_factory=dict)
    raw_scores: dict[str, float] = field(default_factory=dict)
    """各路原始分：向量侧是**余弦相似度**（已由距离换算），全文侧是 -bm25。
    调试台要显示"相似度"，靠的就是它——融合分只反映名次，不是相似度。"""
    rerank_score: float | None = None


@dataclass(frozen=True, slots=True)
class ChannelStat:
    """单路召回的统计：命中数与耗时。慢在哪一路，一眼能看出来。"""

    channel: str
    count: int
    elapsed_ms: float


@dataclass(slots=True)
class RetrievalResponse:
    """检索结果 + 调试信息。"""

    hits: list[RetrievalHit]
    mode: str
    reranked: bool
    stats: list[ChannelStat] = field(default_factory=list)
    filtered_out: int = 0
    """被元数据过滤、相对阈值或**相关度下限**挡掉的候选数——避免"结果为空"时无从判断原因。"""
