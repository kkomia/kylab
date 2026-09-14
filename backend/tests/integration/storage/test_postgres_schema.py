"""PG schema 装配的集成测试（需要真实 PostgreSQL，默认跳过）。

**为什么必须从空库开始**：schema 基线里含 ``CREATE EXTENSION IF NOT EXISTS vector``，
所以"空库 → 建 schema → 扩展就位"是一条真实存在的启动路径。而开发服务器上的库
早就装好扩展了，那条路径在真机上**看不出来**——顺序写反（先查扩展再建 schema）
一样能跑通。这条用例专门造一个空库来跑它。

运行方式（指向任意一个带 pgvector 的 PG，必须是超级用户以免 CREATE EXTENSION 被拒）：

    KYLAB_TEST_DATABASE_URL="postgresql://kylab:kylab123@host:54321/postgres" \
      pytest tests/integration/storage/test_postgres_schema.py -q
"""

from __future__ import annotations

import os
import re
import uuid

import psycopg
import pytest
from psycopg import sql

from app.storage.postgres_impl.connection import Database
from app.storage.postgres_impl.schema import (
    BASELINE_VERSION,
    SCHEMA_PATH,
    SchemaError,
    current_version,
    ensure_schema,
    prepare,
)

ADMIN_DSN = os.environ.get("KYLAB_TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not ADMIN_DSN,
    reason="未提供 KYLAB_TEST_DATABASE_URL，跳过需要真实 PostgreSQL 的集成测试",
)


def _declared_tables() -> set[str]:
    """schema.sql 里定义的业务表名。

    **不写死数量**：不同 PG 镜像会往 ``template1`` 里预装扩展（paradedb 就带了
    PostGIS），于是新库会自带一些与本项目无关的表。断言"本项目声明的表都在"，
    既不依赖镜像，也不会因为镜像多带东西而误报。
    """
    text = SCHEMA_PATH.read_text(encoding="utf-8")
    body = "\n".join(line for line in text.splitlines() if not line.strip().startswith("--"))
    return set(re.findall(r"CREATE TABLE\s+(\w+)", body))


def _missing_tables(db: Database) -> set[str]:
    with db.read() as conn:
        rows = conn.execute(
            "select table_name from information_schema.tables "
            "where table_schema = 'public' and table_type = 'BASE TABLE'"
        ).fetchall()
    present = {row["table_name"] for row in rows}
    return _declared_tables() - present


@pytest.fixture
def fresh_db() -> Database:
    """在真实 PG 上造一个**不含任何扩展**的空库，用完删掉。"""
    assert ADMIN_DSN is not None
    name = f"kylab_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(ADMIN_DSN, autocommit=True) as admin:
        admin.execute(sql.SQL("create database {}").format(sql.Identifier(name)))

    dsn = psycopg.conninfo.make_conninfo(ADMIN_DSN, dbname=name)
    db = Database(dsn)
    db.open()
    try:
        yield db
    finally:
        db.close()
        with psycopg.connect(ADMIN_DSN, autocommit=True) as admin:
            admin.execute(
                sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(name))
            )


def test_current_version_is_none_before_schema(fresh_db: Database) -> None:
    """空库还没有 schema_migrations 表——不能因此报错，要能识别成 None。"""
    assert current_version(fresh_db) is None


def test_prepare_bootstraps_a_fresh_database(fresh_db: Database) -> None:
    """空库上 prepare 必须能一次建成：建表 + 装扩展，而不是先抱怨缺扩展。"""
    assert prepare(fresh_db) == BASELINE_VERSION
    assert _missing_tables(fresh_db) == set(), "schema.sql 声明的表应全部建成"

    with fresh_db.read() as conn:
        row = conn.execute(
            "select extname from pg_extension where extname = 'vector'"
        ).fetchone()
    assert row is not None, "prepare 之后 pgvector 应当已启用"


def test_prepare_is_idempotent(fresh_db: Database) -> None:
    """启动会反复调用：第二次不能因为"表已存在"而失败。"""
    first = prepare(fresh_db)
    second = prepare(fresh_db)
    assert first == second == BASELINE_VERSION
    assert _missing_tables(fresh_db) == set()


def test_version_older_than_baseline_is_rejected(fresh_db: Database) -> None:
    """库的 schema 比应用旧 → 拒绝启动（而不是带着缺失的列继续跑）。"""
    prepare(fresh_db)
    with fresh_db.session() as conn:
        conn.execute("delete from schema_migrations")

    with pytest.raises(SchemaError, match="低于应用要求的基线"):
        ensure_schema(fresh_db)


def test_version_newer_than_baseline_is_rejected(fresh_db: Database) -> None:
    """库被更新版应用升过级 → 同样拒绝，避免旧代码往新结构里写。"""
    prepare(fresh_db)
    with fresh_db.session() as conn:
        conn.execute(
            "insert into schema_migrations (version, description) values (%s, %s)",
            (BASELINE_VERSION + 1, "未来版本"),
        )

    with pytest.raises(SchemaError, match="高于本应用已知的"):
        ensure_schema(fresh_db)
