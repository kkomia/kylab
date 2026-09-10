"""Schema 迁移（M1 T1.2 / T1.3）。

约定：

- 迁移**顺序执行、幂等**，重复调用只应用缺失的版本；
- 每个迁移是一组独立语句（不切分 SQL 脚本，避免脆弱的分号解析），整体在一个事务里；
- 已应用的迁移**只增不改**：改表结构请追加新的迁移，不要修改历史迁移——这与仓库文档的
  「已提交即冻结」是同一个道理，否则老库升级会与新库结构分叉。

向量分区（``vec_<kb_id>``）不在迁移里建：维度是每个知识库的属性，
由 ``VectorStore.ensure_partition(kb_id, dim)`` 在知识库创建时动态建立（见 ``base.py`` 的说明）。
"""

from __future__ import annotations

import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime


@dataclass(frozen=True, slots=True)
class Migration:
    """一个 schema 版本。"""

    version: int
    description: str
    statements: tuple[str, ...]


_MIGRATION_001 = Migration(
    version=1,
    description="初始 schema：核心表结构、任务队列与全文索引",
    statements=(
        # ---------------------------------------------------------------- 知识库
        """
        CREATE TABLE knowledge_bases (
            id                  TEXT PRIMARY KEY,
            name                TEXT NOT NULL,
            embedding_model_id  TEXT NOT NULL,
            embedding_dim       INTEGER NOT NULL CHECK (embedding_dim > 0),
            embedding_base_url  TEXT,
            chunk_strategy      TEXT NOT NULL DEFAULT 'fixed',
            chunk_size          INTEGER NOT NULL DEFAULT 512 CHECK (chunk_size > 0),
            chunk_overlap       INTEGER NOT NULL DEFAULT 64 CHECK (chunk_overlap >= 0),
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL
        )
        """,
        # ---------------------------------------------------------------- 文档
        # UNIQUE(knowledge_base_id, content_hash) 就是架构 §6.3 的文件级去重承诺：
        # 同一库内相同内容只保留一份，重复上传由应用层转成"检测到相同文件"提醒。
        """
        CREATE TABLE documents (
            id                  TEXT PRIMARY KEY,
            knowledge_base_id   TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            name                TEXT NOT NULL,
            source_kind         TEXT NOT NULL,
            content_hash        TEXT NOT NULL,
            stage               TEXT NOT NULL,
            size_bytes          INTEGER NOT NULL DEFAULT 0,
            mime_type           TEXT,
            page_count          INTEGER,
            is_split            INTEGER NOT NULL DEFAULT 0 CHECK (is_split IN (0, 1)),
            error               TEXT,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            UNIQUE (knowledge_base_id, content_hash)
        )
        """,
        "CREATE INDEX idx_documents_kb ON documents(knowledge_base_id, created_at DESC)",
        "CREATE INDEX idx_documents_stage ON documents(stage)",
        # ---------------------------------------------------------------- 子文件（大文件切分）
        """
        CREATE TABLE document_parts (
            id          TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            part_index  INTEGER NOT NULL,
            page_start  INTEGER NOT NULL,
            page_end    INTEGER NOT NULL,
            stage       TEXT NOT NULL,
            error       TEXT,
            UNIQUE (document_id, part_index),
            CHECK (page_end >= page_start)
        )
        """,
        # ---------------------------------------------------------------- chunk
        """
        CREATE TABLE chunks (
            chunk_id            TEXT PRIMARY KEY,
            document_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            knowledge_base_id   TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            part_id             TEXT REFERENCES document_parts(id) ON DELETE SET NULL,
            ordinal             INTEGER NOT NULL,
            text                TEXT NOT NULL,
            content_hash        TEXT NOT NULL,
            heading_path        TEXT,
            page                INTEGER,
            UNIQUE (document_id, ordinal)
        )
        """,
        "CREATE INDEX idx_chunks_document ON chunks(document_id, ordinal)",
        "CREATE INDEX idx_chunks_kb ON chunks(knowledge_base_id)",
        # chunk ↔ 图片锚点（架构 §7：图片不入向量库，只记位置）
        """
        CREATE TABLE chunk_images (
            chunk_id TEXT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
            image_id TEXT NOT NULL,
            PRIMARY KEY (chunk_id, image_id)
        )
        """,
        # ---------------------------------------------------------------- 图片
        """
        CREATE TABLE images (
            image_id     TEXT PRIMARY KEY,
            document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            storage_path TEXT NOT NULL,
            page         INTEGER,
            bbox         TEXT,
            caption      TEXT
        )
        """,
        # ---------------------------------------------------------------- 解析产物
        # part_id 用 '' 而非 NULL 参与主键：SQLite 里 NULL 互不相等，会让唯一约束形同虚设。
        """
        CREATE TABLE parse_results (
            document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            part_id       TEXT NOT NULL DEFAULT '',
            parser_name   TEXT NOT NULL,
            markdown_path TEXT NOT NULL,
            probe_meta    TEXT NOT NULL DEFAULT '{}',
            created_at    TEXT NOT NULL,
            PRIMARY KEY (document_id, part_id)
        )
        """,
        # ---------------------------------------------------------------- 任务队列
        # 租约字段支撑"进程崩溃后超时回收 → 断点续跑"（架构 §4）。
        """
        CREATE TABLE tasks (
            id               TEXT PRIMARY KEY,
            kind             TEXT NOT NULL,
            state            TEXT NOT NULL,
            payload          TEXT NOT NULL DEFAULT '{}',
            document_id      TEXT REFERENCES documents(id) ON DELETE CASCADE,
            part_id          TEXT,
            attempts         INTEGER NOT NULL DEFAULT 0,
            max_attempts     INTEGER NOT NULL DEFAULT 5,
            lease_owner      TEXT,
            lease_expires_at TEXT,
            next_run_at      TEXT,
            error            TEXT,
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL
        )
        """,
        "CREATE INDEX idx_tasks_claim ON tasks(state, next_run_at)",
        "CREATE INDEX idx_tasks_document ON tasks(document_id)",
        # ---------------------------------------------------------------- 数据源
        """
        CREATE TABLE data_sources (
            id                TEXT PRIMARY KEY,
            knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            kind              TEXT NOT NULL,
            name              TEXT NOT NULL,
            config            TEXT NOT NULL DEFAULT '{}',
            etag              TEXT,
            last_pulled_at    TEXT,
            enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
        )
        """,
        # ---------------------------------------------------------------- 凭据
        # 只存 key 的哈希：明文永不落库（架构 §3.2）。
        """
        CREATE TABLE api_keys (
            id                 TEXT PRIMARY KEY,
            name               TEXT NOT NULL,
            key_hash           TEXT NOT NULL UNIQUE,
            permission         TEXT NOT NULL,
            knowledge_base_ids TEXT NOT NULL DEFAULT '[]',
            created_at         TEXT NOT NULL,
            last_used_at       TEXT
        )
        """,
        """
        CREATE TABLE webhooks (
            id      TEXT PRIMARY KEY,
            url     TEXT NOT NULL,
            events  TEXT NOT NULL DEFAULT '[]',
            secret  TEXT,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
        )
        """,
        # ---------------------------------------------------------------- 回收站
        # 注意：document_id 故意不加外键——文档被删除后，回收站记录仍要存在，
        # 否则"原文保留 7 天冷备"（架构 §6.2）就随文档一起没了。
        """
        CREATE TABLE trash (
            id           TEXT PRIMARY KEY,
            document_id  TEXT NOT NULL,
            kind         TEXT NOT NULL,
            storage_path TEXT NOT NULL,
            expires_at   TEXT NOT NULL,
            created_at   TEXT NOT NULL
        )
        """,
        "CREATE INDEX idx_trash_expires ON trash(expires_at)",
        # ---------------------------------------------------------------- 设置
        """
        CREATE TABLE app_settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """,
        # ---------------------------------------------------------------- 幂等键（架构 §3.2）
        """
        CREATE TABLE idempotency_keys (
            key          TEXT PRIMARY KEY,
            request_hash TEXT NOT NULL,
            response     TEXT,
            created_at   TEXT NOT NULL
        )
        """,
        # ---------------------------------------------------------------- 全文索引
        # 中文分词不依赖 FTS5 分词器扩展：写入前用 jieba 切好、空格连接存进 tokens 列，
        # 查询时对 query 做同样处理（T1.5 实现）。
        """
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
            chunk_id UNINDEXED,
            tokens,
            tokenize = 'unicode61'
        )
        """,
    ),
)

_MIGRATION_002 = Migration(
    version=2,
    description="api_keys 增加展示用前缀列（列表里分辨哪把是哪把）",
    statements=(
        # 为什么存前缀而不是明文：明文绝不落库，但列表里总得让用户看出来
        # "这把是上周发给 Grafana 的那把"。key_prefix 取明文去掉固定前缀后的前 6 位，
        # 来自 32 字节高熵随机串——剩下的熵还够 250 位，**不构成可利用的泄露面**。
        "ALTER TABLE api_keys ADD COLUMN key_prefix TEXT NOT NULL DEFAULT ''",
    ),
)

_MIGRATION_003 = Migration(
    version=3,
    description="对话留存：conversations 与 chat_messages",
    statements=(
        # 会话。title 取首轮提问的前若干字——用户回看时要能认出"这是哪一次"，
        # 而让人自己起名字的对话工具，最后满屏都是"新对话"。
        """
        CREATE TABLE conversations (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL DEFAULT '',
            kb_ids      TEXT NOT NULL DEFAULT '[]',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        )
        """,
        # 消息。**与会话分两张表**，而不是像 RAGFlow 那样把整段历史塞进一个 JSON 列：
        # 后者写一次要重写全量，且没法按时间查单条。分开之后"续写一轮"是一次 INSERT，
        # 代价与会话长度无关。
        #
        # sources 存**引用快照**（JSON），不是每轮重新检索：历史回答当时依据的是哪几段，
        # 事后回看必须还是那几段——重查会得到不同结果，引用编号就对不上了。
        """
        CREATE TABLE chat_messages (
            id              TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role            TEXT NOT NULL,
            content         TEXT NOT NULL,
            sources         TEXT NOT NULL DEFAULT '[]',
            created_at      TEXT NOT NULL
        )
        """,
        # 列表按最近更新倒序、取消息按会话聚合，都走这个索引
        "CREATE INDEX idx_chat_messages_conversation"
        " ON chat_messages(conversation_id, created_at)",
    ),
)

_MIGRATION_004 = Migration(
    version=4,
    description="切块人工干预：chunks 增加 disabled 标记",
    statements=(
        # 「禁用」与「删除」是两件事，所以要多一列：
        # - **禁用**：这块不该再被检索到，但用户还想留着、可能随时改回来
        #   （表格被切碎、公式被拆开时，删掉就找不回来了）
        # - **删除**：这块是垃圾（乱码、页眉页脚），留着占地方
        # 只给删除的话，用户面对一个"可能只是切得不好"的块只能二选一：忍着或毁掉。
        "ALTER TABLE chunks ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0",
    ),
)

MIGRATIONS: tuple[Migration, ...] = (
    _MIGRATION_001,
    _MIGRATION_002,
    _MIGRATION_003,
    _MIGRATION_004,
)
"""全部迁移，按 version 升序。只增不改。"""

_MIGRATIONS_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at  TEXT NOT NULL
)
"""


def _now() -> str:
    return datetime.now(UTC).isoformat()


def current_version(conn: sqlite3.Connection) -> int:
    """当前 schema 版本；未初始化返回 0。

    用位置索引取值而不是 ``row["v"]``：本函数对**任意** sqlite3 连接都该可用，
    不能要求调用方先设好 ``row_factory``。
    """
    conn.execute(_MIGRATIONS_TABLE)
    row = conn.execute("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").fetchone()
    return int(row[0])


def apply_migrations(
    conn: sqlite3.Connection, migrations: Sequence[Migration] | None = None
) -> list[int]:
    """应用缺失的迁移，返回本次应用的版本号列表。

    幂等：已应用的版本会被跳过，因此可以放心地在每次启动时调用。
    """
    conn.execute(_MIGRATIONS_TABLE)
    applied = {int(row[0]) for row in conn.execute("SELECT version FROM schema_migrations")}

    pending = [m for m in (migrations or MIGRATIONS) if m.version not in applied]
    just_applied: list[int] = []

    for migration in sorted(pending, key=lambda m: m.version):
        conn.execute("BEGIN")
        try:
            for statement in migration.statements:
                conn.execute(statement)
            conn.execute(
                "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
                (migration.version, migration.description, _now()),
            )
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        else:
            conn.execute("COMMIT")
            just_applied.append(migration.version)

    return just_applied
