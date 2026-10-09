"""后端测试共享夹具。

工程规范 §5.2：测试用**独立临时的库**，禁止触碰开发库。这个后端只有本机一种形态，
所以"临时的库"就是本机 SQLite——``isolated_data_dir`` 把每个用例的 ``KYLAB_DATA_DIR``
指到 ``tmp_path``，库与对象存储因此都落在那里，跑完随临时目录一起消失。

各测试目录都放了 ``__init__.py``：工程规范 §5.1 要求测试文件与被测模块镜像同构，
于是 ``unit`` 与 ``integration`` 下会出现同名 ``test_<模块>.py``；
不加包的话 pytest 会因 basename 冲突而报 "import file mismatch"。
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.services import reset_services
from app.core.storage import reset_stores
from app.services.llm import ChatError, LLMDelta, LLMReply, ToolCallDelta
from app.services.memory import reset_instances as reset_memory_instances
from app.services.model_registry import ModelRegistryService
from app.services.runtime_config import RuntimeConfigService
from app.storage.base import StoreBundle
from app.storage.local_impl.object_store import LocalObjectStore
from app.storage.split_impl import (
    RemoteMetaStore,
    RouterMetaStore,
    UnavailableFullTextStore,
    UnavailableTabularStore,
    UnavailableVectorStore,
)
from app.storage.sqlite_impl.connection import Database as SqliteDatabase
from app.storage.sqlite_impl.meta_store import SqliteMetaStore
from app.storage.sqlite_impl.schema import prepare as prepare_sqlite_schema

DEFAULT_MODEL_ID = "BAAI/bge-m3"
DEFAULT_DIM = 1024

#: 测试的管理员身份。本机后端**不设门禁**（能打到这个端口的就是主人），
#: 所以它只需要构造出来给服务层那些"按 caller 判归属"的分支用。
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "correct horse battery"


@pytest.fixture
def sqlite_db(tmp_path) -> Iterator[SqliteDatabase]:
    """本机那个库的**连接对象**（建好 schema）。

    只给"要直接问数据库"的用例用（例如外键的 ``ON DELETE`` 语义——那是**表定义上**
    的保证，不是某条代码路径的行为，所以只能对着表问）。其余用例一律走仓储接口：
    "services 只依赖接口"这条纪律在测试里同样成立，否则抽象就白做了。
    """
    db = SqliteDatabase(tmp_path / "kylab.db")
    prepare_sqlite_schema(db)
    try:
        yield db
    finally:
        db.close()


@pytest.fixture
def bundle(sqlite_db, tmp_path) -> StoreBundle:
    """一套**本机**仓储（SQLite 元数据 + 三个"不可用" + 本地目录对象存储）。

    与组合根同构（``core/storage.py::_build_local_stores``），但不碰磁盘上的开发库：
    库文件与对象存储都在 ``tmp_path`` 里。

    向量 / 全文 / 表格给的是"不可用"实现——本机不持有那三份数据，调用它们会如实抛
    ``KnowledgeBaseUnavailable``。七个字段里的元数据那五个（``ledger`` / ``kb_cache`` /
    ``snapshot`` / ``backup_queue`` / ``eraser``）指向**同一个** ``SqliteMetaStore``
    实例，与组合根一致（"写锁是进程内一把"这条纪律是对着 ``Database`` 说的）。
    """
    store = SqliteMetaStore(sqlite_db)
    return StoreBundle(
        # 与组合根同构（`core/storage.py::_build_local_stores`）：本机域的库元数据走
        # SQLite，KB 域的读转给 `RemoteMetaStore`（reader 由服务层装配时后挂）。
        meta=RouterMetaStore(local=store, kb=RemoteMetaStore()),
        vectors=UnavailableVectorStore(),
        fulltext=UnavailableFullTextStore(),
        objects=LocalObjectStore(tmp_path / "data"),
        tabular=UnavailableTabularStore(),
        ledger=store,
        kb_cache=store,
        snapshot=store,
        backup_queue=store,
        eraser=store,
    )


@pytest.fixture
def object_store(tmp_path) -> LocalObjectStore:
    """对象存储根目录用临时目录，绝不写进仓库的 data/。"""
    return LocalObjectStore(tmp_path / "data")


@pytest.fixture
def runtime(bundle: StoreBundle) -> RuntimeConfigService:
    """运行期配置（行为参数）读写器。

    不传 Settings（``.env`` 引导值）——单测要的是"只有代码默认值"这个干净起点，
    需要测引导优先级时再显式构造带 Settings 的实例。

    **带上注册表**：与组合根同构（v0.8 起模型身份只从注册表取），
    这样用例可以直接用下面的 ``bind_slot`` 造出"模型已配好"的状态。
    """
    return RuntimeConfigService(bundle, registry=ModelRegistryService(bundle))


#: 用途 → 供应商类别。注册供应商时要选一个类别，测试里按用途推出来就够了。
_KIND_BY_SLOT = {"chat": "llm", "embedding": "embedding", "rerank": "rerank"}


def bind_model(
    registry: ModelRegistryService,
    slot: str,
    *,
    model_id: str,
    capabilities: list[str],
    dim: int | None = None,
    api_key: str = "sk-fake",
    base_url: str = "https://api.example.com/v1"
    ):  # type: ignore[no-untyped-def]
    """登记一个模型并绑到某个用途——测试里"模型已配好"的唯一入口。

    v0.8 起模型身份（地址 / 密钥 / 模型名 / 维度）只来自注册表，
    所以"配好了没"不能再靠往 ``app_settings`` 里写 ``llm.api_key`` 来伪造。
    """
    provider = registry.create_provider(
        kind=_KIND_BY_SLOT[slot], name="测试供应商", base_url=base_url, api_key=api_key
    )
    model = registry.register_model(
        provider_id=provider.id,
        model_id=model_id,
        dim=dim,
        capabilities=capabilities
    )
    registry.bind(slot, model.id)
    return model


@pytest.fixture
def bind_slot(bundle: StoreBundle):  # type: ignore[no-untyped-def]
    """``bind_model`` 的夹具形态：省掉每次自己造 ``ModelRegistryService``。"""

    def _bind(slot: str, **kwargs: object):  # type: ignore[no-untyped-def]
        return bind_model(ModelRegistryService(bundle), slot, **kwargs)  # type: ignore[arg-type]

    return _bind


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch, request):
    """全局兜底：任何测试都不许把运行期数据写进仓库或**真实开发库**。

    起因：``build_stores()`` 默认用 ``./data``，一旦某个测试忘了指临时目录，
    就会在 `backend/data/` 建出运行时文件（被 .gitignore 挡住所以不易发现，
    但会污染本地状态、干扰后续手工验证）。这里统一把它指到 ``tmp_path``。

    同时关掉内嵌消费者：测试要手动驱动它，才能对时序下断言。
    """
    monkeypatch.setenv("KYLAB_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("KYLAB_RUN_WORKER", "false")
    # **测试绝不碰真实对象存储**：本机若配了 KYLAB_S3_*（比如为了手工验证）会被忽略，
    # 但它们已经不在 Settings 里了；这几行留着的意义是让"环境里还有旧配置"这件事
    # 在测试进程里也不可能影响结果（Settings 是 extra="ignore"）。
    #
    # 测试要一条**不联网**的向量化链路：显式打开开发用确定性嵌入。
    # v0.8 起它不再是"没配就自动兜底"，必须有人主动开——测试就是那个"人"。
    monkeypatch.setenv("KYLAB_DEV_EMBEDDING", "true")
    # 让 teardown 把边车那条路改过的环境变量恢复回来（`pin_local_deployment` 直接改
    # os.environ）：不登记的话，一次 `sidecar.create_app()` 之后**整个测试进程**都被
    # 指向那个临时目录，后面的用例会莫名其妙地读写别人的库。
    for name in ("KYLAB_SERVER_URL", "KYLAB_TOKEN", "KYLAB_DEVICE_ID"):
        monkeypatch.setenv(name, os.environ.get(name, ""))
    get_settings.cache_clear()
    reset_services()
    reset_stores()
    # **记忆库也要放掉**：mem0 的实例持有本地 qdrant 的**文件锁**（一个进程只能有一个），
    # 而每个用例的 `tmp_path` 都不同——不关的话，一次全量要留下几百个打开的文件句柄，
    # Windows 上还会让临时目录删不掉（`PermissionError`）。
    reset_memory_instances()
    yield
    reset_services()
    reset_stores()
    reset_memory_instances()
    get_settings.cache_clear()


@pytest.fixture
def local_client(tmp_path, monkeypatch) -> Iterator[TestClient]:
    """本机后端的 HTTP 客户端（**不登录**）。

    它就是一个真的后端：`app.main.create_app()` + 本机 SQLite（`tmp_path`）+ 本机目录，
    与桌面壳里那条链是**同一张路由表**（见 `api/v1/router.py`）。

    为什么不登录：这一档没有账号体系——调用主体恒为"本机主人"
    （`api/auth.py::current_caller`），`/auth/*` 那张表上根本没挂。所以它不带任何
    ``Authorization``，带了也不会被当成另一种身份。
    """
    from app.main import create_app

    with TestClient(create_app()) as client:
        yield client
    reset_services()
    reset_stores()
    get_settings.cache_clear()


@pytest.fixture
def fake_local_chat(local_client) -> FakeChatModel:
    """在本机后端的服务图里装一个**假对话模型**（不打网络）。

    必须**依赖** `local_client`：那个夹具会建/拆服务图，先装的话会被它抹掉
    （顺序反了的表现是"模型又变回没配"，看着像用例写错了）。
    """
    return install_fake_chat()


@contextmanager
def admin_client():  # type: ignore[no-untyped-def]
    """带 lifespan 的 TestClient（上下文管理器）。

    名字沿用历史（那时它要插管理员凭据）；本机后端不设门禁，所以它只是
    "跑完整个 lifespan 的客户端"——需要 lifespan 的用例（启动铺记忆模板、
    迁移旧取值、拉起消费者）用这个。
    """
    from app.main import create_app

    with TestClient(create_app()) as client:
        yield client


# --------------------------------------------------------------------- 假模型
#
# **只有这一份**：对话链路换了协议（P0 起走原生工具调用）之后，三个集成测试文件
# 各自那份假模型同时失效——它们都只实现了旧协议的方法，于是整条链路在
# "对象没有 complete_with_tools"上失败，而报错长得像被测代码坏了。
# 协议再变时只改这里。


class FakeChatModel:
    """假的对话模型：不打网络，按字符吐正文。

    ``stream_events`` 是工具循环真正会调的那一个（``services/tool_loop.py``）：
    **每一步都是一次流式调用**（v0.40 起），剧本就在这里消费——
    给了 ``script`` 就按顺序取用（哪一步要工具就吐工具调用碎片），
    没给就一直吐 ``answer``，于是循环直接进入作答。

    ``complete`` / ``stream`` 留给还没换框架的旁路（编排、摘要一类）。
    """

    def __init__(
        self,
        answer: str = "这是回答。[1]",
        error: str | Exception | None = None,
        script: list[LLMReply] | None = None,
    ) -> None:
        self.answer = answer
        # 给字符串就当成"模型失败了"的那句话（真实失败是 `ChatError`）；
        # 给异常实例就原样抛（测更底层的失败时用）
        self.error = ChatError(error) if isinstance(error, str) else error
        self._script = list(script or [])
        #: 最近一次拿到的工具名（用例据此断言"该给的工具都给了"）
        self.seen_tools: list[str] = []
        #: **最近一次**拿到的消息。用例据此断言提示词里有什么（当前模式、
        #: 命令渲染出来的正文……）——留最后一次的那一份：工具循环里消息是逐步
        #: 加长的，最后那次带的是最全的一版。
        self.seen_messages: list = []  # type: ignore[type-arg]

    def complete(self, messages):  # type: ignore[no-untyped-def]
        self.seen_messages = list(messages)
        if self.error:
            raise self.error
        return self.answer

    def stream(self, messages):  # type: ignore[no-untyped-def]
        self.seen_messages = list(messages)
        if self.error:
            raise self.error
        yield from self.answer

    def stream_events(self, messages, tools=None):  # type: ignore[no-untyped-def]
        """**每一步都是一次流式调用**（v0.40），剧本在这里消费。

        哪一步要工具就吐那一批工具调用的碎片（真实端点会把一个参数切成几十块，
        这里一块给完——"切几块"是传输细节，用例要表达的是"这一步要调什么"）。
        """
        self.seen_tools = [item.name for item in (tools or [])]
        self.seen_messages = list(messages)
        if self.error:
            raise self.error
        reply = self._script.pop(0) if self._script else None
        if reply is not None:
            if reply.reasoning:
                yield LLMDelta(reasoning=reply.reasoning)
            for index, call in enumerate(reply.tool_calls):
                yield LLMDelta(
                    tool_calls=(
                        ToolCallDelta(
                            index=index, id=call.id, name=call.name, arguments=call.arguments
                        ),
                    )
                )
            if reply.tool_calls:
                return
        for char in self.answer:
            yield LLMDelta(text=char)


def install_fake_chat(
    answer: str = "这是回答。[1]",
    *,
    error: str | Exception | None = None,
    script: list[LLMReply] | None = None,
) -> FakeChatModel:
    """把 ChatService 的模型工厂换成假的，返回那个实例。

    **同一个实例被复用**（工厂每次返回它）：工具循环一轮里会多次向模型提问，
    工厂若每次新建一个，``script`` 就会被从头重放——表现是"模型不停地调同一个工具"，
    而那看起来像循环的 bug。
    """
    from app.core.services import get_services

    services = get_services()
    bind_model(services.models, "chat", model_id="fake-model", capabilities=["chat"])
    chat = FakeChatModel(answer, error, script)
    services.chat._chat_factory = lambda config: chat
    return chat
