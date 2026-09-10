"""存储装配（组合根，M1 收尾）。

**这里（以及测试）是唯一允许 import `sqlite_impl` 的地方。**
`services/` 只依赖 `storage/base.py` 的接口，具体实现由本模块在启动时装配注入——
这样未来平级新增 PostgreSQL 实现时，改动收敛在这一处，
`scripts/check_layering.py` 的 `L2` 规则会守住这条边界。
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from app.core.config import Settings, get_settings
from app.storage.base import FullTextStore, MetaStore, ObjectStore, VectorStore
from app.storage.sqlite_impl.connection import Database
from app.storage.sqlite_impl.fulltext_store import SqliteFullTextStore
from app.storage.sqlite_impl.meta_store import SqliteMetaStore
from app.storage.sqlite_impl.migrations import apply_migrations
from app.storage.sqlite_impl.object_store import LocalObjectStore
from app.storage.sqlite_impl.vector_store import SqliteVectorStore

__all__ = ["STORAGE_SUBDIRS", "Stores", "build_stores", "get_stores", "reset_stores"]

ORIGINALS_DIR = "originals"
MARKDOWN_DIR = "markdown"
IMAGES_DIR = "images"
STORAGE_SUBDIRS = (ORIGINALS_DIR, MARKDOWN_DIR, IMAGES_DIR)


@dataclass(frozen=True, slots=True)
class Stores:
    """四个仓储的装配结果。类型标注一律是接口，不是实现。"""

    meta: MetaStore
    vectors: VectorStore
    fulltext: FullTextStore
    objects: ObjectStore
    database: Database


def build_stores(settings: Settings | None = None) -> Stores:
    """按配置建库、迁移、准备目录，并装配四个仓储。

    幂等：迁移只应用缺失的版本，目录已存在则跳过，可安全地在每次启动时调用。
    """
    resolved = settings or get_settings()
    data_dir = Path(resolved.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)

    database = Database(resolved.db_path)
    connection = database.connect()
    try:
        apply_migrations(connection)
    finally:
        connection.close()

    object_store = LocalObjectStore(data_dir)
    for subdir in STORAGE_SUBDIRS:
        (data_dir / subdir).mkdir(parents=True, exist_ok=True)

    return Stores(
        meta=SqliteMetaStore(database),
        vectors=SqliteVectorStore(database),
        fulltext=SqliteFullTextStore(database, slow_query_ms=resolved.slow_query_ms),
        objects=object_store,
        database=database,
    )


@lru_cache
def get_stores() -> Stores:
    """进程级单例，供依赖注入使用（与 ``get_settings`` 同构）。"""
    return build_stores()


def reset_stores() -> None:
    """清掉单例缓存。测试与配置热更新时使用。"""
    get_stores.cache_clear()
