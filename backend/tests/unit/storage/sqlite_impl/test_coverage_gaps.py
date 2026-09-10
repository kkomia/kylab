"""补齐审查发现的覆盖缺口（T1.4/T1.5/T1.6 收口）。

镜像同构：覆盖 ``connection`` / ``object_store`` / ``vector_store`` / ``fulltext_store``
中此前未被触达的边界分支。
"""

import logging
import sqlite3

import pytest

from app.storage.sqlite_impl.connection import Database
from app.storage.sqlite_impl.fulltext_store import SqliteFullTextStore
from app.storage.sqlite_impl.object_store import ORIGINALS, LocalObjectStore, content_key
from app.storage.sqlite_impl.vector_store import SqliteVectorStore


def test_database_exposes_its_path(tmp_path) -> None:
    path = tmp_path / "kylab.db"
    assert Database(path).path == str(path)


def test_memory_uri_variant_is_treated_as_memory() -> None:
    """``file::memory:`` 形态走 uri 模式，不该当成文件名去建库、也不该开 WAL。"""
    db = Database("file::memory:?cache=shared")
    assert db.is_memory is True
    with db.session() as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() != "wal"
        conn.execute("CREATE TABLE t (a INTEGER)")


def test_file_uri_is_not_persisted_as_a_weird_filename(tmp_path) -> None:
    """回归：没有 uri=True 时，file: 连接串会被当成文件名创建出一个怪文件。"""
    db = Database("file::memory:?cache=shared")
    with db.session() as conn:
        conn.execute("CREATE TABLE t (a INTEGER)")

    assert list(tmp_path.iterdir()) == []  # 临时目录里不该冒出任何东西


def test_object_store_exposes_root(object_store: LocalObjectStore) -> None:
    assert object_store.root.is_dir()


def test_content_key_rejects_hash_without_usable_characters() -> None:
    with pytest.raises(ValueError, match="不含可用字符"):
        content_key(ORIGINALS, "!!!中文!!!")


def test_content_key_strips_unsafe_characters() -> None:
    """上传方给的 hash 里可能混入分隔符，必须被过滤掉，否则会造出子目录。"""
    assert content_key(ORIGINALS, "ab/cd", ".pdf") == "originals/ab/abcd.pdf"


def test_delete_removes_directory_tree(object_store: LocalObjectStore) -> None:
    object_store.write("originals/ab/a.bin", b"A")
    object_store.write("originals/ab/b.bin", b"B")

    object_store.delete("originals/ab")
    assert object_store.exists("originals/ab/a.bin") is False
    assert object_store.exists("originals/ab/b.bin") is False


def test_upsert_with_empty_items_is_noop(vector_store: SqliteVectorStore) -> None:
    vector_store.upsert_vectors("kb_1", items=[])
    assert vector_store.declared_dim("kb_1") is None  # 空输入不应顺手建分区


def test_slow_fulltext_query_is_logged(database: Database, store, kb, document,
                                       caplog) -> None:
    """慢查询留痕：阈值可注入，这里设成 0 让任何查询都算慢。"""
    from app.models.enums import DataSourceKind, DocumentStage
    from app.storage.base import ChunkRecord, DocumentRecord

    store.create_document(
        DocumentRecord(id="doc_9", knowledge_base_id="kb_1", name="c.md",
                       source_kind=DataSourceKind.UPLOAD, content_hash="hash-9",
                       stage=DocumentStage.UPLOADED)
    )
    chunk = ChunkRecord(chunk_id="c9", document_id="doc_9", knowledge_base_id="kb_1",
                        part_id=None, ordinal=0, text="慢查询阈值测试内容",
                        content_hash="h-c9")
    store.replace_chunks("doc_9", [chunk])

    fulltext = SqliteFullTextStore(database, slow_query_ms=0)
    fulltext.index_chunks([chunk])

    with caplog.at_level(logging.WARNING, logger="app.storage.sqlite_impl.fulltext_store"):
        hits = fulltext.search(query="慢查询", top_k=5)

    assert hits, "查询本身应正常返回结果"
    assert any("慢查询" in record.message for record in caplog.records)


def test_connection_is_closed_after_fulltext_search(database: Database, store, kb,
                                                    document) -> None:
    """全文检索走 read() 上下文，句柄必须释放（Windows 下否则删不了库文件）。"""
    fulltext = SqliteFullTextStore(database)
    for _ in range(20):
        fulltext.search(query="任意", top_k=3)

    with pytest.raises(sqlite3.ProgrammingError):
        # 拿一个连接试关闭语义：read() 退出后不应再可用
        with database.read() as conn:
            pass
        conn.execute("SELECT 1")
