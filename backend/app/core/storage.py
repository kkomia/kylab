"""存储装配（组合根）。

**这里是唯一允许 import 具体实现的地方**（测试夹具另算）。
`services/` 只依赖 `storage/base.py` 的接口，实现由本模块在启动时装配注入——
`scripts/check_layering.py` 的 `L2` 规则会守住这条边界。

这个进程只有本机一种形态，所以装配只剩一条路：

- **元数据**：``<data_dir>/kylab.db``（SQLite，``sqlite_impl/``）。本机域（会话 / 消息 /
  事件 / 产物 / 笔记 / 设置 / 工作区 / 定时任务 / MCP / 模型注册 / 用量）走它；
  知识库那半的元数据读仍转给 ``split_impl/remote_meta.py`` 的 ``RemoteMetaStore``——
  **这一处是留给第②批（存储层）的接缝**：知识库整体退场之后，那个 KB 域分流
  （以及 ``StoreBundle.kb_cache``）会一起拆掉；本批只保证装配能跑。
- **向量 / 全文 / 表格**：三个"不可用"实现（``split_impl``）——本机不持有那三份数据，
  调用它们会如实抛 ``KnowledgeBaseUnavailable``，而不是回一个"查过了，没有"的空结果。
- **对象存储**：数据目录下的 ``originals/`` / ``markdown/`` / ``images/``
  （``local_impl/``）。本机的"文件区"就该在用户自己的盘上，跟着库一起备份。

**启动即校验**：SQLite 版本不够（``STRICT`` 表要 ≥3.37）、schema 版本比应用新、
库里有别人在写，都在这里说清楚（见 ``sqlite_impl/schema.py``）。失败发生在启动时，
而不是第一个请求。
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from app.core.config import Settings, get_settings
from app.storage.base import StoreBundle
from app.storage.sqlite_impl.connection import Database as SqliteDatabase

__all__ = [
    "LOCAL_DB_NAME",
    "STORAGE_SUBDIRS",
    "build_stores",
    "close_stores",
    "get_stores",
    "reset_stores",
]

ORIGINALS_DIR = "originals"
MARKDOWN_DIR = "markdown"
IMAGES_DIR = "images"
STORAGE_SUBDIRS = (ORIGINALS_DIR, MARKDOWN_DIR, IMAGES_DIR)
"""本地对象存储的目录规约。"""

LOCAL_DB_NAME = "kylab.db"
"""本机库文件名（``<data_dir>/kylab.db``）。"""

_OPEN_LOCAL_DATABASES: list[SqliteDatabase] = []
"""已打开的本机 SQLite 句柄。进程级资源，关停时由 ``close_stores`` 统一释放。"""


def _build_local_stores(settings: Settings, data_dir: Path) -> StoreBundle:
    """SQLite 元数据 + 三个"不可用" + 本地目录对象存储。

    **同一个 ``SqliteMetaStore`` 实例七处用**：``meta`` 走它做本机域读写，``ledger``
    走它做导入台账与"一条会话整体写入"，``kb_cache`` 走它做知识库元数据快照，
    ``snapshot`` 走它做快照打包与读回，``backup_queue`` 走它做待传队列，``eraser``
    走它做安全擦除。七个实例指向同一个库文件也能跑，但那会造出七条连接集合与七个
    对象——而"写锁是进程内一把"这条纪律是对着 ``Database`` 说的，不是对着仓储对象
    说的。同一个实例没有这个问题。

    元数据那一格是 ``RouterMetaStore``：**本机域的库元数据走 SQLite，KB 域的读转给
    ``RemoteMetaStore``**（打知识库提供者的窄 API）。它**构造时不带 reader**：存储
    先于服务层装配，而 reader 要的是"能随设置改地址"的运行期能力（只有服务层有）
    ——所以由 ``core/services.py`` 在装配期后挂一次（那个类自己的说明写了完整理由）。
    没挂上之前调用它，抛的是"知识库提供者还没接上（组合根未装配）"那句，
    不是 AttributeError。
    """
    from app.storage.local_impl.object_store import LocalObjectStore
    from app.storage.split_impl import (
        RemoteMetaStore,
        RouterMetaStore,
        UnavailableFullTextStore,
        UnavailableTabularStore,
        UnavailableVectorStore,
    )
    from app.storage.sqlite_impl.meta_store import SqliteMetaStore
    from app.storage.sqlite_impl.schema import prepare as prepare_sqlite_schema

    db_path = Path(settings.local_db) if settings.local_db else data_dir / LOCAL_DB_NAME
    database = SqliteDatabase(db_path)
    try:
        prepare_sqlite_schema(database)
    except BaseException:
        database.close()
        raise
    _OPEN_LOCAL_DATABASES.append(database)

    for subdir in STORAGE_SUBDIRS:
        (data_dir / subdir).mkdir(parents=True, exist_ok=True)

    local_store = SqliteMetaStore(database)

    return StoreBundle(
        meta=RouterMetaStore(local=local_store, kb=RemoteMetaStore()),
        vectors=UnavailableVectorStore(),
        fulltext=UnavailableFullTextStore(),
        objects=LocalObjectStore(data_dir),
        tabular=UnavailableTabularStore(),
        # 导入台账：本机独有（那两张表就在这个库里）
        ledger=local_store,
        # 知识库元数据快照：缓存层服务 KB 域的读路径，但数据主人是本机，写者只有本机一个
        kb_cache=local_store,
        # 快照打包与读回：本机库里的明文凭据要靠它擦掉
        snapshot=local_store,
        # 待传队列：断网入队、联网补传的那张表
        backup_queue=local_store,
        # 安全擦除：擦的是**本机那个库文件**（主库 + -wal + -shm）。
        # 谁用它：`services/credentials.py` 清完明文之后的收尾那一下。
        eraser=local_store,
    )


def build_stores(settings: Settings | None = None) -> StoreBundle:
    """建库、迁移、准备目录，并装配仓储。**幂等**：可安全地在每次启动时调用。

    返回 :class:`StoreBundle`（字段类型全为接口）。具体的连接句柄刻意不外泄——
    一旦交出去，调用方就会顺手拿它写 SQL，Repository 抽象就白做了。
    """
    resolved = settings or get_settings()
    data_dir = Path(resolved.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    return _build_local_stores(resolved, data_dir)


@lru_cache
def get_stores() -> StoreBundle:
    """进程级单例，供依赖注入使用（与 ``get_settings`` 同构）。"""
    return build_stores()


def close_stores() -> None:
    """释放进程级存储资源（本机 SQLite 句柄）。关停时调用。

    SQLite 那边关库时还会做一次 WAL 检查点，少关一次就多留一份 ``-wal`` 尾巴。
    """
    for database in _OPEN_LOCAL_DATABASES:
        database.close()
    _OPEN_LOCAL_DATABASES.clear()


def reset_stores() -> None:
    """清掉单例缓存。测试与配置热更新时使用。"""
    close_stores()
    get_stores.cache_clear()
