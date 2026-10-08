"""仓储的接口一致性测试。

一个接口的每个实现都在下面的清单里登记，漏登记就等于漏掉这条守卫。
这里只守"接口是否被完整实现"；行为验证在各自的实现测试里。
新增接口方法时这里会立刻变红，提醒实现方补齐。
"""

import pytest

from app.storage.base import FullTextStore, MetaStore, ObjectStore, TabularStore, VectorStore
from app.storage.local_impl.object_store import LocalObjectStore
from app.storage.split_impl import (
    RouterMetaStore,
    UnavailableFullTextStore,
    UnavailableTabularStore,
    UnavailableVectorStore,
)

#: 同一接口的每个实现都要在这里登记。新增实现忘了登记时，
#: "抽象方法有没有漏实现"这条守卫就会漏掉它——所以这份清单要跟着实现一起长。
#:
#: ``RouterMetaStore`` 是 `MetaStore` 的**分档**实现（本机域走 SQLite、KB 域转给
#: KB 侧，见 ``app/storage/split_impl/router.py``）；三个 ``Unavailable*`` 是本机
#: "这个能力在别处"那一半的完整实现（每个方法都抛）。
#: ``SqliteMetaStore`` / ``RemoteMetaStore`` **不在这个清单里**：它们各自只覆盖
#: MetaStore 的一半（本机域 / KB 域），不是完整的接口实现——"是否完整"由
#: ``tests/unit/storage/test_split_impl.py`` 逐名核对。
IMPLEMENTATIONS = (
    (LocalObjectStore, ObjectStore),
    (RouterMetaStore, MetaStore),
    (UnavailableVectorStore, VectorStore),
    (UnavailableFullTextStore, FullTextStore),
    (UnavailableTabularStore, TabularStore),
)


@pytest.mark.parametrize(("implementation", "interface"), IMPLEMENTATIONS)
def test_implements_its_interface(implementation: type, interface: type) -> None:
    assert issubclass(implementation, interface)


@pytest.mark.parametrize(("implementation", "interface"), IMPLEMENTATIONS)
def test_no_abstract_methods_left(implementation: type, interface: type) -> None:
    assert implementation.__abstractmethods__ == frozenset()


def test_choose_implementation_by_interface_not_by_class() -> None:
    """组合根里应当只出现接口类型；实现类名不该泄漏到 services 层。"""
    from app.storage.base import StoreBundle

    annotations = StoreBundle.__annotations__
    assert annotations["meta"] is not None
    assert all(
        "_impl" not in str(annotation) for annotation in annotations.values()
    ), "StoreBundle 的字段类型不应是具体实现"
