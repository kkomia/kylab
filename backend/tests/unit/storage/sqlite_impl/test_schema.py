"""``sqlite_impl/schema.py`` 的单元测试：STRICT、索引、迁移与迁移前自动备份。

镜像同构：``app/storage/sqlite_impl/schema.py``
→ ``tests/unit/storage/sqlite_impl/test_schema.py``。

这一组用例对应实施方案 §6.4 的第二条：「STRICT 生效（插入错类型必须报错）、
索引存在、迁移+自动备份、版本高于应用报错」。四条都在这一个文件里，
因为它们答的是同一个问题——**库自己有没有守住它声称的那套纪律**。
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.storage.sqlite_impl import schema as schema_module
from app.storage.sqlite_impl.connection import Database
from app.storage.sqlite_impl.schema import (
    BASELINE_VERSION,
    KEY_CREATED_AT,
    KEY_LAST_BACKUP,
    KEY_MIGRATION_LOG,
    MIGRATIONS,
    SCHEMA_VERSION,
    Migration,
    SchemaError,
    current_version,
    ensure_schema,
    prepare,
)

pytestmark = pytest.mark.local

#: 本机库里应该有哪 17 张表（§1.3 逐行列出的那份清单）。
#: **注意**：实施方案的标题写"18 张"，但那份清单逐行数是 17 张；这里按**清单**守，
#: 于是"哪天真的少了一张或多了一张"会立刻红，而不是被一个错误的数字掩盖。
EXPECTED_TABLES = frozenset(
    {
        "schema_metadata",
        "app_settings",
        "workspaces",
        "conversations",
        "chat_messages",
        "session_events",
        "conversation_artifacts",
        "note_folders",
        "notes",
        "note_tags",
        "scheduled_tasks",
        "mcp_servers",
        "model_providers",
        "model_registry",
        "usage_events",
        "imports",
        "import_items",
    }
)

#: 规范 3 点名的覆盖索引（§1.4-3），逐条**按原文**列出来。
EXPECTED_INDEXES = frozenset(
    {
        "idx_conversations_recent",
        "idx_conversations_workspace",
        "idx_conversations_archived",
        "idx_chat_messages_conversation",
        "idx_conversation_artifacts_conv",
        "idx_note_folders_owner",
        "idx_notes_owner",
        "idx_scheduled_tasks_due",
    }
)


#: 逐表的毫秒时间列（§1.2 的机械翻译结果）。多一个少一个都说明映射错了。
EXPECTED_MS_COLUMNS: dict[str, frozenset[str]] = {
    "app_settings": frozenset({"updated_at_ms"}),
    "workspaces": frozenset({"created_at_ms", "updated_at_ms", "archived_at_ms"}),
    "conversations": frozenset({"created_at_ms", "updated_at_ms", "archived_at_ms"}),
    "chat_messages": frozenset({"created_at_ms"}),
    "session_events": frozenset({"created_at_ms"}),
    "conversation_artifacts": frozenset({"created_at_ms"}),
    "note_folders": frozenset({"created_at_ms", "updated_at_ms"}),
    "notes": frozenset({"created_at_ms", "updated_at_ms"}),
    "scheduled_tasks": frozenset(
        {
            "run_at_ms",
            "next_run_at_ms",
            "last_run_at_ms",
            "created_at_ms",
            "updated_at_ms",
        }
    ),
    "mcp_servers": frozenset({"created_at_ms", "updated_at_ms"}),
    "model_providers": frozenset({"created_at_ms", "updated_at_ms"}),
    "model_registry": frozenset({"created_at_ms", "updated_at_ms"}),
    "usage_events": frozenset({"created_at_ms", "duration_ms"}),
    "imports": frozenset({"since_ms", "created_at_ms", "updated_at_ms"}),
    "import_items": frozenset({"source_updated_at_ms", "local_updated_at_ms", "created_at_ms"}),
    # schema_metadata 只有 key/value：版本是文本，建库时间在它的行值里（不是列）
    "schema_metadata": frozenset(),
}


@pytest.fixture
def database(tmp_path: Path) -> Iterator[Database]:
    db = Database(tmp_path / "kylab.db")
    prepare(db)
    yield db
    db.close()


def _objects(conn: sqlite3.Connection, kind: str) -> dict[str, str]:
    rows = conn.execute(
        "SELECT name, sql FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'", (kind,)
    ).fetchall()
    return {row["name"]: row["sql"] or "" for row in rows}


# ------------------------------------------------------------------ 基线


def test_fresh_file_has_no_version_then_baseline_lands(tmp_path: Path) -> None:
    """三种版本状态要分清（``current_version`` 的 None / 0 / n）。"""
    db = Database(tmp_path / "kylab.db")
    db.open()
    assert current_version(db) is None
    assert ensure_schema(db) == BASELINE_VERSION
    assert current_version(db) == BASELINE_VERSION
    assert SCHEMA_VERSION == BASELINE_VERSION  # 现阶段还没有增量迁移
    assert MIGRATIONS == ()
    db.close()


def test_baseline_version_literal_matches_the_constant() -> None:
    """版本号在 ``schema.sql`` 里是**字面量**（与 DDL 同一事务），必须与应用常量相等。"""
    from app.storage.sqlite_impl.schema import SCHEMA_PATH

    ddl = SCHEMA_PATH.read_text(encoding="utf-8")
    assert f"VALUES ('version', '{BASELINE_VERSION}')" in ddl


def test_baseline_creates_exactly_the_local_tables(database: Database) -> None:
    with database.read() as conn:
        tables = set(_objects(conn, "table"))
    assert tables == EXPECTED_TABLES
    assert len(tables) == 17


def test_every_table_is_strict(database: Database) -> None:
    """规范 1：全部量 STRICT。少了 STRICT，列类型就只是注释。"""
    with database.read() as conn:
        sqls = _objects(conn, "table")
    not_strict = sorted(name for name, sql in sqls.items() if "STRICT" not in sql.upper())
    assert not_strict == [], f"这些表没写 STRICT：{not_strict}"


def test_strict_rejects_a_wrong_type(database: Database) -> None:
    """STRICT 生效的判据：**不可无损转换**的值必须当场报错。

    用 "把 TEXT 塞进 INTEGER 列"：反过来（整数塞进 TEXT 列）是**无损转换**，
    SQLite 会照收——这一点值得记住，别拿它当反例。
    """
    with pytest.raises(
        sqlite3.IntegrityError, match="cannot store TEXT value"
    ), database.session() as conn:
        conn.execute(
            "INSERT INTO conversations"
            " (id, title, kb_ids, pinned, context_summary, created_at_ms, updated_at_ms)"
            " VALUES ('c1', '标题', '[]', 'not-a-bool', '', 1, 1)"
        )


def test_json_columns_are_checked(database: Database) -> None:
    """规范 1 的后半：JSON 列补 ``CHECK (json_valid(...))``。"""
    with pytest.raises(sqlite3.IntegrityError, match="json_valid"), database.session() as conn:
        conn.execute(
            "INSERT INTO conversations"
            " (id, title, kb_ids, pinned, context_summary, created_at_ms, updated_at_ms)"
            " VALUES ('c1', '标题', '不是 JSON', 0, '', 1, 1)"
        )


def test_timestamp_columns_use_ms_and_no_bare_at(database: Database) -> None:
    """类型映射的机械翻译（§1.2）：``timestamptz`` → ``INTEGER`` + ``_ms`` 后缀。

    两条判据：① 没有任何列是 PG 那种裸 ``_at`` 名（漏改一处就会有一个）；
    ② 逐表列出**应该**有的毫秒列，多一个少一个都红。
    """
    with database.read() as conn:
        actual = {
            table: {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
            for table in _objects(conn, "table")
        }
    bare = sorted(
        f"{table}.{column}"
        for table, columns in actual.items()
        for column in columns
        if column.endswith("_at") and not column.endswith("_ms")
    )
    assert bare == [], f"这些时间列是 PG 的裸名，漏了 _ms：{bare}"
    for table, expected in EXPECTED_MS_COLUMNS.items():
        found = {column for column in actual[table] if column.endswith("_ms")}
        assert found == set(expected), f"{table} 的毫秒列对不上：{found} != {set(expected)}"


def test_required_indexes_exist(database: Database) -> None:
    """规范 3：列表查询的覆盖索引一条都不能少。"""
    with database.read() as conn:
        indexes = set(_objects(conn, "index"))
        # 部分索引（`WHERE enabled`）在 sqlite_master 里的 DDL 带着条件，逐条核一眼
        scheduled = _objects(conn, "index")["idx_scheduled_tasks_due"]
    assert indexes >= EXPECTED_INDEXES
    assert "WHERE enabled" in scheduled

    # 索引确实被查询规划器用上了（建了但用不上 = 白建）
    plan = _explain(
        database, "SELECT * FROM conversations ORDER BY pinned DESC, updated_at_ms DESC"
    )
    assert "idx_conversations_recent" in plan


def test_unique_constraints_the_code_depends_on(database: Database) -> None:
    """几处唯一约束不是装饰：``ConflictError`` 与"同级重名挡住"都指着它们。"""
    with database.session() as conn:
        conn.execute(
            "INSERT INTO model_providers (id, kind, name, created_at_ms, updated_at_ms)"
            " VALUES ('p1', 'llm', '供应商', 1, 1)"
        )
        conn.execute(
            "INSERT INTO model_registry (id, provider_id, model_id, created_at_ms, updated_at_ms)"
            " VALUES ('m1', 'p1', 'deepseek-chat', 1, 1)"
        )
    with pytest.raises(sqlite3.IntegrityError), database.session() as conn:
        conn.execute(
            "INSERT INTO model_registry (id, provider_id, model_id, created_at_ms,"
            " updated_at_ms) VALUES ('m2', 'p1', 'deepseek-chat', 1, 1)"
        )

    with database.session() as conn:
        conn.execute(
            "INSERT INTO note_folders (id, user_id, name, created_at_ms, updated_at_ms)"
            " VALUES ('f1', 'u1', '工作', 1, 1)"
        )
    with pytest.raises(sqlite3.IntegrityError), database.session() as conn:
        # user_id / parent_id 都是 NULL 的"根级同名文件夹"同样要挡住
        conn.execute(
            "INSERT INTO note_folders (id, user_id, name, created_at_ms, updated_at_ms)"
            " VALUES ('f2', 'u1', '工作', 1, 1)"
        )


def test_version_lives_only_in_schema_metadata(database: Database) -> None:
    """规范 2：版本号**只有一处**——不另写 ``PRAGMA user_version``。"""
    with database.read() as conn:
        assert int(conn.execute("PRAGMA user_version").fetchone()[0]) == 0
        row = conn.execute(
            "SELECT value FROM schema_metadata WHERE key = 'version'"
        ).fetchone()
        created = conn.execute(
            "SELECT value FROM schema_metadata WHERE key = ?", (KEY_CREATED_AT,)
        ).fetchone()
    assert row["value"] == str(BASELINE_VERSION)
    assert int(created["value"]) > 0


def test_ensure_schema_is_idempotent(database: Database) -> None:
    assert ensure_schema(database) == BASELINE_VERSION
    assert ensure_schema(database) == BASELINE_VERSION


# ------------------------------------------------------------------ 迁移


#: 一条**合成迁移**：只在测试里存在（真实的 ``MIGRATIONS`` 现在是空的）。
#: 用它验证迁移机制本身：备份、同事务写版本、失败回滚、日志。
SYNTHETIC = Migration(
    version=2,
    description="测试用：加一张探针表",
    statements=(
        "CREATE TABLE probe (id TEXT PRIMARY KEY) STRICT",
        "CREATE INDEX idx_probe ON probe (id)",
    ),
)
BROKEN = Migration(
    version=2,
    description="测试用：第二条语句是坏 SQL",
    statements=(
        "CREATE TABLE half_baked (id TEXT PRIMARY KEY) STRICT",
        "THIS IS NOT SQL",
    ),
)


@pytest.fixture
def upgradeable(database: Database, monkeypatch) -> Database:
    """把 ``MIGRATIONS`` 换成合成的那条，并让应用期望的版本跟上。"""
    monkeypatch.setattr(schema_module, "MIGRATIONS", (SYNTHETIC,))
    monkeypatch.setattr(schema_module, "SCHEMA_VERSION", SYNTHETIC.version)
    return database


def test_migration_applies_and_records_everything(upgradeable: Database) -> None:
    assert ensure_schema(upgradeable) == SYNTHETIC.version
    with upgradeable.read() as conn:
        assert "probe" in _objects(conn, "table")
        log = json.loads(
            conn.execute(
                "SELECT value FROM schema_metadata WHERE key = ?", (KEY_MIGRATION_LOG,)
            ).fetchone()["value"]
        )
    assert [entry["version"] for entry in log] == [SYNTHETIC.version]
    assert log[0]["description"] == SYNTHETIC.description
    assert log[0]["at_ms"] > 0


def test_migration_backs_up_the_whole_database_first(upgradeable: Database) -> None:
    """规范化要求：迁移前自动备份，路径写回 ``schema_metadata.last_backup``。

    备份是**迁移前**的库——所以它里面没有 ``probe`` 表（而主库有）。
    这正是"迁移跑错了还能退回去"的那个东西。
    """
    ensure_schema(upgradeable)
    with upgradeable.read() as conn:
        recorded = conn.execute(
            "SELECT value FROM schema_metadata WHERE key = ?", (KEY_LAST_BACKUP,)
        ).fetchone()["value"]
    backup = Path(recorded)
    assert backup.exists()
    assert backup.name == upgradeable.path.name
    # 目录名带上版本区间，一眼看得出"这份是升到哪一步之前的"
    assert f"v{BASELINE_VERSION}→v{SYNTHETIC.version}" in backup.parent.name

    with sqlite3.connect(backup) as snapshot:
        names = {row[0] for row in snapshot.execute("SELECT name FROM sqlite_master")}
        version = snapshot.execute(
            "SELECT value FROM schema_metadata WHERE key = 'version'"
        ).fetchone()[0]
    assert "probe" not in names
    assert version == str(BASELINE_VERSION)


def test_failed_migration_rolls_back_and_keeps_the_version(
    database: Database, monkeypatch
) -> None:
    """失败时**表与版本一起回滚**，并指出备份在哪——不给半截状态。"""
    monkeypatch.setattr(schema_module, "MIGRATIONS", (BROKEN,))
    monkeypatch.setattr(schema_module, "SCHEMA_VERSION", BROKEN.version)
    with pytest.raises(SchemaError) as info:
        ensure_schema(database)
    assert "备份" in str(info.value)
    assert current_version(database) == BASELINE_VERSION
    with database.read() as conn:
        assert "half_baked" not in _objects(conn, "table")


def test_version_newer_than_the_app_is_refused(database: Database, monkeypatch) -> None:
    """库被更新版应用升过级 → 报错，**不降级**（旧代码写新结构 = 静默损坏）。"""
    monkeypatch.setattr(schema_module, "SCHEMA_VERSION", BASELINE_VERSION - 1)
    with pytest.raises(SchemaError, match="高于本应用已知的"):
        ensure_schema(database)


def test_broken_version_record_is_reported(database: Database) -> None:
    with database.session() as conn:
        conn.execute("UPDATE schema_metadata SET value = '不是数字' WHERE key = 'version'")
    with pytest.raises(SchemaError, match="不是十进制版本号"):
        current_version(database)


def test_baseline_failure_points_at_the_file(tmp_path: Path, monkeypatch) -> None:
    """基线 DDL 本身坏掉时要报一句能查的话（而不是一个裸 sqlite3 错误）。"""
    broken = tmp_path / "broken.sql"
    broken.write_text("CREATE TABLE ok (id TEXT PRIMARY KEY) STRICT;\nNOT SQL AT ALL;\n", "utf-8")
    monkeypatch.setattr(schema_module, "SCHEMA_PATH", broken)
    db = Database(tmp_path / "kylab.db")
    db.open()
    with pytest.raises(SchemaError, match="基线 schema 执行失败"):
        ensure_schema(db)
    db.close()


def _explain(database: Database, sql: str) -> str:
    with database.read() as conn:
        rows = conn.execute(f"EXPLAIN QUERY PLAN {sql}").fetchall()
    return " | ".join(str(row["detail"]) for row in rows)
