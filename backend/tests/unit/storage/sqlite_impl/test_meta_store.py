"""``SqliteMetaStore`` 的接口一致性测试。

镜像同构：``app/storage/sqlite_impl/meta_store.py``
→ ``tests/unit/storage/sqlite_impl/test_meta_store.py``。

这里只守"接口是否被完整实现"，行为验证在
``tests/integration/storage/test_meta_store.py``。
"""

from app.storage.base import MetaStore
from app.storage.sqlite_impl.meta_store import SqliteMetaStore


def test_implements_meta_store_interface() -> None:
    assert issubclass(SqliteMetaStore, MetaStore)


def test_no_abstract_methods_left() -> None:
    """接口新增方法后这里会立刻变红，提醒实现方补齐——而不是等到运行时报 TypeError。"""
    assert SqliteMetaStore.__abstractmethods__ == frozenset()


def test_is_instantiable_with_a_database(tmp_path) -> None:
    from app.storage.sqlite_impl.connection import Database

    assert SqliteMetaStore(Database(tmp_path / "x.db")) is not None
