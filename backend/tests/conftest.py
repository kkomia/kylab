"""后端测试共享夹具。

工程规范 §5.2：集成测试使用**独立临时 SQLite 文件**（tmp 目录），禁止触碰开发库。

各测试目录都放了 ``__init__.py``：工程规范 §5.1 要求测试文件与被测模块镜像同构，
于是 ``unit`` 与 ``integration`` 下会出现同名 ``test_<模块>.py``；
不加包的话 pytest 会因 basename 冲突而报 "import file mismatch"。
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql as pgsql

from app.core.config import get_settings
from app.core.services import reset_services
from app.core.storage import reset_stores
from app.models.enums import DataSourceKind, DocumentStage
from app.services.model_registry import ModelRegistryService
from app.services.runtime_config import RuntimeConfigService
from app.storage.base import (
    DocumentRecord,
    FullTextStore,
    KnowledgeBaseRecord,
    MetaStore,
    StoreBundle,
    VectorStore,
)
from app.storage.duckdb_impl.tabular_store import DuckDbTabularStore
from app.storage.postgres_impl.fulltext_store import PostgresFullTextStore
from app.storage.postgres_impl.meta_store import PostgresMetaStore
from app.storage.postgres_impl.vector_store import PostgresVectorStore
from app.storage.sqlite_impl.connection import Database
from app.storage.sqlite_impl.fulltext_store import SqliteFullTextStore
from app.storage.sqlite_impl.meta_store import SqliteMetaStore
from app.storage.sqlite_impl.migrations import apply_migrations
from app.storage.sqlite_impl.object_store import LocalObjectStore
from app.storage.sqlite_impl.vector_store import SqliteVectorStore

DEFAULT_MODEL_ID = "BAAI/bge-m3"
DEFAULT_DIM = 1024

#: 提供它就打开"PG 后端的集成测试"。值是**维护库**的连接串（如 …/postgres），
#: 测试会用它建一个临时库、跑完删掉。指向带 pgvector 的 PG；建扩展需要超级用户。
PG_TEST_DSN_ENV = "KYLAB_TEST_DATABASE_URL"

#: 集成测试的管理员账号。**v0.11 起 /api/v1 一律要凭据**，所以每个 API 测试
#: 都要先走一遍产品上第一次打开的真实路径：setup 建管理员 → 拿会话令牌。
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "correct horse battery"


def login_admin(client) -> str:  # type: ignore[no-untyped-def]
    """首次初始化管理员并把会话令牌塞进 ``client.headers``，返回令牌。

    已经初始化过就退化成登录（同一个账号），所以对"每个测试一个临时库"与
    "同一个库跑多条用例"两种用法都成立。
    """
    from app.main import create_app  # noqa: F401  （保持与调用方一致的导入习惯）

    response = client.post(
        "/api/v1/auth/setup",
        json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD, "name": "管理员"}
    )
    if response.status_code == 409:
        # 已经建过管理员：改成登录
        response = client.post(
            "/api/v1/auth/login",
            json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD}
    )
    assert response.status_code == 200, response.text
    token = response.json()["token"]
    client.headers["Authorization"] = f"Bearer {token}"
    return token


@contextmanager
def admin_client():  # type: ignore[no-untyped-def]
    """带管理员会话凭据的 TestClient（上下文管理器，跑完整 lifespan）。

    想测"没有凭据会怎样"的用例请直接用裸 ``TestClient(create_app())``——
    那正是它们要覆盖的分支。
    """
    from app.main import create_app

    with TestClient(create_app()) as client:
        login_admin(client)
        yield client


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch, pg_database):
    """全局兜底：任何测试都不许把运行期数据写进仓库或**真实开发库**。

    起因：`build_stores()` 默认用 ``./data``，一旦某个测试忘了指临时目录，
    就会在 `backend/data/` 建出 kylab.db 与三个子目录（被 .gitignore 挡住所以不易发现，
    但会污染本地状态、干扰后续手工验证）。

    **数据库同理**：配了 ``KYLAB_TEST_DATABASE_URL`` 跑 PG 测试时，若不同时把应用的
    ``KYLAB_DATABASE_URL`` 指到临时测试库，``create_app()`` 会连上真名那个库
    （通常就是开发库）并把测试数据写进去。所以这里把它改指临时库；未配测试库时
    清掉该变量，让应用走 SQLite 回退路径。

    同时关掉内嵌任务消费者：测试要手动驱动 worker，才能对时序下断言。
    """
    monkeypatch.setenv("KYLAB_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("KYLAB_RUN_WORKER", "false")
    if pg_database is not None:
        monkeypatch.setenv("KYLAB_DATABASE_URL", pg_database.dsn)
        # 应用层用例（走 create_app）不经过 pg_stores 夹具，得在这里清一次库，
        # 否则上一个用例建的管理员/知识库会漏到下一个用例里
        _reset_database(pg_database)
    else:
        monkeypatch.delenv("KYLAB_DATABASE_URL", raising=False)
    # **测试绝不碰真实对象存储**：本机若导出过 KYLAB_S3_*（比如为了手工验证），
    # build_stores() 会真的往那个桶里写。这里一律清掉，需要对象存储的用例
    # 自己用 KYLAB_TEST_S3_* 显式构造（见 test_s3_object_store.py）。
    for name in ("KYLAB_S3_ENDPOINT", "KYLAB_S3_ACCESS_KEY", "KYLAB_S3_SECRET_KEY"):
        monkeypatch.delenv(name, raising=False)
    # 测试要一条**不联网**的向量化链路：显式打开开发用确定性嵌入。
    # v0.8 起它不再是"没配就自动兜底"，必须有人主动开——测试就是那个"人"。
    monkeypatch.setenv("KYLAB_DEV_EMBEDDING", "true")
    get_settings.cache_clear()
    reset_services()
    reset_stores()
    yield
    reset_services()
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


# ---------------------------------------------------------------- 存储后端切换
#
# 存储已迁到 PostgreSQL。测试默认仍跑 SQLite（回退分支还在，安全网），
# 配了 ``KYLAB_TEST_DATABASE_URL`` 就**整套**切到 PG。
#
# 切换只在这一层做，不让各测试文件各自覆盖同名夹具：那样容易只切一半
# （出现过"元数据在 SQLite、全文索引在 PG"的错配），也无从知道还有谁没切。
# 未配置 DSN 时 PG 夹具返回 None，一律退回 SQLite。


_RESET_SQL = """
do $$
declare
    r record;
    targets text;
begin
    -- 动态向量分区：只能 drop（TRUNCATE 清不掉"表"本身），索引随表一起走
    for r in
        select c.relname as name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = current_schema()
           and c.relkind = 'r'
           and starts_with(c.relname, 'vec_')
    loop
        execute format('drop table if exists %I', r.name);
    end loop;

    -- 固定业务表：一条 TRUNCATE 全清；**保留版本表**，清掉它应用会认为
    -- 库比基线还旧（current_version 返回 0），于是每个用例都起不来
    select string_agg(format('%I', table_name), ', ') into targets
      from information_schema.tables
     where table_schema = current_schema()
       and table_type = 'BASE TABLE'
       and table_name <> 'schema_migrations';
    if targets is not null then
        execute 'truncate table ' || targets || ' restart identity cascade';
    end if;
end $$;
"""
"""清库用**一条**语句完成。

拆成"查分区表 / 查全部表 / TRUNCATE"三次往返在本地 PG 上无所谓，
但在跨网络的 PG 上（测试机连远端库）每次往返都是实打实的延迟，
乘以每个用例一次就变成了分钟级浪费——压成一次是纯赚。
"""


def _reset_database(db) -> None:  # type: ignore[no-untyped-def]
    """清空一个 PG 库，让用例之间互不影响。"""
    with db.session() as conn:
        conn.execute(_RESET_SQL)


@pytest.fixture(scope="session")
def pg_database() -> Iterator[object | None]:
    """一个**独立的临时 PG 库**（建好 schema），跑完删除；未配置则 None。

    用独立库而不是开发库：测试要清空整库，绝不能落到开发数据上。
    """
    dsn = os.environ.get(PG_TEST_DSN_ENV)
    if not dsn:
        yield None
        return

    from app.storage.postgres_impl.connection import Database as PgDatabase
    from app.storage.postgres_impl.schema import prepare

    name = f"kylab_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(dsn, autocommit=True) as admin:
        admin.execute(pgsql.SQL("create database {}").format(pgsql.Identifier(name)))

    db = PgDatabase(psycopg.conninfo.make_conninfo(dsn, dbname=name))
    db.open()
    try:
        prepare(db)
        yield db
    finally:
        db.close()
        with psycopg.connect(dsn, autocommit=True) as admin:
            admin.execute(
                pgsql.SQL("drop database if exists {} with (force)").format(
                    pgsql.Identifier(name)
                )
            )


@pytest.fixture
def pg_stores(pg_database) -> Iterator[object | None]:
    """清空 PG 库（用例隔离）后把连接交出去；未配置 PG 时为 None。

    **只在这里清库一次**，各仓储夹具共用它。做成一堆"各自清库"的夹具会出问题：
    一个用例同时要几个仓储时，后构造的那个会把先建的数据清掉。
    """
    if pg_database is None:
        yield None
        return
    _reset_database(pg_database)
    yield pg_database


@pytest.fixture
def db_file(database: Database) -> Path:
    """数据库文件的真实路径。

    给"必须绕过仓储接口"的测试用：例如模拟另一个进程抢走任务租约——
    仓储接口都带 owner 校验，正因如此它没法自己制造出"租约易主"这个状态。
    """
    return Path(database.path)


@pytest.fixture
def store(pg_stores, database: Database) -> MetaStore:
    """元数据仓储：配了 PG 就跑 PG，否则 SQLite。"""
    if pg_stores is not None:
        return PostgresMetaStore(pg_stores)
    return SqliteMetaStore(database)


@pytest.fixture
def vector_store(pg_stores, database: Database) -> VectorStore:
    if pg_stores is not None:
        return PostgresVectorStore(pg_stores)
    return SqliteVectorStore(database)


@pytest.fixture
def fulltext_store(pg_stores, database: Database) -> FullTextStore:
    if pg_stores is not None:
        return PostgresFullTextStore(pg_stores)
    return SqliteFullTextStore(database)


@pytest.fixture
def object_store(tmp_path) -> LocalObjectStore:
    """对象存储根目录用临时目录，绝不写进仓库的 data/。"""
    return LocalObjectStore(tmp_path / "data")


@pytest.fixture
def tabular_store(tmp_path) -> DuckDbTabularStore:
    """表格副本库用临时文件，绝不写进仓库的 data/。"""
    return DuckDbTabularStore(tmp_path / "tabular.duckdb")


@pytest.fixture
def bundle(
    store: MetaStore,
    vector_store: VectorStore,
    fulltext_store: FullTextStore,
    object_store: LocalObjectStore,
    tabular_store: DuckDbTabularStore,
) -> StoreBundle:
    """五个仓储的装配（与组合根同构，但不碰磁盘上的开发库）。

    直接复用上面那几个夹具，而不是自己再 new 一遍实现：那样才能跟着
    "配了 DSN 就整套切 PG"一起走，也不会出现同一用例里两个不同的库。
    """
    return StoreBundle(
        meta=store,
        vectors=vector_store,
        fulltext=fulltext_store,
        objects=object_store,
        tabular=tabular_store,
    )


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
            size_bytes=128
    )
    )

