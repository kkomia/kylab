"""PG schema 的创建与校验（v0.12）。

本次迁移**不做数据迁移**（旧 SQLite 库直接舍弃），所以没有"24 条增量迁移要重放"
这件事：``schema.sql`` 就是第 1 版基线，之后的演进再往 ``MIGRATIONS`` 里追加。

职责边界：DDL 的**唯一属主是应用**。启动时由这里负责建 schema / 校验版本，
不依赖容器 initdb 脚本或人工 psql（那会造出第二个真相来源）。
"""

from __future__ import annotations

from pathlib import Path

import psycopg

from app.storage.postgres_impl.connection import Database

SCHEMA_PATH = Path(__file__).with_name("schema.sql")

BASELINE_VERSION = 1
"""``schema.sql`` 对应的版本号，与文件末尾写入 schema_migrations 的值一致。"""

REQUIRED_EXTENSIONS = ("vector",)
"""启用项目功能所必需的扩展。缺失时**启动即失败**并给出可操作的提示——
pgvector 不是 PG 自带扩展，用错镜像就会缺，这是本次切换最容易踩的坑。"""

_MISSING_VECTOR_HINT = (
    "数据库缺少 pgvector 扩展（vector）。请改用自带它的镜像，"
    "例如 pgvector/pgvector:pg17-trixie 或 paradedb/paradedb:v0.22.2-pg17；"
    "若 PG 是本机安装的，需要先装扩展文件再执行 CREATE EXTENSION vector。"
)


class SchemaError(RuntimeError):
    """schema 无法满足应用要求（缺扩展、版本不符、基线 DDL 执行失败）。"""


def current_version(db: Database) -> int | None:
    """库当前的 schema 版本。

    三种情况要分清（混起来会让"库状态不完整"被误当成"空库"而重跑建表）：

    - ``None`` —— 连 ``schema_migrations`` 表都没有，是全新库，可以建基线；
    - ``0``    —— 表在但一行版本记录都没有：不完整状态，比任何基线都低；
    - ``n``    —— 正常版本号。
    """
    with db.read() as conn:
        row = conn.execute("select to_regclass('public.schema_migrations') as t").fetchone()
        if row is None or row["t"] is None:
            return None
        version = conn.execute("select max(version) as v from schema_migrations").fetchone()
        if version is None or version["v"] is None:
            return 0
        return version["v"]


def ensure_schema(db: Database) -> int:
    """确保 schema 就位；返回当前版本。

    空库 → 执行基线 DDL；已有 schema → 校验版本不低于基线。**不降级、不乱改**：
    版本比应用期望的还新（说明库被更新版应用升过）同样报错，避免旧代码写新结构。
    """
    version = current_version(db)

    if version is None:
        ddl = SCHEMA_PATH.read_text(encoding="utf-8")
        try:
            with db.session() as conn:
                # schema.sql 是无参数多语句脚本，psycopg 会用简单查询协议整段执行
                conn.execute(ddl)
        except psycopg.errors.UndefinedFile as exc:
            # 58P01：扩展的控制文件不在磁盘上——镜像里根本没带 pgvector。
            # 这是本次切换最常见的一种部署错误，单独给一句可操作的提示。
            raise SchemaError(f"基线 schema 执行失败：{exc}\n{_MISSING_VECTOR_HINT}") from exc
        except Exception as exc:
            raise SchemaError(f"基线 schema 执行失败：{exc}") from exc
        version = current_version(db)

    if version is None or version < BASELINE_VERSION:
        raise SchemaError(
            f"schema 版本为 {version}，低于应用要求的基线 {BASELINE_VERSION}；"
            "请执行 backend/app/storage/postgres_impl/schema.sql"
        )
    if version > BASELINE_VERSION:
        raise SchemaError(
            f"schema 版本为 {version}，高于本应用已知的 {BASELINE_VERSION}；"
            "库是被更新版应用升过级的，请升级应用而不是降级数据库"
        )
    return version


def check_extensions(db: Database) -> None:
    """必需的扩展是否已启用。缺了就抛，不降级运行。

    **只在 schema 之后调用**：``CREATE EXTENSION vector`` 就在基线 DDL 里，
    所以"新库还没有扩展"是正常中间态，不是错误。要在 ensure_schema 之后
    才检查，否则全新数据库会被误判成"缺扩展"。

    **不在这里补 CREATE EXTENSION**：那需要超级用户；部署若用非超级用户跑应用，
    悄悄尝试只会留下半截状态。缺扩展时把"该换镜像还是该装扩展"说清楚就够了。
    """
    with db.read() as conn:
        rows = conn.execute(
            "select extname from pg_extension where extname = any(%s)",
            (list(REQUIRED_EXTENSIONS),),
        ).fetchall()
    installed = {row["extname"] for row in rows}
    missing = [name for name in REQUIRED_EXTENSIONS if name not in installed]
    if missing:
        raise SchemaError(
            f"缺少扩展 {missing}。" + (_MISSING_VECTOR_HINT if "vector" in missing else "")
        )


def prepare(db: Database) -> int:
    """装配时的门面：建/校验 schema → 校验扩展。返回当前版本。

    **顺序不能反**（踩过）：基线 DDL 里含 ``CREATE EXTENSION IF NOT EXISTS vector``，
    所以必须先让它跑完再检查扩展，否则空库会被误报成"缺少 vector"。
    """
    version = ensure_schema(db)
    check_extensions(db)
    return version
