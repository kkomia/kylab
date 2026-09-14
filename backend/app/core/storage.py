"""存储装配（组合根）。

**这里（以及测试）是唯一允许 import `sqlite_impl` 的地方。**
`services/` 只依赖 `storage/base.py` 的接口，具体实现由本模块在启动时装配注入——
这样未来平级新增 PostgreSQL 实现时，改动收敛在这一处，
`scripts/check_layering.py` 的 `L2` 规则会守住这条边界。
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from app.core.config import Settings, get_settings
from app.storage.base import ObjectStore, StoreBundle
from app.storage.duckdb_impl.tabular_store import DuckDbTabularStore
from app.storage.s3_impl.object_store import S3ObjectStore, build_client
from app.storage.sqlite_impl.connection import Database
from app.storage.sqlite_impl.fulltext_store import SqliteFullTextStore
from app.storage.sqlite_impl.meta_store import SqliteMetaStore
from app.storage.sqlite_impl.migrations import apply_migrations
from app.storage.sqlite_impl.object_store import LocalObjectStore
from app.storage.sqlite_impl.vector_store import SqliteVectorStore

__all__ = ["STORAGE_SUBDIRS", "build_stores", "get_stores", "reset_stores"]

ORIGINALS_DIR = "originals"
MARKDOWN_DIR = "markdown"
IMAGES_DIR = "images"
STORAGE_SUBDIRS = (ORIGINALS_DIR, MARKDOWN_DIR, IMAGES_DIR)

_S3_REQUIRED = ("s3_endpoint", "s3_access_key", "s3_secret_key")


def _build_object_store(settings: Settings, data_dir: Path) -> ObjectStore:
    """按配置选对象存储：配了 S3 端点就走 S3，否则落到本地目录。

    这是个**可以独立于数据库切换**的组件：文件与元数据本来就是两套东西，
    所以 MinIO 可以先上，不必等 PG 实现。

    配了端点但缺凭据 → 启动即失败。半配状态（有端点没钥匙）如果不能立刻报错，
    就会变成"上传时才发现"。
    """
    if not settings.s3_endpoint:
        store = LocalObjectStore(data_dir)
        for subdir in STORAGE_SUBDIRS:
            (data_dir / subdir).mkdir(parents=True, exist_ok=True)
        return store

    missing = [name for name in _S3_REQUIRED if not getattr(settings, name)]
    if missing:
        raise RuntimeError(
            f"配置了 KYLAB_S3_ENDPOINT 但缺少 {missing}；"
            "要么补齐凭据，要么清空端点以使用本地文件系统"
        )

    client = build_client(
        endpoint=settings.s3_endpoint,
        access_key=settings.s3_access_key or "",
        secret_key=settings.s3_secret_key or "",
        region=settings.s3_region,
        secure=settings.s3_secure,
    )
    # 构造时校验桶可达（head_bucket）：配错了要在启动时炸
    return S3ObjectStore(client, bucket=settings.s3_bucket, prefix=settings.s3_prefix)


def build_stores(settings: Settings | None = None) -> StoreBundle:
    """按配置建库、迁移、准备目录，并装配五个仓储。

    幂等：迁移只应用缺失的版本，目录已存在则跳过，可安全地在每次启动时调用。

    返回 :class:`StoreBundle`（字段类型全为接口）。具体的 ``Database`` 句柄刻意不外泄——
    一旦交出去，调用方就会顺手拿它写 SQL，Repository 抽象就白做了。
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

    object_store = _build_object_store(resolved, data_dir)

    return StoreBundle(
        meta=SqliteMetaStore(database),
        vectors=SqliteVectorStore(database),
        fulltext=SqliteFullTextStore(database, slow_query_ms=resolved.slow_query_ms),
        objects=object_store,
        # 表格副本单独一个 DuckDB 文件：列式库适合按行列定位的查询，
        # 而且与主库物理分离，不会出现"扫一份大表把 API 拖慢"
        tabular=DuckDbTabularStore(data_dir / "tabular.duckdb"),
    )


@lru_cache
def get_stores() -> StoreBundle:
    """进程级单例，供依赖注入使用（与 ``get_settings`` 同构）。"""
    return build_stores()


def reset_stores() -> None:
    """清掉单例缓存。测试与配置热更新时使用。"""
    get_stores.cache_clear()
