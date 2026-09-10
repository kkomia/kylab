"""schema 契约测试（集成）：表结构必须兑现架构里的关键承诺。

用独立临时 SQLite 文件，不触碰开发库（工程规范 §5.2）。
"""

import sqlite3
from datetime import UTC, datetime

import pytest

from app.models.enums import DataSourceKind, DocumentStage, TaskKind, TaskState
from app.storage.sqlite_impl.connection import Database
from app.storage.sqlite_impl.migrations import apply_migrations

REQUIRED_TABLES = {
    "knowledge_bases",
    "documents",
    "document_parts",
    "chunks",
    "chunk_images",
    "images",
    "parse_results",
    "tasks",
    "data_sources",
    "api_keys",
    "webhooks",
    "trash",
    "app_settings",
    "idempotency_keys",
    "chunks_fts",
    "schema_migrations",
}

NOW = datetime.now(UTC).isoformat()


@pytest.fixture
def conn(tmp_path):
    connection = Database(tmp_path / "kylab.db").connect()
    apply_migrations(connection)
    yield connection
    connection.close()


def _insert_kb(conn: sqlite3.Connection, kb_id: str = "kb_1", dim: int = 1024) -> None:
    conn.execute(
        """
        INSERT INTO knowledge_bases
            (id, name, embedding_model_id, embedding_dim, created_at, updated_at)
        VALUES (?, '默认库', 'BAAI/bge-m3', ?, ?, ?)
        """,
        (kb_id, dim, NOW, NOW),
    )


def _insert_document(
    conn: sqlite3.Connection, document_id: str = "doc_1", content_hash: str = "h1"
) -> None:
    conn.execute(
        """
        INSERT INTO documents
            (id, knowledge_base_id, name, source_kind, content_hash, stage, created_at, updated_at)
        VALUES (?, 'kb_1', 'a.pdf', ?, ?, ?, ?, ?)
        """,
        (
            document_id,
            DataSourceKind.UPLOAD.value,
            content_hash,
            DocumentStage.UPLOADED.value,
            NOW,
            NOW,
        ),
    )


def test_all_required_tables_exist(conn: sqlite3.Connection) -> None:
    tables = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master")}
    assert tables >= REQUIRED_TABLES


def test_knowledge_base_records_embedding_dimension(conn: sqlite3.Connection) -> None:
    """D4 的落地：维度随库记录，不在 schema 里写死。"""
    _insert_kb(conn, dim=1024)
    row = conn.execute("SELECT embedding_dim FROM knowledge_bases WHERE id = 'kb_1'").fetchone()
    assert row["embedding_dim"] == 1024


def test_embedding_dimension_must_be_positive(conn: sqlite3.Connection) -> None:
    with pytest.raises(sqlite3.IntegrityError):
        _insert_kb(conn, dim=0)


def test_same_content_in_one_kb_is_rejected(conn: sqlite3.Connection) -> None:
    """架构 §6.3 文件级去重的 schema 层保证。"""
    _insert_kb(conn)
    _insert_document(conn, "doc_1", "same-hash")
    with pytest.raises(sqlite3.IntegrityError):
        _insert_document(conn, "doc_2", "same-hash")


def test_same_content_in_different_kbs_is_allowed(conn: sqlite3.Connection) -> None:
    _insert_kb(conn, "kb_1")
    _insert_kb(conn, "kb_2")
    _insert_document(conn, "doc_1", "same-hash")
    conn.execute(
        """
        INSERT INTO documents
            (id, knowledge_base_id, name, source_kind, content_hash, stage, created_at, updated_at)
        VALUES ('doc_2', 'kb_2', 'a.pdf', ?, 'same-hash', ?, ?, ?)
        """,
        (DataSourceKind.UPLOAD.value, DocumentStage.UPLOADED.value, NOW, NOW),
    )
    assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 2


def test_deleting_knowledge_base_cascades_to_chunks(conn: sqlite3.Connection) -> None:
    """级联删除（架构 §6.2）依赖外键；这条同时守住 PRAGMA foreign_keys=ON。"""
    _insert_kb(conn)
    _insert_document(conn)
    conn.execute(
        """
        INSERT INTO chunks
            (chunk_id, document_id, knowledge_base_id, ordinal, text, content_hash)
        VALUES ('c1', 'doc_1', 'kb_1', 0, '正文', 'ch1')
        """,
    )

    conn.execute("DELETE FROM knowledge_bases WHERE id = 'kb_1'")
    assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == 0


def test_parse_result_key_uses_empty_string_for_whole_document(conn: sqlite3.Connection) -> None:
    """part_id 用 '' 而非 NULL：SQLite 里 NULL 互不相等，会让唯一约束形同虚设。"""
    _insert_kb(conn)
    _insert_document(conn)
    statement = """
        INSERT INTO parse_results
            (document_id, part_id, parser_name, markdown_path, created_at)
        VALUES ('doc_1', '', 'MinerUCloudParser', 'data/markdown/doc_1.md', ?)
    """
    conn.execute(statement, (NOW,))
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(statement, (NOW,))


def test_document_part_page_range_is_validated(conn: sqlite3.Connection) -> None:
    _insert_kb(conn)
    _insert_document(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO document_parts
                (id, document_id, part_index, page_start, page_end, stage)
            VALUES ('p1', 'doc_1', 0, 500, 100, ?)
            """,
            (DocumentStage.UPLOADED.value,),
        )


def test_task_queue_supports_lease_and_retry(conn: sqlite3.Connection) -> None:
    """租约 + 重试次数是断点续跑的前提（架构 §4）。"""
    conn.execute(
        """
        INSERT INTO tasks (id, kind, state, attempts, max_attempts, lease_owner,
                           lease_expires_at, created_at, updated_at)
        VALUES ('t1', ?, ?, 2, 5, 'worker-1', ?, ?, ?)
        """,
        (TaskKind.PARSE.value, TaskState.RUNNING.value, NOW, NOW, NOW),
    )
    row = conn.execute("SELECT attempts, max_attempts, lease_owner FROM tasks").fetchone()
    assert (row["attempts"], row["max_attempts"], row["lease_owner"]) == (2, 5, "worker-1")
    index_names = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master")}
    assert "idx_tasks_claim" in index_names


def test_full_text_index_is_available(conn: sqlite3.Connection) -> None:
    conn.execute("INSERT INTO chunks_fts (chunk_id, tokens) VALUES ('c1', '知识 库 检索')")
    hit = conn.execute(
        "SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ?", ("检索",)
    ).fetchone()
    assert hit["chunk_id"] == "c1"
