"""SQLite 连接管理（M1 T1.2）。

三件必须做对的事：

- ``journal_mode=WAL``：读写不互斥，后台摄入不阻塞前台检索；
- ``foreign_keys=ON``：SQLite 默认**关闭**外键，级联删除与参照完整性全靠它；
- ``busy_timeout``：并发写入时排队等待，而不是立刻抛 ``database is locked``。
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import sqlite_vec

DEFAULT_BUSY_TIMEOUT_MS = 5_000
IN_MEMORY = ":memory:"


def _load_extensions(conn: sqlite3.Connection) -> None:
    """加载 sqlite-vec。

    向量检索是核心能力，扩展加载失败就该立刻暴露，而不是等到检索时才报
    "no such module: vec0"。加载完立即关掉扩展加载开关，缩小攻击面。
    """
    conn.enable_load_extension(True)
    try:
        sqlite_vec.load(conn)
    finally:
        conn.enable_load_extension(False)


class Database:
    """数据库句柄：统一负责连接创建与 PRAGMA 设定。

    每次 :meth:`connect` 都返回新连接（SQLite 连接不可跨线程共享），
    由调用方或 :meth:`session` 负责关闭。
    """

    def __init__(
        self, path: str | Path, *, busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS
    ) -> None:
        self._path = str(path)
        self._busy_timeout_ms = busy_timeout_ms
        # 以 file: 开头的连接串必须显式开启 uri 模式，否则 SQLite 会把整串当文件名，
        # 于是 "file::memory:?cache=shared" 这种写法会去创建一个怪名字的文件而不是内存库。
        self._is_uri = self._path.startswith("file:")
        if not self._is_memory() and not self._is_uri:
            Path(self._path).parent.mkdir(parents=True, exist_ok=True)

    def _is_memory(self) -> bool:
        return self._path == IN_MEMORY or (self._is_uri and ":memory:" in self._path)

    @property
    def path(self) -> str:
        return self._path

    @property
    def is_memory(self) -> bool:
        return self._is_memory()

    def connect(self) -> sqlite3.Connection:
        """新建连接并设定 PRAGMA。"""
        conn = sqlite3.connect(self._path, isolation_level=None, uri=self._is_uri)
        conn.row_factory = sqlite3.Row
        _load_extensions(conn)
        # PRAGMA 不接受绑定参数，只能拼字符串；这里先 int() 强制转型，杜绝注入面。
        conn.execute(f"PRAGMA busy_timeout = {int(self._busy_timeout_ms)}")
        conn.execute("PRAGMA foreign_keys = ON")
        if not self._is_memory():
            # 内存库不支持 WAL，设了也只会静默退回 memory 日志模式
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = NORMAL")
        return conn

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        """只读场景的连接上下文：**用完必定关闭**。

        注意别用 ``with self.connect() as conn:`` —— 那是 sqlite3 的**事务**上下文管理器，
        退出时只提交/回滚，**不关闭连接**，读路径会持续泄漏文件句柄
        （Windows 上还会锁住 .db 文件，导致删库失败）。
        """
        conn = self.connect()
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def session(self) -> Iterator[sqlite3.Connection]:
        """在显式事务中执行一段操作；异常则回滚。

        ``isolation_level=None`` 关掉了 sqlite3 的隐式事务管理，事务边界由这里显式掌控，
        保证"状态推进 + 任务入队"这类多写操作要么全成要么全不成。
        """
        conn = self.connect()
        try:
            conn.execute("BEGIN")
            yield conn
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        else:
            conn.execute("COMMIT")
        finally:
            conn.close()
