"""后端测试共享夹具。

工程规范 §5.2：集成测试使用**独立临时 SQLite 文件**（tmp 目录），禁止触碰开发库。

各测试目录都放了 ``__init__.py``：工程规范 §5.1 要求测试文件与被测模块镜像同构，
于是 ``unit`` 与 ``integration`` 下会出现同名 ``test_<模块>.py``；
不加包的话 pytest 会因 basename 冲突而报 "import file mismatch"。
"""

import pytest

from app.core.config import get_settings
from app.core.storage import reset_stores
from app.models.enums import DataSourceKind, DocumentStage
from app.storage.base import DocumentRecord, KnowledgeBaseRecord
from app.storage.sqlite_impl.connection import Database
from app.storage.sqlite_impl.fulltext_store import SqliteFullTextStore
from app.storage.sqlite_impl.meta_store import SqliteMetaStore
from app.storage.sqlite_impl.migrations import apply_migrations
from app.storage.sqlite_impl.object_store import LocalObjectStore
from app.storage.sqlite_impl.vector_store import SqliteVectorStore

DEFAULT_MODEL_ID = "BAAI/bge-m3"
DEFAULT_DIM = 1024


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    """全局兜底：任何测试都不许把运行期数据写进仓库。

    起因：`build_stores()` 默认用 ``./data``，一旦某个测试忘了指临时目录，
    就会在 `backend/data/` 建出 kylab.db 与三个子目录（被 .gitignore 挡住所以不易发现，
    但会污染本地状态、干扰后续手工验证）。这里统一把 ``KYLAB_DATA_DIR`` 指到 tmp 目录，
    并清掉配置与装配的缓存。
    """
    monkeypatch.setenv("KYLAB_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()
    reset_stores()
    yield
    reset_stores()
    get_settings.cache_clear()


@pytest.fixture
def database(tmp_path) -> Database:
    """建好 schema 的临时数据库文件。"""
    db = Database(tmp_path / "kylab-test.db")
    conn = db.connect()
    try:
        apply_migrations(conn)
    finally:
        conn.close()
    return db


@pytest.fixture
def store(database: Database) -> SqliteMetaStore:
    return SqliteMetaStore(database)


@pytest.fixture
def vector_store(database: Database) -> SqliteVectorStore:
    return SqliteVectorStore(database)


@pytest.fixture
def fulltext_store(database: Database) -> SqliteFullTextStore:
    return SqliteFullTextStore(database)


@pytest.fixture
def object_store(tmp_path) -> LocalObjectStore:
    """对象存储根目录用临时目录，绝不写进仓库的 data/。"""
    return LocalObjectStore(tmp_path / "data")


@pytest.fixture
def kb(store: SqliteMetaStore) -> KnowledgeBaseRecord:
    return store.create_knowledge_base(
        KnowledgeBaseRecord(id="kb_1", name="默认库", embedding_model_id=DEFAULT_MODEL_ID,
                            embedding_dim=DEFAULT_DIM)
    )


@pytest.fixture
def document(store: SqliteMetaStore, kb: KnowledgeBaseRecord) -> DocumentRecord:
    return store.create_document(
        DocumentRecord(
            id="doc_1",
            knowledge_base_id=kb.id,
            name="示例.md",
            source_kind=DataSourceKind.UPLOAD,
            content_hash="hash-1",
            stage=DocumentStage.UPLOADED,
            size_bytes=128,
        )
    )

