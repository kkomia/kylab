"""``app/storage/sqlite_impl/connection.py`` 的单元测试。

镜像同构：``app/storage/sqlite_impl/connection.py``
→ ``tests/unit/storage/sqlite_impl/test_connection.py``。
"""

import sqlite3

import pytest

from app.storage.sqlite_impl.connection import Database


def test_foreign_keys_are_enabled(tmp_path) -> None:
    """SQLite 默认关闭外键，必须显式打开，否则级联删除与参照完整性全部失效。"""
    db = Database(tmp_path / "kylab.db")
    with db.session() as conn:
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_wal_mode_on_file_database(tmp_path) -> None:
    """WAL 让后台摄入的写不阻塞前台检索。"""
    db = Database(tmp_path / "kylab.db")
    with db.session() as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"


def test_memory_database_still_works() -> None:
    """内存库不支持 WAL，但连接照常可用（测试里大量使用）。"""
    db = Database(":memory:")
    with db.session() as conn:
        conn.execute("CREATE TABLE t (a INTEGER)")
        conn.execute("INSERT INTO t VALUES (1)")
        assert conn.execute("SELECT a FROM t").fetchone()[0] == 1


def test_parent_directory_is_created(tmp_path) -> None:
    db = Database(tmp_path / "nested" / "deeper" / "kylab.db")
    conn = db.connect()
    conn.close()
    assert (tmp_path / "nested" / "deeper" / "kylab.db").exists()


def test_session_commits_on_success(tmp_path) -> None:
    db = Database(tmp_path / "kylab.db")
    with db.session() as conn:
        conn.execute("CREATE TABLE t (a INTEGER)")
        conn.execute("INSERT INTO t VALUES (7)")

    with db.session() as conn:
        assert conn.execute("SELECT a FROM t").fetchone()[0] == 7


def test_session_rolls_back_on_error(tmp_path) -> None:
    """事务边界显式掌控：多写操作要么全成要么全不成。"""
    db = Database(tmp_path / "kylab.db")
    with db.session() as conn:
        conn.execute("CREATE TABLE t (a INTEGER)")

    class Boom(RuntimeError):
        pass

    with pytest.raises(Boom), db.session() as conn:
        conn.execute("INSERT INTO t VALUES (1)")
        raise Boom

    with db.session() as conn:
        assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 0


def test_row_factory_returns_named_columns(tmp_path) -> None:
    db = Database(tmp_path / "kylab.db")
    with db.session() as conn:
        conn.execute("CREATE TABLE t (alpha INTEGER)")
        conn.execute("INSERT INTO t VALUES (1)")
        row = conn.execute("SELECT alpha FROM t").fetchone()
        assert isinstance(row, sqlite3.Row)
        assert row["alpha"] == 1
