r"""按域分流的存储实现（M2「会话落本机」阶段 2）。

本机档里 ``stores.meta`` 长这样（实施方案 §2.1）：

    services/ ──▶ StoreBundle.meta ──▶ RouterMetaStore ─┬─▶ SqliteMetaStore（本机域）
                                                        └─▶ UnavailableMetaStore（KB 域）

- ``router.py``  —— ``RouterMetaStore`` + 四个 ``Unavailable*Store``
  （``KnowledgeBaseUnavailable`` 的**定义**在 ``storage/base.py``：M3 起 services 侧的
  提供者客户端也要抛它，而 services 只允许 import 接口层——这里只是再导出）；
- ``LOCAL_METHODS`` 的**唯一落点仍然是** ``app/storage/sqlite_impl/``（阶段 0+1 交接的偏离 4）：
  这里只是转出来方便调用方，**不许出现第二份清单**——两份手写清单迟早会漂，
  而漂掉的那个方法只会在某条边角路径上以 ``AttributeError`` 出现。

**装配点只有一处**：``core/storage.py`` 的 ``_build_local_stores()``（与其它具体实现同一
条纪律，见 ``app/storage/__init__.py``）。另有一处只读异常类：``core/exceptions.py``
把 ``KnowledgeBaseUnavailable`` 映成 503——所以它在函数里 import，不进模块级依赖图。
"""

from __future__ import annotations

from app.storage.split_impl.router import (
    KB_UNAVAILABLE_MESSAGE,
    LOCAL_METHODS,
    REMOTE_METHODS,
    SEARCH_UNAVAILABLE_MESSAGE,
    KnowledgeBaseUnavailable,
    RouterMetaStore,
    UnavailableFullTextStore,
    UnavailableMetaStore,
    UnavailableTabularStore,
    UnavailableVectorStore,
)

__all__ = [
    "KB_UNAVAILABLE_MESSAGE",
    "LOCAL_METHODS",
    "REMOTE_METHODS",
    "SEARCH_UNAVAILABLE_MESSAGE",
    "KnowledgeBaseUnavailable",
    "RouterMetaStore",
    "UnavailableFullTextStore",
    "UnavailableMetaStore",
    "UnavailableTabularStore",
    "UnavailableVectorStore",
]
