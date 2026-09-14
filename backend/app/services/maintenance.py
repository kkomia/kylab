"""存储维护：空间概览与"整理"（v17）。

**为什么要有这个服务**：数据库删数据不会把文件变小——删掉的行变成死元组留在页里
等复用（SQLite 时代是 freelist，PG 是 dead tuples，症状一样）。
这些数字如果不摆出来，用户只会看到"我删了东西，磁盘却没变"，然后怀疑系统在偷偷存。

**"整理"只做两件安全的事**：丢掉无主的向量分区（早期版本删库时漏掉的），
然后 VACUUM。两件都不动任何有主的数据。

（v0.12 起底层是 PostgreSQL：空间口径来自 ``pg_database_size`` /
``pg_stat_user_tables``，整理走 ``VACUUM (ANALYZE)``，见 ``postgres_impl/meta_store``。）
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from app.storage.base import StoreBundle

__all__ = ["MaintenanceService", "StorageOverview"]

logger = logging.getLogger(__name__)

@dataclass(slots=True)
class StorageOverview:
    """存储概览。字节数都是原始值，格式化交给界面。"""

    file_bytes: int
    data_bytes: int
    """有效数据 ≈ 文件大小 − 空闲页。展示成"其中数据 / 其中可回收"。"""

    free_bytes: int
    partitions: int
    """向量分区数量。**每个分区首个向量就占一个 4MB 块**，所以它与库数一起看。"""
    orphans: list[str] = field(default_factory=list)
    """无主的向量分区（知识库已删、表还在）。"""


class MaintenanceService:
    """存储维护。管理员专属能力，所以不做任何"自动定时"——只响应用户的显式动作。"""

    def __init__(self, stores: StoreBundle) -> None:
        self._stores = stores

    def overview(self) -> StorageOverview:
        stats = self._stores.meta.storage_stats()
        known = {record.id for record in self._stores.meta.list_knowledge_bases()}
        partitions = self._stores.vectors.list_partitions()
        # 孤儿分区是"库里没有这个知识库、但向量表还在"
        orphans = [kb_id for kb_id in partitions if kb_id not in known]
        return StorageOverview(
            file_bytes=int(stats["file_bytes"]),
            data_bytes=max(0, int(stats["file_bytes"]) - int(stats["free_bytes"])),
            free_bytes=int(stats["free_bytes"]),
            partitions=len(partitions),
            orphans=orphans,
        )

    def compact(self) -> StorageOverview:
        """丢掉无主分区并 VACUUM，返回整理**之后**的概览。

        **VACUUM 会重写整个库文件**，几 GB 的库要几十秒并需要等量临时空间。
        所以它只能是用户点出来的动作；这里也不加锁——SQLite 自己会挡住并发写，
        真撞上时错误原样抛出（比"静默排队"好排查）。
        """
        for kb_id in self.overview().orphans:
            logger.info("整理存储：丢弃无主向量分区 %s", kb_id)
            self._stores.vectors.drop_partition(kb_id)
        self._stores.meta.vacuum()
        return self.overview()
