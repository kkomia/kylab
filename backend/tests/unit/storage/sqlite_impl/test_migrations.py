"""``app/storage/sqlite_impl/migrations.py`` 的单元测试。

镜像同构：``app/storage/sqlite_impl/migrations.py``
→ ``tests/unit/storage/sqlite_impl/test_migrations.py``。
"""

import sqlite3

import pytest

from app.storage.sqlite_impl.connection import Database
from app.storage.sqlite_impl.migrations import (
    MIGRATIONS,
    Migration,
    apply_migrations,
    current_version,
)


@pytest.fixture
def conn(tmp_path):
    db = Database(tmp_path / "kylab.db")
    connection = db.connect()
    yield connection
    connection.close()


def test_current_version_is_zero_before_migration(conn: sqlite3.Connection) -> None:
    assert current_version(conn) == 0


def test_apply_migrations_is_idempotent(conn: sqlite3.Connection) -> None:
    """每次启动都可放心调用：第二次不应重复应用。"""
    first = apply_migrations(conn)
    assert first == [migration.version for migration in MIGRATIONS]

    second = apply_migrations(conn)
    assert second == []
    assert current_version(conn) == max(m.version for m in MIGRATIONS)


def test_migration_is_recorded_with_description(conn: sqlite3.Connection) -> None:
    apply_migrations(conn)
    rows = conn.execute("SELECT version, description, applied_at FROM schema_migrations").fetchall()
    assert len(rows) == len(MIGRATIONS)
    assert rows[0]["description"]
    assert rows[0]["applied_at"]


def test_failed_migration_rolls_back_and_can_be_retried(conn: sqlite3.Connection) -> None:
    """失败迁移必须整体回滚，否则会留下半个 schema 且版本号未推进。"""

    class Boom(RuntimeError):
        pass

    broken = (
        Migration(
            version=1,
            description="故意失败",
            statements=(
                "CREATE TABLE half_created (a INTEGER)",
                "THIS IS NOT SQL",
            ),
        ),
    )

    with pytest.raises(sqlite3.OperationalError):
        apply_migrations(conn, broken)

    assert current_version(conn) == 0
    tables = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master")}
    assert "half_created" not in tables

    # 修好之后仍可正常应用。
    # 断言写成"全部迁移的版本号"而不是硬编码 [1]：后者每加一个迁移就会挂，
    # 而它想验的其实是"失败后可重试"，不是"一共有几个迁移"（踩过）。
    assert apply_migrations(conn) == [migration.version for migration in MIGRATIONS]


def test_migrations_are_ordered_and_unique() -> None:
    versions = [migration.version for migration in MIGRATIONS]
    assert versions == sorted(versions)
    assert len(versions) == len(set(versions))
    # 版本号必须从 1 开始连续：apply_migrations 按 version 顺序执行，
    # 跳号意味着有人插了一个中间版本却没标号，老库升级会静默漏掉它
    assert versions == list(range(1, len(versions) + 1))


def test_migration_018_drops_the_retired_max_tokens_setting(conn: sqlite3.Connection) -> None:
    """回复长度上限不再是设置项，老库里那个键要清掉。

    它曾经是 2048，会把回复预算掐死在思考阶段（正文一个字都出不来，且时好时坏）。
    最后决定不替模型决定长度：请求里干脆不带这个字段。键留着就是僵尸配置——
    界面看不到、代码也不认，正是最难查的那类"设了没用"。
    """
    apply_migrations(conn, [m for m in MIGRATIONS if m.version < 18])
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
        ("llm.max_tokens", "2048", "2026-09-01T00:00:00Z"),
    )
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
        ("llm.temperature", "0.3", "2026-09-01T00:00:00Z"),
    )
    conn.commit()

    apply_migrations(conn, [m for m in MIGRATIONS if m.version == 18])

    keys = {row[0] for row in conn.execute("SELECT key FROM app_settings")}
    assert "llm.max_tokens" not in keys
    # 只删它一个：别的采样参数照旧
    assert "llm.temperature" in keys
