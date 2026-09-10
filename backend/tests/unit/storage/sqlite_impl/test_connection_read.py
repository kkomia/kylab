"""``Database.read()`` 的回归测试：连接必须真的被关闭。

背景：``with sqlite3.connect(...) as conn:`` 是**事务**上下文管理器，退出时不关连接。
2026-09-10 代码审查发现读路径全部用了它，17 处连接泄漏（Windows 上会锁住 .db 文件）。
"""

import sqlite3

import pytest

from app.storage.sqlite_impl.connection import Database


def test_read_closes_connection(tmp_path) -> None:
    db = Database(tmp_path / "kylab.db")
    with db.read() as conn:
        conn.execute("CREATE TABLE t (a INTEGER)")

    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        conn.execute("SELECT 1 FROM t")


def test_read_sees_committed_writes(tmp_path) -> None:
    db = Database(tmp_path / "kylab.db")
    with db.session() as conn:
        conn.execute("CREATE TABLE t (a INTEGER)")
        conn.execute("INSERT INTO t VALUES (1)")

    with db.read() as conn:
        assert conn.execute("SELECT a FROM t").fetchone()[0] == 1


def test_read_does_not_leak_file_handles(tmp_path) -> None:
    """反复读之后仍能删库：Windows 下句柄没释放会让删除失败。"""
    path = tmp_path / "kylab.db"
    db = Database(path)
    with db.session() as conn:
        conn.execute("CREATE TABLE t (a INTEGER)")

    for _ in range(50):
        with db.read() as conn:
            conn.execute("SELECT COUNT(*) FROM t")

    path.unlink()
    assert not path.exists()
