r"""本机 SQLite 存储实现（M2「会话落本机」阶段 1）。

与 ``postgres_impl/`` 的分工：那份是**服务器档**的唯一主实现（知识库 + 向量 + 全文
的家当都在那边），这份是**本机档**的元数据实现——会话、消息、事件、产物、笔记、
设置、工作区、定时任务、MCP、模型注册、用量，全部落在 ``<data_dir>/kylab.db``。
方案见 ``docs/规范/会话落本机-实施方案-v0.1.md`` §1。

- ``connection.py``   连接管理 + PRAGMA 口径 + ``read()/session()``
- ``schema.sql``      基线 v1 DDL（本机 17 张表，逐表出处见文件头）
- ``schema.py``       ``ensure_schema`` / 增量迁移 / 迁移前自动备份
- ``meta_store.py``   ``SqliteMetaStore``（只实现本机域）
- ``validate.py``     运维自检入口：``python -m app.storage.sqlite_impl.validate``

**只实现本机域，不实现 ``MetaStore`` 全量 ABC**：本机档里知识库那半没有数据源
（NAS 才是），所以 ``SqliteMetaStore`` 不继承 ``MetaStore``，也不该被当成一个完整的
``MetaStore`` 用。分档路由（``RouterMetaStore``：本机域走它、KB 域转给 KB 侧实现）
是阶段 2 的事，本模块只负责"本机这些表怎么读写"。

**五种存储只住这一个目录**：``scripts/check_layering.py`` 的 L2 规则禁止
``services/`` import ``sqlite3``（与 ``psycopg`` 同级），SQLite 代码只许住在
``app/storage/sqlite_impl/``，业务层只许见 ``app.storage.base`` 的接口。
"""

from __future__ import annotations

from app.storage.repositories import (
    ConversationRepo,
    MCPServerRepo,
    ModelRegistryRepo,
    NoteRepo,
    ScheduleRepo,
    SettingsRepo,
    UsageRepo,
    WorkspaceRepo,
)

__all__ = [
    "LOCAL_EXTRA",
    "LOCAL_METHODS",
    "LOCAL_PROTOCOLS",
    "local_methods",
]


#: 归本机的**协议**（实施方案 §2.1）：这 8 个域的数据都在本机库里，
#: 它们的每个方法都由 ``SqliteMetaStore`` 实现。
LOCAL_PROTOCOLS: tuple[type, ...] = (
    ConversationRepo,
    NoteRepo,
    SettingsRepo,
    WorkspaceRepo,
    ScheduleRepo,
    MCPServerRepo,
    ModelRegistryRepo,
    UsageRepo,
)

#: ``MaintenanceRepo`` 不属于任何一个业务域，所以要逐方法点名：
#: 存储空间概览与 VACUUM 是本机库自己的事（本机库就是那个"文件"），
#: 而 ``purge_stage_events`` 清的是**文档阶段事件**——那是知识库流水线的表，归 KB 域。
LOCAL_EXTRA: frozenset[str] = frozenset({"storage_stats", "vacuum"})


def _protocol_methods(protocol: type) -> frozenset[str]:
    """协议类体里的公开方法名。

    **不许手抄**（实施方案 §2.1）：两百来个方法手抄必漏，而漏掉的那个方法
    会在运行期以 ``AttributeError`` 的形式出现在某条边角路径上。所以从
    ``repositories.py`` 已经切好的协议里机械取名字——那边有
    ``tests/unit/storage/test_repositories.py`` 守着"每个方法恰好属于一个协议、
    一个不漏、签名与 ABC 逐字一致"，于是这份导出天然跟着接口走。
    """
    return frozenset(
        name
        for name, value in vars(protocol).items()
        if not name.startswith("_") and callable(value)
    )


def local_methods() -> frozenset[str]:
    """本机域方法集：8 个协议的公开方法 ∪ ``LOCAL_EXTRA``。

    做成函数而不是模块级常量，是为了让调用方每次拿到的是**当前**协议的样子
    （阶段 2 的 ``RouterMetaStore`` 要用它算"剩下的归 KB 域"）。
    """
    return frozenset().union(*(_protocol_methods(item) for item in LOCAL_PROTOCOLS)) | LOCAL_EXTRA


#: 本机域方法集（``SqliteMetaStore`` 实现的方法必须**恰好**是它）。
#:
#: 放在这里而不是阶段 2 的 ``split_impl/router.py``：它是"哪些域本机"这个决定的
#: 唯一落点，阶段 2 的路由器与本模块的用例都从这里取，避免出现第二份会漂的清单。
LOCAL_METHODS: frozenset[str] = local_methods()
