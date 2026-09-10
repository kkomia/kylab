"""存储装配（组合根）测试。

镜像同构：``app/core/storage.py`` → ``tests/unit/core/test_storage.py``。
"""

import sqlite3
from pathlib import Path

import pytest

from app.core.config import Settings
from app.core.storage import STORAGE_SUBDIRS, build_stores, get_stores, reset_stores
from app.models.enums import DataSourceKind, DocumentStage
from app.storage.base import DocumentRecord, KnowledgeBaseRecord
from app.storage.sqlite_impl.migrations import current_version


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(_env_file=None, data_dir=tmp_path / "data")  # type: ignore[call-arg]


def test_build_stores_creates_database_and_directories(settings: Settings) -> None:
    build_stores(settings)

    assert settings.db_path.is_file()
    for subdir in STORAGE_SUBDIRS:
        assert (Path(settings.data_dir) / subdir).is_dir()


def test_build_stores_applies_migrations(settings: Settings) -> None:
    build_stores(settings)

    connection = sqlite3.connect(settings.db_path)
    try:
        assert current_version(connection) >= 1
    finally:
        connection.close()


def test_build_stores_is_idempotent(settings: Settings) -> None:
    """每次启动都会调用，必须能重复执行而不出错、不重复迁移。"""
    build_stores(settings)
    build_stores(settings)

    assert settings.db_path.is_file()
    connection = sqlite3.connect(settings.db_path)
    try:
        applied = connection.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0]
    finally:
        connection.close()
    assert applied == 1  # 只有一个迁移版本，没有被重复应用


def test_stores_are_functionally_wired(settings: Settings) -> None:
    """四个仓储确实能协同工作（元数据 + 全文 + 向量 + 对象）。"""
    stores = build_stores(settings)
    stores.meta.create_knowledge_base(
        KnowledgeBaseRecord(id="kb_1", name="库", embedding_model_id="BAAI/bge-m3",
                            embedding_dim=4)
    )
    stores.meta.create_document(
        DocumentRecord(id="doc_1", knowledge_base_id="kb_1", name="a.md",
                       source_kind=DataSourceKind.UPLOAD, content_hash="h1",
                       stage=DocumentStage.UPLOADED)
    )
    stores.vectors.ensure_partition("kb_1", dim=4)
    stores.vectors.upsert_vectors("kb_1", items=[("c1", [1.0, 0.0, 0.0, 0.0])])
    path = stores.objects.write("markdown/doc_1.md", "# 标题".encode())

    assert stores.meta.get_knowledge_base("kb_1") is not None
    assert stores.vectors.declared_dim("kb_1") == 4
    assert stores.objects.read(path) == "# 标题".encode()


def test_get_stores_is_cached_and_resettable(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("KYLAB_DATA_DIR", str(tmp_path / "data"))
    reset_stores()
    try:
        first = get_stores()
        assert get_stores() is first  # 进程级单例：两次取到同一份装配

        reset_stores()
        assert get_stores() is not first  # 重置后重新装配（必须持有引用才能比较）
    finally:
        reset_stores()
