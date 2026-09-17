"""PG schema 的创建与校验（v0.12）。

本次迁移**不做数据迁移**（旧 SQLite 库直接舍弃），所以没有"24 条增量迁移要重放"
这件事：``schema.sql`` 就是第 1 版基线，之后的演进往 ``MIGRATIONS`` 里追加、
由启动时的 ``ensure_schema`` 自动应用（不需要人工 psql——DDL 的唯一属主是应用）。

职责边界：DDL 的**唯一属主是应用**。启动时由这里负责建 schema / 校验版本，
不依赖容器 initdb 脚本或人工 psql（那会造出第二个真相来源）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import psycopg

from app.storage.postgres_impl.connection import Database

logger = logging.getLogger(__name__)

SCHEMA_PATH = Path(__file__).with_name("schema.sql")

BASELINE_VERSION = 1
"""``schema.sql`` 对应的版本号，与文件末尾写入 schema_migrations 的值一致。"""

SCHEMA_VERSION = 8
"""应用期望的 schema 版本：基线 v1 + ``MIGRATIONS`` 里已追加的增量。

**启动时会对不上就自动补**：低于它就按序应用缺的那些迁移，高于它才报错
（库被更新版应用升过级）。这与"库比基线还旧"是两码事——后者要人工处理。"""


@dataclass(frozen=True, slots=True)
class Migration:
    """一条增量迁移。**只增不改**：已经发布的条目一律不许改字面量。"""

    version: int
    description: str
    statements: tuple[str, ...]


MIGRATIONS: tuple[Migration, ...] = (
    Migration(
        version=2,
        description="文档阶段事件：记录每次进入某阶段的时间，用于进度时间线（v24）",
        statements=(
            # 时间线的数据源。为什么另存事件而不是给 documents 加几个时间戳列：
            # 阶段会**重复进入**（失败重试、重新摄入、取消后重跑），一行时间戳
            # 存不下历史；而"每个环节各花多久"正是要看相邻两次进入的间隔。
            """
            CREATE TABLE document_stage_events (
                id          bigserial PRIMARY KEY,
                document_id text NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
                stage       text NOT NULL,
                entered_at  timestamptz NOT NULL DEFAULT now(),
                error       text
            )
            """,
            # 时间线永远按"某文档、先后顺序"读，所以索引带上 id 而不是只 document_id：
            # entered_at 可能同微秒，id 才是稳定的先后关系。
            "CREATE INDEX idx_document_stage_events_doc ON document_stage_events (document_id, id)",
        ),
    ),
    Migration(
        version=3,
        description="补三条索引：云端额度统计、阶段事件清理、任务状态聚合（v24 性能审阅）",
        statements=(
            # ① 云端额度统计（负载面板每 2 秒问一次）按 (parser_name, created_at) 过滤，
            #    而 parse_results 原来只有 (document_id, part_id) 主键 —— 那是**全表扫**。
            #    实测这条查询的代价随"解析过的文件数"线性涨，而它跑在每次面板轮询上。
            "CREATE INDEX idx_parse_results_parser_created"
            " ON parse_results (parser_name, created_at)",
            # ② 阶段事件表只增不减（每次重试/重新摄入都追加），要按时间做保留期清理，
            #    没有 entered_at 索引时那条 DELETE 也是全表扫。
            "CREATE INDEX idx_document_stage_events_entered"
            " ON document_stage_events (entered_at)",
            # ③ 队列深度改成一条 `GROUP BY state, kind` 聚合（不再把整表行搬到 Python）；
            #    这个索引让那次聚合走 index-only scan，不必读堆里的每一行。
            "CREATE INDEX idx_tasks_state_kind ON tasks (state, kind)",
        ),
    ),
    Migration(
        version=4,
        description="文档摘要：入库时生成一段紧凑摘要，供问答上下文与界面复用（v25）",
        statements=(
            # 摘要存在的**唯一理由**是省 token：命中 6 段资料时，把每段"所在小节"
            # 整段塞给模型要上万字；有了每篇文档的摘要，就能只带摘要 + 更短的片段，
            # 模型仍然知道"这几段来自一篇讲什么的文档"。见 services/summary.py。
            "ALTER TABLE documents ADD COLUMN summary text NOT NULL DEFAULT ''",
        ),
    ),
    Migration(
        version=5,
        description="工作区（Agent 的项目）：会话挂到工作区下，知识库范围跟着工作区走（v0.15）",
        statements=(
            # 工作区 = Agent 的"在哪干活"。`root_path` 是用户指定的真实目录
            # （见 docs/Agent-工作区与能力层设计-v0.1.md §3.2）。沙箱与它是两个概念，
            # 所以这里**没有** sandbox 字段。
            """
            CREATE TABLE workspaces (
                id          text PRIMARY KEY,
                owner_id    text,
                name        text NOT NULL,
                root_path   text NOT NULL,
                description text NOT NULL DEFAULT '',
                kb_ids      jsonb NOT NULL DEFAULT '[]'::jsonb,
                created_at  timestamptz NOT NULL DEFAULT now(),
                updated_at  timestamptz NOT NULL DEFAULT now()
            )
            """,
            "CREATE INDEX idx_workspaces_owner ON workspaces (owner_id, updated_at DESC)",
            # `ON DELETE SET NULL` 是刻意的：删工作区**不该删掉里面的会话**。
            # 会话里有用户问过的内容，误删无法恢复；失去归属只是"掉回未归档那一栏"。
            """
            ALTER TABLE conversations
                ADD COLUMN workspace_id text REFERENCES workspaces (id) ON DELETE SET NULL
            """,
            # 侧栏按工作区分组拉会话，这条索引直接服务那个查询
            """
            CREATE INDEX idx_conversations_workspace
                ON conversations (workspace_id, pinned DESC, updated_at DESC)
            """,
        ),
    ),
    Migration(
        version=6,
        description="MCP 服务登记：接外部工具进来（v0.15，见 Agent-工作区与能力层设计 §6.2）",
        statements=(
            # 在此之前 KYLAB 只做 MCP **服务端**；这张表是客户端的一半。
            # `policy` 默认 `ask`：接一个外部服务进来就默认让它静默执行动作，
            # 是这一层最不该有的默认（QwenPaw 的 Drivers 也是"每次调用过策略闸"）。
            """
            CREATE TABLE mcp_servers (
                id         text PRIMARY KEY,
                owner_id   text,
                name       text NOT NULL,
                transport  text NOT NULL,
                target     text NOT NULL,
                args       jsonb NOT NULL DEFAULT '[]'::jsonb,
                env        jsonb NOT NULL DEFAULT '{}'::jsonb,
                headers    jsonb NOT NULL DEFAULT '{}'::jsonb,
                policy     text NOT NULL DEFAULT 'ask',
                enabled    boolean NOT NULL DEFAULT true,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """,
            "CREATE INDEX idx_mcp_servers_owner ON mcp_servers (owner_id, updated_at DESC)",
        ),
    ),
    Migration(
        version=7,
        description="会话归档：把不看了的会话收起来，而不是删掉（v0.17，照 Kimi 的历史会话）",
        statements=(
            # 用**时间戳**而不是布尔：归档这件事"什么时候做的"本身有用
            # （归档视图按它排序），而布尔还得再加一列才行。
            # `NULL` = 未归档，这也是默认值——存量会话全部落在"未归档"里。
            "ALTER TABLE conversations ADD COLUMN archived_at timestamptz",
            # 列表默认 `archived_at IS NULL`，这条索引直接服务它
            """
            CREATE INDEX idx_conversations_archived
                ON conversations (archived_at, pinned DESC, updated_at DESC)
            """,
        ),
    ),
    Migration(
        version=8,
        description="知识库提示词：回答这个库的问题时该怎么答，从对话页搬到库上（v0.19）",
        statements=(
            # **空串 = 用内置提示词**（`services/chat.build_messages` 在空的时候会退回
            # `DEFAULT_SYSTEM_PROMPT`）。存量库全部落在"没配过"这一档，
            # 行为与迁移前一致——这条迁移不该让任何一个既有库的答案变样。
            "ALTER TABLE knowledge_bases ADD COLUMN system_prompt text NOT NULL DEFAULT ''",
        ),
    ),
)


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
    if version > SCHEMA_VERSION:
        raise SchemaError(
            f"schema 版本为 {version}，高于本应用已知的 {SCHEMA_VERSION}；"
            "库是被更新版应用升过级的，请升级应用而不是降级数据库"
        )
    return _apply_migrations(db, version)


def _apply_migrations(db: Database, version: int) -> int:
    """把缺的增量迁移按序补上，返回补完后的版本。

    **每条一个事务、并把版本号写在同一事务里**：DDL 在中途失败时要么整条生效、
    要么整条回滚，不会留下"表建了但版本没记"的半截状态（下一轮启动会重跑它）。
    这也让并发启动的多个副本天然安全——两个进程同时补同一条时，先提交的那个赢，
    后一个会因为版本已推进而在下一轮跳过（`schema_migrations` 的主键还会挡住重复写入）。
    """
    pending = [item for item in MIGRATIONS if item.version > version]
    for item in pending:
        try:
            with db.session() as conn:
                for statement in item.statements:
                    conn.execute(statement)
                conn.execute(
                    "INSERT INTO schema_migrations (version, description) VALUES (%s, %s)",
                    (item.version, item.description),
                )
        except Exception as exc:
            raise SchemaError(
                f"增量迁移 v{item.version}（{item.description}）执行失败：{exc}"
            ) from exc
        logger.info("已应用增量迁移 v%d：%s", item.version, item.description)
    return current_version(db) if pending else version


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
