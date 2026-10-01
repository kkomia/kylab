r"""SQLite 连接管理（M2 本机档）。

``postgres_impl/connection.py`` 的开头写着"与 ``sqlite_impl/connection.py`` 的对应关系"
——那份说明反过来就是这份的依据。两边的 ``read()`` / ``session()`` **语义一致**，
所以 ``meta_store`` 的方法体可以在两边近乎逐行对照；差异只有下面几条，逐条给理由：

- **连接是"每线程一条、长期持有"**，不是连接池。SQLite 是嵌在进程里的库文件，
  连它没有握手成本，池化只增加一层状态；而 ``sqlite3.Connection`` 默认
  ``check_same_thread=True``（**保留**），于是"一条连接只被创建它的那个线程用"
  由驱动自己守着——Starlette 把同步端点丢进 40 个线程池，正好一人一条。
- **写事务显式 ``BEGIN IMMEDIATE``**：SQLite 的默认 BEGIN 是 deferred（先拿读锁、
  写的时候升级），两个写者在 WAL 下同时升级会撞出 ``SQLITE_BUSY`` 并且**不可重试**
  （升级失败必须整条重来）。``BEGIN IMMEDIATE`` 一开始就拿库级写锁，
  配 ``busy_timeout`` 变成"排队等"，而不是"撞上就失败"。
- **进程内一把 ``threading.RLock``**：写串行化、读并发。WAL 允许 1 写 N 读，
  所以只锁 ``session()``；``read()`` 不拿锁。**跨进程**（CLI 导入 + 边车同时写）
  靠 WAL + ``busy_timeout`` 自己协调，不在这里拦。
- **``synchronous=NORMAL`` 的取舍**：WAL 下它是"提交不落 fsync、只在检查点时落"，
  断电可能丢掉最后几个**已提交**的事务（不是库损坏）。会话落本机要的正是这个
  ——一轮对话 1ms 落盘（v0.3 §6.1-④）不能等磁盘；丢了的那几个事务由**幂等重跑**
  兜（导入台账见 ``imports`` / ``import_items``），不靠 fsync。
- **``foreign_keys=ON`` 必须显式开**：SQLite 的外键默认是关的，而本机 schema 里
  ``ON DELETE CASCADE`` / ``SET NULL`` 是真实语义（删文件夹笔记回未归档、
  删工作区会话退回未归档）。不开的话这些声明只是注释。
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from pathlib import Path

#: ``STRICT`` 表的下限版本（SQLite 3.37，2021-11）；也是本项目本机库的最低要求。
#: 比它低**明确报错**，不降级成非 STRICT 表——那会让"列类型写错了也照收"这类
#: 静默错误重新回到库里（见 ``schema.sql`` 的类型纪律）。
MIN_SQLITE_VERSION = (3, 37)

#: 写者等锁的上限（毫秒）。导入进程与边车同时写是**必然场景**（§1.5），
#: 所以"等一会儿"比"立刻失败"对；等满 5 秒仍拿不到就如实报错，不重试风暴。
BUSY_TIMEOUT_MS = 5000

#: 检查点阈值（页）。默认值就是 1000，写出来是为了它出现在一处可读的口径清单里。
WAL_AUTOCHECKPOINT = 1000

#: ``-wal`` 文件的可见后缀：备份/清理时要连同它一起考虑。
WAL_SUFFIXES = ("-wal", "-shm")


class SqliteVersionError(RuntimeError):
    """本机 SQLite 版本低于 ``MIN_SQLITE_VERSION``（``STRICT`` 表不可用）。"""


class Database:
    """本机库的句柄：一个文件 + 每线程一条连接 + 一把写锁。

    生命周期是显式的：``open()`` 在建/校验 schema 之前跑一次（版本自检 + 库级
    PRAGMA + 双实例探测），``close()`` 在关停时把**本线程**的连接关掉并做一次
    检查点。别把 ``Database`` 当连接池用——它不归还连接，因为它只有一条（每线程）。
    """

    def __init__(self, path: str | Path, *, allow_multiple_instances: bool = False) -> None:
        self._path = Path(path)
        #: 每线程一条连接。用 ``threading.local`` 而不是字典：线程退出时那条连接
        #: 的引用随 TLS 一起消失，由 ``sqlite3`` 的析构关掉，不需要额外的登记表
        #: （登记表反而要在跨线程 ``close()`` 时踩 ``check_same_thread`` 的坑）。
        self._local = threading.local()
        #: 进程内写锁：``session()`` 拿，``read()`` 不拿（WAL 允许 1 写 N 读）。
        self._write_lock = threading.RLock()
        #: 本线程当前是否在 ``session()`` 里（见 ``session()`` 的嵌套守卫）。
        self._depth = threading.local()
        self._opened = False
        #: 探测到"已有进程开着同一个库"时记下的那句话（不拦截，只如实记）。
        self.instances_note: str | None = None
        self._allow_multiple = allow_multiple_instances

    # ------------------------------------------------------------------ 属性

    @property
    def path(self) -> Path:
        """库文件路径（``<data_dir>/kylab.db``）。"""
        return self._path

    @property
    def opened(self) -> bool:
        return self._opened

    # ------------------------------------------------------------------ 生命周期

    def open(self) -> None:
        """建目录、建库、定 PRAGMA 口径、做版本自检与双实例探测。

        幂等（``ensure_schema`` 会被反复调用），但**必须真的开过一次**：
        ``journal_mode=WAL`` 是**库的持久属性**，只在这里设——之后每条新连接
        继承它，不需要再设一次（重复设也是无害的 no-op，但那是第二处口径）。
        """
        self._check_version()
        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = self._connect()
        mode = conn.execute("PRAGMA journal_mode = WAL").fetchone()[0]
        if str(mode).lower() != "wal":
            # 只读文件系统 / 网络盘（WAL 需要共享内存）会让这一句静默不生效，
            # 而那意味着"并发写靠单写者"这条假设不成立，必须当场说清楚。
            raise RuntimeError(
                f"无法把 {self._path} 切到 WAL 模式（当前 {mode}）。"
                "会话落本机要求库在支持共享内存的本地文件系统上（网络盘/只读盘不支持 WAL）。"
            )
        if not self._allow_multiple:
            self.instances_note = self._probe_other_instances()
        self._opened = True

    def close(self) -> None:
        """关掉**本线程**的连接并把 WAL 收进主库（``wal_checkpoint(TRUNCATE)``）。

        **不关别的线程的连接**：``check_same_thread=True`` 之下跨线程 ``close()``
        会直接被驱动拒掉。那些连接在各自的线程退出时由 ``sqlite3`` 释放——
        进程退出时会发生，连接池里的线程在关停后也会。这里做一次检查点，
        保证"关掉应用之后 ``kylab.db`` 是完整的、``-wal`` 是空的"（可整份备份）。
        """
        self._drop_thread_connection()
        if self._path.exists():
            conn = self._connect()
            try:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            finally:
                conn.close()
        self._opened = False

    def _drop_thread_connection(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            self._local.conn = None
            conn.close()

    # ------------------------------------------------------------------ 连接

    def _connect(self) -> sqlite3.Connection:
        """新建一条连接并设好**每连接**的 PRAGMA。

        ``isolation_level=None``（自动提交）是必需的：默认的"隐式 BEGIN"会让
        ``PRAGMA`` 落在一个未提交的事务里而**静默失效**（实测：先 INSERT 再
        ``PRAGMA foreign_keys=ON``，外键根本没开）。事务一律由 ``session()`` 显式开。
        """
        self._check_version()
        conn = sqlite3.connect(self._path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute(f"PRAGMA wal_autocheckpoint = {WAL_AUTOCHECKPOINT}")
        return conn

    def connection(self) -> sqlite3.Connection:
        """本线程的连接（没有就建一条）。**内部用**：外部请走 read/session。"""
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._connect()
            self._local.conn = conn
        return conn

    # ------------------------------------------------------------------ 事务

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        """只读场景：**不拿写锁、不开事务**（每条 SELECT 自己就是一个读事务）。

        与 PG 版的 ``read()`` 同名同形。不拿锁是刻意的：WAL 下读与写互不阻塞，
        而拿锁会把"列表页读会话"变成与"另一轮对话在写"互相排队。
        """
        yield self.connection()

    @contextmanager
    def session(self) -> Iterator[sqlite3.Connection]:
        """写事务：拿写锁 + ``BEGIN IMMEDIATE``，异常回滚、正常提交。

        **不可嵌套**：嵌套时内层的 ``BEGIN IMMEDIATE`` 会报
        "cannot start a transaction within a transaction"，而那个异常会让内层的
        ``ROLLBACK`` 把**外层**的事务一起掀掉（半截状态）。所以这里显式拦下来，
        给一句能读懂的话。仓储方法都是"一个方法一个事务"，不该出现嵌套。
        """
        if getattr(self._depth, "value", 0):
            raise RuntimeError("Database.session() 不可嵌套：一个方法只该开一个写事务")
        with self._write_lock:
            conn = self.connection()
            conn.execute("BEGIN IMMEDIATE")
            self._depth.value = 1
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            else:
                conn.execute("COMMIT")
            finally:
                self._depth.value = 0

    def script(self, sql: str) -> None:
        """整段多语句 SQL（基线 DDL）：拿写锁，**包在一个事务里**执行。

        为什么不能直接用 ``conn.execute()``：它一次只收一条语句。又为什么不能用
        ``executescript`` 直跑：它会在开始时**隐式提交**（若有未决事务）、并且
        不像 ``session()`` 那样替你回滚——半截 schema 就是这么来的。所以这里把
        ``BEGIN IMMEDIATE`` / ``COMMIT`` 写进脚本体内，失败时自己 ``ROLLBACK``。
        """
        with self._write_lock:
            conn = self.connection()
            try:
                conn.executescript(f"BEGIN IMMEDIATE;\n{sql}\nCOMMIT;")
            except BaseException:
                # 事务可能压根没开起来（BEGIN 自己就失败了），那时 ROLLBACK 也是报错
                with suppress(sqlite3.Error):
                    conn.execute("ROLLBACK")
                raise

    # ------------------------------------------------------------------ 维护

    @contextmanager
    def maintenance(self) -> Iterator[sqlite3.Connection]:
        """独占一条**不在事务里**的临时连接（``VACUUM`` 这类操作要求）。

        ``read()`` 借出的是本线程那条长连接，而 ``VACUUM`` 不能在事务里跑；
        写锁保证没有别的写者，连接用完即关——**不缓存**它：这类操作罕见，
        而一条"为 VACUUM 而生"的常驻连接只会让进程里挂着的连接数更难讲清。
        """
        with self._write_lock:
            conn = self._connect()
            try:
                yield conn
            finally:
                conn.close()

    # ------------------------------------------------------------------ 自检

    @staticmethod
    def _check_version() -> None:
        """版本自检：``STRICT`` 表要 3.37+。不满足就报错，不降级。

        降级的代价是把"类型纪律"整条丢掉（见 ``schema.sql`` 第 1 条规范），
        而类型写错在 SQLite 里不报错——它会安静地存进去，等到某天读出来
        才发现是 `'1'` 不是 `1`。宁可起不来。
        """
        if sqlite3.sqlite_version_info < MIN_SQLITE_VERSION:
            need = ".".join(str(part) for part in MIN_SQLITE_VERSION)
            raise SqliteVersionError(
                f"本机 SQLite 版本 {sqlite3.sqlite_version} 低于 {need}（STRICT 表的下限）。"
                "请升级 Python（内置 sqlite3）或换用自带新 SQLite 的解释器；"
                "**不降级成非 STRICT 表**——那会丢掉列类型纪律。"
            )

    def _probe_other_instances(self) -> str | None:
        """探测有没有别的进程正开着同一个库；有就返回一句可记日志的话。

        **只报不拦**：跨进程同时写（CLI 导入 + 边车跑着）是必然场景，WAL 本来就支持；
        真该拦的是"两个边车实例开同一个库"，那个由端口互斥挡掉大部分（8765-8769）。
        所以这里做的是"启动时看一眼并如实记日志"——出问题时日志里有一行线索，
        而不是一个事后只能靠猜的 ``SQLITE_BUSY``。
        """
        try:
            probe = sqlite3.connect(self._path, isolation_level=None)
        except sqlite3.Error as exc:  # pragma: no cover - 打不开时上层会另行报错
            return f"无法探测并发实例：{exc}"
        try:
            holder = probe.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
        except sqlite3.Error as exc:  # pragma: no cover - 见上
            return f"无法探测并发实例：{exc}"
        finally:
            probe.close()
        # wal_checkpoint 返回 (busy, log, checkpointed)：第一项非 0 说明有别的
        # 连接正持有读/写，也就是"别的进程也在用这个库"。
        if holder and int(holder[0]):
            return f"{self._path} 上已有其他连接在用（WAL 检查点被占用），请确认只有一个边车实例"
        return None
