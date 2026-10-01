"""分档路由与"不可用"那半的接口核对（不需要 PostgreSQL）。

镜像同构：``app/storage/split_impl/`` → ``tests/unit/storage/test_split_impl.py``。

三块内容（M2 实施方案 §2.1 / §6.4）：

1. **域完备性**：``LOCAL_METHODS`` 与 ``REMOTE_METHODS`` 恰好划开 ``MetaStore`` 的全部
   抽象方法、两者不相交，``RouterMetaStore`` 是**完整**的 ``MetaStore``
   （``__abstractmethods__`` 是空集——它是"真的实现了每个方法"的结果，不是赋出来的）；
2. **转发确实是转发**：每个方法转到归属那一半，参数原样、返回值原样；
3. **不可用要抛**：``Unavailable*`` 的**每个方法**都抛 ``KnowledgeBaseUnavailable``
   （逐个调用，128 个方法一个不漏），``search`` 那句写明"检索在 NAS 知识库，M3 接提供者"。

外加一条**子进程**断言（§7 阶段 2 的完成判据）：``KYLAB_DEPLOYMENT=local`` 下跑一次
真 ``build_stores()``，``psycopg`` / ``boto3`` / ``duckdb`` 一个都不许进 ``sys.modules``。
为什么必须换进程：本进程里 ``tests/conftest.py`` 早就 import 了 psycopg，
在脏 ``sys.modules`` 上查"有没有 import"永远查不出东西。
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from app.storage.base import FullTextStore, MetaStore, StorageError, TabularStore, VectorStore
from app.storage.split_impl import (
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
from app.storage.sqlite_impl import LOCAL_METHODS as SQLITE_LOCAL_METHODS

pytestmark = pytest.mark.local

#: backend/（本文件在 backend/tests/unit/storage/ 下，上溯三级）
BACKEND = Path(__file__).resolve().parents[3]

#: 服务器档才用得上的三份后端（约 108 MB，见 ``core/storage.py`` 那段"为什么惰性"）。
SERVER_BACKENDS = ("psycopg", "psycopg_pool", "boto3", "botocore", "duckdb")


class _Recorder:
    """一个"什么方法都有、只记下被调用"的假实现，用来验转发本身。"""

    def __init__(self, label: str) -> None:
        self.label = label
        self.calls: list[tuple[str, tuple[object, ...], dict[str, object]]] = []

    def __getattr__(self, name: str):  # type: ignore[no-untyped-def]
        def method(*args: object, **kwargs: object) -> str:
            self.calls.append((name, args, kwargs))
            return f"{self.label}:{name}"

        return method


# ------------------------------------------------------------------ 域完备性


def test_the_two_halves_partition_the_whole_interface() -> None:
    """``LOCAL ∪ REMOTE`` 恰好是全部抽象方法，且两者不相交（§2.1 要求的那两条）。"""
    abstract = set(MetaStore.__abstractmethods__)
    both_halves = LOCAL_METHODS | REMOTE_METHODS

    assert both_halves == abstract
    assert not LOCAL_METHODS & REMOTE_METHODS
    assert len(LOCAL_METHODS) + len(REMOTE_METHODS) == len(abstract)


def test_local_methods_come_from_the_single_source_of_truth() -> None:
    """本机域的清单**只有一份**：split_impl 转出来的是 sqlite_impl 那一份。

    两份手写清单迟早会漂，而漂掉的那个方法只会在某条边角路径上以 ``AttributeError``
    出现（阶段 0+1 交接的偏离 4）。
    """
    assert LOCAL_METHODS is SQLITE_LOCAL_METHODS


def test_router_is_a_complete_meta_store() -> None:
    """``RouterMetaStore`` 没有剩下的抽象方法——这是"每个抽象方法都生成了转发器"的结果。"""
    assert issubclass(RouterMetaStore, MetaStore)
    assert RouterMetaStore.__abstractmethods__ == frozenset()


def test_unavailable_meta_store_covers_exactly_the_kb_half() -> None:
    """KB 侧实现**恰好**覆盖 ``REMOTE_METHODS``：一个不多、一个不少。

    与 ``SqliteMetaStore`` 恰好覆盖 ``LOCAL_METHODS`` 是同一条纪律的两半——多一个
    就是偷偷实现了另一域的活，少一个就是路由到那里时才炸。
    """
    public = {
        name
        for name, value in vars(UnavailableMetaStore).items()
        if not name.startswith("_") and callable(value)
    }
    assert public == set(REMOTE_METHODS)


@pytest.mark.parametrize(
    ("implementation", "interface"),
    [
        (UnavailableVectorStore, VectorStore),
        (UnavailableFullTextStore, FullTextStore),
        (UnavailableTabularStore, TabularStore),
    ],
)
def test_unavailable_stores_implement_their_interface(
    implementation: type, interface: type
) -> None:
    """三个"不可用"仓储是各自接口的**完整**实现（每个方法都在，只是都抛）。"""
    assert issubclass(implementation, interface)
    assert implementation.__abstractmethods__ == frozenset()


# ------------------------------------------------------------------ 转发


def test_every_method_routes_to_exactly_one_half() -> None:
    """逐个方法核对归属：路由表与 ``LOCAL_METHODS`` 必须是同一个答案。"""
    local, kb = _Recorder("local"), _Recorder("kb")
    router = RouterMetaStore(local, kb)

    for name in MetaStore.__abstractmethods__:
        expected = local if name in LOCAL_METHODS else kb
        assert router.route_of(name) is expected, name


def test_calls_are_forwarded_verbatim() -> None:
    """转发**原样**：位置参数、关键字参数、返回值都不经手改。

    这也是"签名写成 ``*args, **kwargs``"的理由——``MetaStore`` 里大量方法是关键字
    专用的，逐个手抄签名抄不准（抄错的后果是运行期 ``TypeError``，只在某条路径上出现）。
    """
    local, kb = _Recorder("local"), _Recorder("kb")
    router = RouterMetaStore(local, kb)

    assert router.create_conversation("record", workspace_id="ws_1") == "local:create_conversation"
    assert local.calls == [("create_conversation", ("record",), {"workspace_id": "ws_1"})]

    assert router.create_document("record") == "kb:create_document"
    assert kb.calls == [("create_document", ("record",), {})]
    assert local.calls == [("create_conversation", ("record",), {"workspace_id": "ws_1"})]


# ------------------------------------------------------------------ 不可用要抛


def _unavailable_instances() -> list[object]:
    return [
        UnavailableMetaStore(),
        UnavailableVectorStore(),
        UnavailableFullTextStore(),
        UnavailableTabularStore(),
    ]


def test_every_unavailable_method_raises_instead_of_pretending() -> None:
    """**每个方法**都抛——不留任何"悄悄回空值"的口子（空结果会被读成"库里没有"）。

    逐个调用（不带参数即可：这些方法在检查参数之前就抛），一个方法都不放过。
    """
    called = 0
    for store in _unavailable_instances():
        for name, value in vars(type(store)).items():
            if name.startswith("_") or not callable(value):
                continue
            with pytest.raises(KnowledgeBaseUnavailable):
                getattr(store, name)()
            called += 1
    assert called == len(REMOTE_METHODS) + sum(
        len(interface.__abstractmethods__)
        for interface in (VectorStore, FullTextStore, TabularStore)
    )


def test_unavailable_methods_say_nas_and_the_next_stage() -> None:
    """报错句子里要有"在 NAS 上"和"M3"这两件事（否则用户不知道该去哪儿）。"""
    for store in _unavailable_instances():
        names = [name for name, value in vars(type(store)).items() if not name.startswith("_")]
        with pytest.raises(KnowledgeBaseUnavailable) as excinfo:
            getattr(store, names[0])()
        message = str(excinfo.value)
        assert "NAS" in message, message
        assert "M3" in message, message
        assert "知识库" in message, message


def test_search_says_retrieval_is_on_the_nas_knowledge_base() -> None:
    """``search`` 单独一句（§2.2）：**检索在 NAS 知识库，M3 接提供者**。"""
    assert "检索在 NAS 知识库" in SEARCH_UNAVAILABLE_MESSAGE

    for store in (UnavailableVectorStore(), UnavailableFullTextStore()):
        with pytest.raises(KnowledgeBaseUnavailable) as excinfo:
            store.search()
        assert str(excinfo.value) == SEARCH_UNAVAILABLE_MESSAGE


def test_the_unavailable_error_is_a_storage_error() -> None:
    """``StorageError`` 子类：services 不必 import 具体实现就能捕获（接口层的承诺）。"""
    error = KnowledgeBaseUnavailable()
    assert isinstance(error, StorageError)
    assert str(error) == KB_UNAVAILABLE_MESSAGE
    assert str(KnowledgeBaseUnavailable("自定义一句")) == "自定义一句"


# ------------------------------------------------------------------ 本地档不背服务器后端


def test_local_deployment_builds_every_field_without_the_server_backends(tmp_path: Path) -> None:
    """§7 阶段 2 完成判据：``KYLAB_DEPLOYMENT=local`` 下五个字段齐备，三份后端都没 import。

    跑在**干净解释器**里（本进程早就 import 过 psycopg，查不出东西），用**环境变量**钉档
    （与生产同一条路：``get_settings()`` + ``build_stores()``），并把 ``.env`` 会带来的
    ``KYLAB_DATABASE_URL`` 压成空串——不压的话本机档会当场拒绝（那正是它该做的事）。
    """
    script = textwrap.dedent(
        f"""
        import sys

        from app.core.storage import build_stores

        stores = build_stores()
        fields = ("meta", "vectors", "fulltext", "objects", "tabular")
        print("missing:", [name for name in fields if getattr(stores, name, None) is None])
        print("backends:", sorted(name for name in {SERVER_BACKENDS!r} if name in sys.modules))
        """
    )
    env = {
        **os.environ,
        "KYLAB_DEPLOYMENT": "local",
        "KYLAB_DATA_DIR": str(tmp_path / "data"),
        "KYLAB_DATABASE_URL": "",
        "PYTHONIOENCODING": "utf-8",
    }
    # 命令是"本仓库自己的解释器 + 一段写死在文件里的脚本"，不是外部输入
    result = subprocess.run(  # noqa: S603
        [sys.executable, "-c", script],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )

    assert result.returncode == 0, result.stderr
    assert "missing: []" in result.stdout, result.stdout
    assert "backends: []" in result.stdout, result.stdout
