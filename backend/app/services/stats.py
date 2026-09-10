"""统计聚合（仪表盘的数据源）。

设计口径：

- **只统计真实存在的数据**：文档、切块、任务三类都有时间戳，能出日/月趋势；
  检索次数目前没有落库（只在日志里），所以仪表盘上不放"调用量"——宁可少一张图，
  也不放一个编出来的数字；
- **切块按所属文档的创建时间归日**：`chunks` 表没有自己的时间戳，
  但"某天入库的文档带来多少块"才是用户关心的口径，这个近似是准的；
- **聚合在 Python 里做，不用 SQL**：先说清楚实情——`MetaStore` 目前只有
  "取全量文档/任务"这类仓储方法，没有按日聚合的接口，所以这里是把
  `list_documents()` / `list_tasks()` 的结果用 `Counter` 分组。
  局域网知识库的量级（几千份文档）下这不构成性能问题。
  真到了需要下推的时候，正确做法是在 `storage/` 加一个按日聚合的仓储方法
  （分层纪律：services 不许写 SQL），而不是在这里拼查询。
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from app.storage.base import KnowledgeBaseRecord, StoreBundle

__all__ = ["ActivityPoint", "DashboardStats", "KbStatRow", "StatsService"]

#: 活跃度的默认观察窗口（天）：约四个月的日历热力图
DEFAULT_WINDOW_DAYS = 120


@dataclass(frozen=True, slots=True)
class ActivityPoint:
    """一天的活跃度。三个计数分开给，前端可以切换看哪个维度。"""

    day: date
    documents: int
    chunks: int
    tasks: int


@dataclass(frozen=True, slots=True)
class KbStatRow:
    """单个知识库的规模。"""

    id: str
    name: str
    embedding_model_id: str
    embedding_dim: int
    documents: int
    chunks: int
    last_activity: datetime | None


@dataclass(slots=True)
class DashboardStats:
    """仪表盘要的全部数字。"""

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
    """观察窗口内新增的文档数。"""
    activity: list[ActivityPoint] = field(default_factory=list)
    by_stage: dict[str, int] = field(default_factory=dict)
    by_suffix: dict[str, int] = field(default_factory=dict)
    by_source_kind: dict[str, int] = field(default_factory=dict)
    knowledge_bases: list[KbStatRow] = field(default_factory=list)


class StatsService:
    """把散在几张表里的数字聚合成仪表盘要的形状。"""

    def __init__(self, stores: StoreBundle) -> None:
        self._stores = stores

    def dashboard(self, *, window_days: int = DEFAULT_WINDOW_DAYS) -> DashboardStats:
        meta = self._stores.meta
        today = date.today()
        since = today - timedelta(days=window_days - 1)

        knowledge_bases = meta.list_knowledge_bases()
        documents = [doc for kb in knowledge_bases for doc in meta.list_documents(kb.id)]
        tasks = meta.list_tasks()

        chunk_counts = meta.count_chunks_by_documents([doc.id for doc in documents])
        total_chunks = sum(chunk_counts.values())

        activity = _build_activity(documents, chunk_counts, tasks, since=since, today=today)

        return DashboardStats(
            generated_at=datetime.now(),
            window_days=window_days,
            total_knowledge_bases=len(knowledge_bases),
            total_documents=len(documents),
            total_chunks=total_chunks,
            indexed_documents=sum(1 for d in documents if d.stage.value in ("indexed", "enriched")),
            failed_documents=sum(1 for d in documents if d.stage.value == "failed"),
            running_tasks=sum(1 for t in tasks if t.state.value in ("pending", "running")),
            failed_tasks=sum(1 for t in tasks if t.state.value == "failed"),
            storage_bytes=sum(doc.size_bytes for doc in documents),
            recent_documents=sum(
                1 for doc in documents if doc.created_at and doc.created_at.date() >= since
            ),
            activity=activity,
            by_stage=_count_by(documents, lambda d: d.stage.value),
            by_suffix=_count_by(documents, lambda d: _suffix_of(d.name)),
            by_source_kind=_count_by(documents, lambda d: d.source_kind.value),
            knowledge_bases=[
                _kb_row(kb, documents, chunk_counts) for kb in knowledge_bases
            ],
        )


def _kb_row(
    kb: KnowledgeBaseRecord,
    documents: list,
    chunk_counts: dict[str, int],
) -> KbStatRow:
    mine = [doc for doc in documents if doc.knowledge_base_id == kb.id]
    stamps = [doc.updated_at for doc in mine if doc.updated_at]
    return KbStatRow(
        id=kb.id,
        name=kb.name,
        embedding_model_id=kb.embedding_model_id,
        embedding_dim=kb.embedding_dim,
        documents=len(mine),
        chunks=sum(chunk_counts.get(doc.id, 0) for doc in mine),
        last_activity=max(stamps) if stamps else None,
    )


def _build_activity(
    documents: list,
    chunk_counts: dict[str, int],
    tasks: list,
    *,
    since: date,
    today: date,
) -> list[ActivityPoint]:
    """按天聚合，**补齐没有数据的日子**。

    缺口不能省：日历热力图靠"连续的格子"表达节奏，缺天会让图形错位。
    """
    documents_by_day: Counter[date] = Counter()
    chunks_by_day: Counter[date] = Counter()
    for doc in documents:
        if doc.created_at is None:
            continue
        day = doc.created_at.date()
        if day < since:
            continue
        documents_by_day[day] += 1
        chunks_by_day[day] += chunk_counts.get(doc.id, 0)

    tasks_by_day: Counter[date] = Counter()
    for task in tasks:
        stamp = task.updated_at or task.created_at
        if stamp is None:
            continue
        day = stamp.date()
        if day < since:
            continue
        tasks_by_day[day] += 1

    points: list[ActivityPoint] = []
    cursor = since
    while cursor <= today:
        points.append(
            ActivityPoint(
                day=cursor,
                documents=documents_by_day.get(cursor, 0),
                chunks=chunks_by_day.get(cursor, 0),
                tasks=tasks_by_day.get(cursor, 0),
            )
        )
        cursor += timedelta(days=1)
    return points


def _count_by(rows: list, key) -> dict[str, int]:  # type: ignore[no-untyped-def]
    counter: Counter[str] = Counter(key(row) for row in rows)
    return dict(counter.most_common())


def _suffix_of(name: str) -> str:
    lowered = name.lower()
    dot = lowered.rfind(".")
    return lowered[dot:] if dot > 0 else "无后缀"
