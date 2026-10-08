"""存储装配（组合根）测试。

镜像同构：``app/core/storage.py`` → ``tests/unit/core/test_storage.py``。

这个后端只有本机一种形态，所以这里只验收一条路：装配出 ``<data_dir>/kylab.db``
（SQLite）+ 三个"不可用"仓储 + 本地目录对象存储，而且**真的能用**
（一个装配成功但一调就炸的 bundle，与没有装配是一回事）。
"""

from pathlib import Path

import pytest

from app.core.config import Settings
from app.core.storage import (
    LOCAL_DB_NAME,
    STORAGE_SUBDIRS,
    build_stores,
    close_stores,
    get_stores,
    reset_stores,
)
from app.storage.base import StorageError
from app.storage.split_impl import (
    SEARCH_UNAVAILABLE_MESSAGE,
    UNBOUND_MESSAGE,
    KnowledgeBaseUnavailable,
    RemoteMetaStore,
    RouterMetaStore,
)
from app.storage.sqlite_impl.meta_store import SqliteMetaStore


def _settings(tmp_path: Path, **overrides) -> Settings:  # type: ignore[no-untyped-def]
    """本机设置：``_env_file=None`` 保证开发机的 ``.env`` 不会漏进来。"""
    return Settings(  # type: ignore[call-arg]
        _env_file=None, data_dir=tmp_path / "data", **overrides
    )


@pytest.fixture(autouse=True)
def _close_pools():
    """用例会直接调 build_stores，库句柄得还回去。"""
    yield
    close_stores()


def test_build_stores_creates_object_directories(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    build_stores(settings)

    for subdir in STORAGE_SUBDIRS:
        assert (Path(settings.data_dir) / subdir).is_dir()


def test_every_field_is_filled_and_really_usable(tmp_path: Path) -> None:
    """所有字段齐备，而且写进去读得回来（经 router，与 services 走的是同一条路）。

    五个元数据字段（``ledger`` / ``kb_cache`` / ``snapshot`` / ``backup_queue`` /
    ``eraser``）指的都是**同一个** ``SqliteMetaStore`` 实例：同一个 ``Database``，
    也就是"写锁是进程内一把"那条纪律站得住的地方。
    """
    settings = _settings(tmp_path)
    stores = build_stores(settings)

    assert isinstance(stores.meta, RouterMetaStore)
    assert isinstance(stores.meta.local, SqliteMetaStore)
    # KB 侧的库元数据读转给 RemoteMetaStore（reader 由服务层后挂）
    assert isinstance(stores.meta.kb, RemoteMetaStore)
    assert all(
        getattr(stores, field) is not None
        for field in ("vectors", "fulltext", "objects", "tabular")
    )
    assert stores.ledger is stores.meta.local
    assert stores.kb_cache is stores.meta.local
    assert stores.snapshot is stores.meta.local
    assert stores.backup_queue is stores.meta.local
    assert stores.eraser is stores.meta.local

    stores.meta.set_setting("chat.mode", "build")
    assert stores.meta.get_setting("chat.mode") == "build"

    data_dir = Path(settings.data_dir)
    assert (data_dir / LOCAL_DB_NAME).is_file()
    # 对象存储真的落在数据目录里（不是某个桶里）
    path = stores.objects.write("markdown/doc_1.md", "# 标题".encode())
    assert (data_dir / path).is_file()
    assert stores.objects.read(path) == "# 标题".encode()


def test_build_stores_is_idempotent(tmp_path: Path) -> None:
    """每次启动都会调用，必须能重复执行而不出错、不重复应用基线。"""
    settings = _settings(tmp_path)
    build_stores(settings)
    close_stores()
    stores = build_stores(settings)

    assert stores.meta.get_setting("chat.mode") is None  # 没有凭空长出东西
    assert (Path(settings.data_dir) / LOCAL_DB_NAME).is_file()


def test_local_db_path_can_be_pointed_elsewhere(tmp_path: Path) -> None:
    """``KYLAB_LOCAL_DB`` 指到别处时库就落别处（默认才是 ``<data_dir>/kylab.db``）。"""
    target = tmp_path / "elsewhere" / "kylab.db"
    settings = _settings(tmp_path, local_db=target)
    build_stores(settings)

    assert target.is_file()
    assert not (Path(settings.data_dir) / LOCAL_DB_NAME).exists()


def test_the_kb_domain_reports_itself_as_unavailable(tmp_path: Path) -> None:
    """两个"没有这个能力"的口径**逐句**钉住（503 那句话的来源）。

    两句话不一样，也不该一样：

    - **检索**（``vectors`` / ``fulltext`` / ``tabular``）——本机没有向量与全文索引，
      别把它改成"经提供者的半吊子"（那句话里写着"检索在 NAS 知识库"）；
    - **KB 侧的库元数据读**由 ``RemoteMetaStore`` 承担，而它要的 reader 是**服务层
      装配时后挂**的：只调 ``build_stores`` 时它还没接上，给的是"知识库提供者还没接上
      （组合根未装配）"——不是 ``AttributeError``，更不是空结果。
    """
    stores = build_stores(_settings(tmp_path))

    with pytest.raises(KnowledgeBaseUnavailable) as kb_error:
        stores.meta.list_knowledge_bases()
    assert str(kb_error.value) == UNBOUND_MESSAGE

    with pytest.raises(KnowledgeBaseUnavailable):
        stores.vectors.list_partitions()
    with pytest.raises(KnowledgeBaseUnavailable) as search_error:
        stores.fulltext.search(query="会话", top_k=3)
    assert str(search_error.value) == SEARCH_UNAVAILABLE_MESSAGE
    with pytest.raises(KnowledgeBaseUnavailable):
        stores.tabular.list_tables()

    assert issubclass(KnowledgeBaseUnavailable, StorageError)


def test_get_stores_is_cached_and_resettable(monkeypatch, tmp_path: Path) -> None:
    """``lru_cache`` 单例：两次取到同一份装配，重置后重新装配。"""
    monkeypatch.setenv("KYLAB_DATA_DIR", str(tmp_path / "data"))
    reset_stores()
    try:
        first = get_stores()
        assert isinstance(first.meta, RouterMetaStore)
        assert get_stores() is first

        reset_stores()
        assert get_stores() is not first
    finally:
        reset_stores()
