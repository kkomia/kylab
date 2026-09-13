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

_MIGRATION_005 = Migration(
    version=5,
    description="模型注册器：供应商与模型目录（调研报告 G1）",
    statements=(
        # 供应商：一个 base_url + 一把凭据。
        #
        # **为什么不复用 app_settings 里那套 embedding.base_url 之类**：
        # 那套的模型是"全局各一套凭据"，换个模型就得把旧凭据覆盖掉；
        # 而成熟产品（6/6）都是"供应商可注册多条、模型可注册多个"——
        # 同一个 base_url 下往往要用好几个模型（便宜的做检索、贵的做对话）。
        # 两者不是同一件事，硬塞进 key-value 只会得到一个难用的设置页。
        """
        CREATE TABLE model_providers (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL,
            name        TEXT NOT NULL,
            base_url    TEXT NOT NULL DEFAULT '',
            api_key     TEXT NOT NULL DEFAULT '',
            enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        )
        """,
        # 模型目录：挂在某个供应商下，带能力标记。
        #
        # `capabilities` 用 JSON 数组存（如 ["chat","embedding"]）：
        # 一个模型能做什么，随供应商与版本而变，用固定的布尔列会僵化
        # （每加一种能力就要改表）。
        """
        CREATE TABLE model_registry (
            id           TEXT PRIMARY KEY,
            provider_id  TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
            model_id     TEXT NOT NULL,
            label        TEXT NOT NULL DEFAULT '',
            dim          INTEGER,
            capabilities TEXT NOT NULL DEFAULT '[]',
            options      TEXT NOT NULL DEFAULT '{}',
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        )
        """,
        # 同一供应商下不允许重复登记同一个 model_id
        "CREATE UNIQUE INDEX idx_model_registry_provider_model"
        " ON model_registry(provider_id, model_id)",
    ),
)

_MIGRATION_006 = Migration(
    version=6,
    description="用量统计：按次记录模型调用的 token 与耗时（调研报告 G7）",
    statements=(
        # 一行 = 一次模型调用。
        #
        # **为什么单独建表而不是加在 tasks 上**：用量与任务是两件事——
        # 一次对话问答没有后台任务（它是同步请求），却照样消耗 token；
        # 而一个摄入任务可能调用多次模型（每个分片一次）。硬塞进 tasks
        # 会让"某次调用"和"某个任务"混成一个概念，统计口径就说不清了。
        """
        CREATE TABLE usage_events (
            id                TEXT PRIMARY KEY,
            kind              TEXT NOT NULL,
            provider          TEXT NOT NULL DEFAULT '',
            model_id          TEXT NOT NULL DEFAULT '',
            prompt_tokens     INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            items             INTEGER NOT NULL DEFAULT 0,
            duration_ms       INTEGER NOT NULL DEFAULT 0,
            reported          INTEGER NOT NULL DEFAULT 0,
            created_at        TEXT NOT NULL
        )
        """,
        # 驾驶舱按时间窗口聚合，走这个索引
        "CREATE INDEX idx_usage_events_created ON usage_events(created_at)",
    ),
)

_MIGRATION_007 = Migration(
    version=7,
    description="用量事件记录数字来源（实测 / 估算 / 未上报）",
    statements=(
        # 三态而不是布尔：原先只有 reported 两态，把"我们自己按字符数估的"
        # 和"供应商真报的"混成了一类——向量化接口根本不返回 usage，
        # 那一列数字全是估算，却显示成实测。**假精度比没数字更糟**：
        # 用户会拿它去做成本判断。
        #
        # 默认值取 'reported'：迁移前写入的行都来自对话调用（真有 usage），
        # 这样历史数据的口径不会因为这次迁移而改变。
        "ALTER TABLE usage_events ADD COLUMN source TEXT NOT NULL DEFAULT 'reported'",
    ),
)

_MIGRATION_008 = Migration(
    version=8,
    description="修正历史用量记录的数字来源标注",
    statements=(
        # 007 把迁移前的行一律标成 'reported'（实测），但那批行里有向量化调用——
        # 而向量化接口**根本不返回 usage**，那些数字是旧代码按字符数估的。
        #
        # 标错方向的代价不对称：把实测标成估算只是保守，把估算标成实测
        # 会让用户拿一个假精度的数字去做成本判断。
        # 所以这里按用途把它改回 'estimated'。
        "UPDATE usage_events SET source = 'estimated' WHERE kind IN ('embedding', 'rerank')",
    ),
)

_MIGRATION_009 = Migration(
    version=9,
    description="轻量多用户：使用者名册与文档归属（调研报告 G6）",
    statements=(
        # 使用者名册。
        #
        # **刻意不做账号体系**：没有密码、没有邮箱、没有角色。使用场景是
        # "局域网内几个人共用一台机器"，他们需要的是**知道是谁传的**，
        # 而不是登录与权限——后者会带来组织架构、邀请、配额、审计一整套复杂度，
        # 远超本项目要解决的问题（架构 §1 的定位）。
        #
        # 凭据仍然只有三档身份（控制台令牌 / 读写密钥 / 只读密钥，见 §11.4），
        # 名册只是**归属标注**，不是鉴权主体。
        """
        CREATE TABLE users (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            note       TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """,
        # 同名不允许：名册的意义就是"能分辨是谁"，重名会让它失去意义
        "CREATE UNIQUE INDEX idx_users_name ON users(name)",
        # 文档的归属。NULL = 系统摄入（比如目录扫描）或名册启用前的老数据，
        # 界面据此显示"未记录"而不是编一个名字出来。
        "ALTER TABLE documents ADD COLUMN uploaded_by TEXT",
    ),
)

_MIGRATION_010 = Migration(
    version=10,
    description="账号体系：名册升级为登录账号、会话、知识库归属与分享",
    statements=(
        # **翻案记录**：v9 刻意不做账号体系（见上面的注释），理由是"局域网几个人共用
        # 一台机器"只需要归属标注。这个判断对"开发者自用"成立，但产品要面向
        # **不懂技术的个人用户**——"粘贴控制台令牌"对他们不可用，而且私有数据
        # （个人笔记、文档）天然要求"别人登录后看不到"。所以名册升级为账号：
        # username/password_hash 可空，空 = 历史名册条目（只做归属标注，不能登录）。
        "ALTER TABLE users ADD COLUMN username TEXT",
        "ALTER TABLE users ADD COLUMN password_hash TEXT",
        "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'",
        "ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0",
        # 唯一索引用部分索引（WHERE username IS NOT NULL）：SQLite 里 UNIQUE 允许多个
        # NULL，但名册条目会越来越多，显式部分索引把"可空但非空必唯一"的意图写死
        "CREATE UNIQUE INDEX idx_users_username"
        " ON users(username) WHERE username IS NOT NULL",
        # 登录会话。**存哈希不存明文**（与 API Key 同一纪律）：库泄露不等于会话泄露。
        # 过期与滑动续期由服务层管，表里只记三个时间戳。
        """
        CREATE TABLE sessions (
            id           TEXT PRIMARY KEY,
            user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at   TEXT NOT NULL,
            expires_at   TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
        )
        """,
        "CREATE INDEX idx_sessions_user ON sessions(user_id)",
        # 归属列一律**可空且迁移时不填**：迁移跑的时候还没有任何账号，瞎填一个 id
        # 比留 NULL 更难收拾。老数据由 setup 向导认领给首个管理员（services/auth.py）。
        "ALTER TABLE knowledge_bases ADD COLUMN owner_id TEXT",
        "ALTER TABLE conversations ADD COLUMN owner_id TEXT",
        "ALTER TABLE api_keys ADD COLUMN created_by TEXT",
        # 知识库分享：owner 把库分享给其他成员，读/写两档。
        # 挂在 kb + user 复合主键上，重复分享同一库同一人即更新档位（INSERT OR REPLACE）。
        """
        CREATE TABLE kb_shares (
            kb_id      TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            permission TEXT NOT NULL CHECK (permission IN ('read', 'write')),
            created_at TEXT NOT NULL,
            PRIMARY KEY (kb_id, user_id)
        )
        """,
        "CREATE INDEX idx_kb_shares_user ON kb_shares(user_id)",
    ),
)

_MIGRATION_011 = Migration(
    version=11,
    description="嵌入模型改为知识库属性：记录所选的注册模型，支持不同库用不同模型",
    statements=(
        # **设计调整（用户提出）**：原先 embedding 是全局一套——建库时把全局解析出的
        # 模型冻进记录，所有库共用一个 embedder。"小文档库用高精度模型、大文档库用
        # 小模型提速"这个场景因此做不到。
        # 现在：嵌入模型在**建库时**从注册表里选，随库冻结；这里只记"选的是哪个注册模型"
        # （凭据仍只在注册表里存一处，运行时按 pk 解析，避免密钥散落）。
        # 可空：老库与"没显式选"的库继续走全局/默认配置，升级不打断既有部署。
        "ALTER TABLE knowledge_bases ADD COLUMN embedding_model_pk TEXT",
    ),
)


_MIGRATION_012 = Migration(
    version=12,
    description="会话级对话模型：记录该会话选用的注册模型（不同会话可用不同模型）",
    statements=(
        # **设计调整（用户提出）**：对话模型此前是全局单例——每条会话都走注册表里
        # 绑定给 `chat` 槽位的那个模型。想换个模型开一轮对比，只能去设置页改全局绑定，
        # 而那会把所有会话一起改掉。
        # 现在：新建会话时选定一个对话模型并随会话冻结（与 §12.25"嵌入模型按库冻结"
        # 同一思路，只是粒度从库换成会话）。凭据仍只在注册表存一处，这里只记 pk。
        # 可空：老会话与"没显式选"的会话继续走全局默认，升级不打断既有部署。
        "ALTER TABLE conversations ADD COLUMN model_pk TEXT",
    ),
)


_MIGRATION_013 = Migration(
    version=13,
    description="知识库内目录：kb_folders 表 + documents.folder_id（可空=根目录）",
    statements=(
        # **单层目录**（用户要求"知识库里要能新建目录"）：不做父子嵌套。
        # 个人知识库的规模下，一层分类就够把"合同/发票/说明书"分开，而嵌套会立刻带来
        # 拖拽跨层、路径拼接、删除策略一串复杂度。要嵌套时再加 parent_id 迁移即可。
        """
        CREATE TABLE kb_folders (
            id         TEXT PRIMARY KEY,
            kb_id      TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (kb_id, name)
        )
        """,
        "CREATE INDEX idx_kb_folders_kb ON kb_folders(kb_id)",
        # 可空 = 未归档（根目录）。**没加外键**：SQLite 的 ALTER 加不了带 ON DELETE
        # 的外键，所以"删目录时把成员移回根"由服务层负责（见 FolderService.delete）。
        "ALTER TABLE documents ADD COLUMN folder_id TEXT",
        "CREATE INDEX idx_documents_folder ON documents(folder_id)",
    ),
)


_MIGRATION_014 = Migration(
    version=14,
    description="文档级停用：documents.disabled（停用后不参与检索，不删任何东西）",
    statements=(
        # 与 chunks.disabled 同一套语义（_MIGRATION_004 的注释：「禁用」与「删除」
        # 是两件事）。**检索侧按标记过滤，不删向量**：恢复零成本，也不必重新 embedding。
        "ALTER TABLE documents ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0",
    ),
)


_MIGRATION_015 = Migration(
    version=15,
    description="知识库简介：knowledge_bases.description（默认空串，列表卡片展示）",
    statements=(
        # NOT NULL DEFAULT ''：老库不需要回填，界面把空串当"暂无简介"。
        "ALTER TABLE knowledge_bases ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    ),
)


_MIGRATION_016 = Migration(
    version=16,
    description="会话级思考偏好：conversations.thinking / thinking_effort（可空=跟随全局）",
    statements=(
        # 可空：老会话与"没显式选"的会话继续走全局默认。与 model_pk（v12）同一套口径：
        # 用户在输入框改过的选择随会话留下，回看时仍然是当时那一档。
        "ALTER TABLE conversations ADD COLUMN thinking INTEGER",
        "ALTER TABLE conversations ADD COLUMN thinking_effort TEXT",
    ),
)


_MIGRATION_017 = Migration(
    version=17,
    description="会话置顶：conversations.pinned（0/1，列表按 置顶+最近更新 排序）",
    statements=(
        # 默认 0：老会话全都不置顶。**不加索引**——会话表通常几十到几百行，
        # 排序本来就快，加索引只会让写入多一次维护成本。
        "ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    ),
)


_MIGRATION_018 = Migration(
    version=18,
    description="清掉已废弃的 llm.max_tokens（回复长度上限不再由我们设置）",
    statements=(
        # 这个键曾经是「回复长度上限」，默认 2048。实测它会把回复预算掐死在思考阶段
        # ——正文一个字都出不来，而且随采样时好时坏（同一题有时答得出来）。
        # 先是想抬到 16384，最后结论是**不替模型决定长度**：请求里干脆不带这个字段，
        # 让端点生成到模型自然收尾（见 services/llm.py 的 LLMConfig.max_tokens）。
        # 键留着没人读，就会变成"界面看不到、代码也不认"的僵尸配置，删掉。
        # （018 在写下这一版之前从未在任何库上应用过——它和上一版是同一天内的一稿一改。）
        "DELETE FROM app_settings WHERE key = 'llm.max_tokens'",
    ),
)


_MIGRATION_019 = Migration(
    version=19,
    description="清掉 v0.8 起已由模型注册表承担、无人读取的模型身份键",
    statements=(
        # 这些键曾经是"全局各一套自己的模型凭据"。v0.8 把模型身份收进注册表之后，
        # 没有任何代码再读它们（``RuntimeConfigService._bootstrap_value`` 的映射里没有，
        # 设置接口还会**明确拒绝**写入），留着就是一行行"界面看不见、代码也不认"的
        # 僵尸配置——而其中两行是**明文密钥**。
        # 凭据没丢：注册表里每个供应商各自存着自己的 api_key。
        # 注意别碰 ``embedding.batch_size``：那是仍在用的设置项（SETTING_GROUPS 里有）。
        "DELETE FROM app_settings WHERE key IN ("
        " 'llm.api_key', 'llm.base_url', 'llm.model_id',"
        " 'embedding.api_key', 'embedding.base_url', 'embedding.model_id', 'embedding.dim',"
        " 'rerank.api_key', 'rerank.base_url', 'rerank.model_id'"
        ")",
    ),
)


_MIGRATION_020 = Migration(
    version=20,
    description="笔记：notes 表 + note_tags（对标 ima 笔记的最小数据模型）",
    statements=(
        # 笔记的**唯一事实源是 Markdown**（`content_md`），编辑器的 JSON 不落库：
        # 换编辑器（现在是 Tiptap）零成本，导出/入知识库/全文检索也都直接吃 Markdown。
        #
        # `user_id` 可空：管理员/API Key 建的笔记没有归属用户（与 conversations 同口径）。
        # `kb_id`/`doc_id` 是"加入知识库"的回填：笔记入库后指向生成的文档，
        # 检索命中时能跳回笔记本身（见 services/notes.py）。
        """
        CREATE TABLE notes (
            id          TEXT PRIMARY KEY,
            user_id     TEXT,
            title       TEXT NOT NULL DEFAULT '',
            content_md  TEXT NOT NULL DEFAULT '',
            source_kind TEXT NOT NULL DEFAULT 'manual',
            source_ref  TEXT,
            kb_id       TEXT,
            doc_id      TEXT,
            pinned      INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        )
        """,
        # 列表按置顶 + 更新时间倒序，索引照这个排序建
        "CREATE INDEX idx_notes_owner ON notes(user_id, pinned DESC, updated_at DESC)",
        """
        CREATE TABLE note_tags (
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            tag     TEXT NOT NULL,
            PRIMARY KEY (note_id, tag)
        )
        """,
        "CREATE INDEX idx_note_tags_tag ON note_tags(tag)",
    ),
)


_MIGRATION_021 = Migration(
    version=21,
    description="会话上下文摘要：早期对话折成摘要，避免长会话把窗口撑爆（v20.1）",
    statements=(
        # 为什么要存摘要而不是每次现算：摘要是一次 LLM 调用（要花钱、要等），
        # 只该在**第一次越过阈值**时算一次，之后每轮复用。
        # ``summary_upto`` 记录"摘要已经覆盖到哪条消息"，之后只把更晚的消息算进上下文，
        # 这样用户回看时原文一条没少，只是喂给模型的部分被压缩了。
        "ALTER TABLE conversations ADD COLUMN context_summary TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE conversations ADD COLUMN summary_upto TEXT",
    ),
)


_MIGRATION_022 = Migration(
    version=22,
    description="知识库的推荐问题设置：开关 / 条数 / 生成模型 / 自定义提示词（v19）",
    statements=(
        # 推荐问题（对话页空状态那排胶囊）此前只认写死的常量：条数 6、固定提示词、
        # 跟着当前对话模型。现在下放到库上——**一个库的语料决定"该问什么"**，
        # 于是"出几条、用哪个模型出、怎么出"也归它管。
        # 四列都带默认值：老库升级后的行为与之前一致（开 / 6 条 / 跟随对话模型 / 内置提示词）。
        "ALTER TABLE knowledge_bases ADD COLUMN suggested_enabled INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE knowledge_bases ADD COLUMN suggested_count INTEGER NOT NULL DEFAULT 6",
        "ALTER TABLE knowledge_bases ADD COLUMN suggested_model_pk TEXT",
        "ALTER TABLE knowledge_bases ADD COLUMN suggested_prompt TEXT NOT NULL DEFAULT ''",
    ),
)


_MIGRATION_023 = Migration(
    version=23,
    description="分段问题：每个分段的生成问题随块入库，并进检索文本（v23）",
    statements=(
        # 为什么问题要跟块存在一起：它是**这一段的**属性，块的 chunk_id 已经稳定，
        # 重跑/断点续跑时按 id 对得上；而它又是"提升召回"的手段——见
        # ``ChunkRecord.index_text``：向量与全文索引都用「原文 + 问题」，
        # 于是用户换一种问法也能命中这一段。原文那一列不动，引用预览里不会多出问题。
        "ALTER TABLE chunks ADD COLUMN questions TEXT NOT NULL DEFAULT '[]'",
        # **语义变更（翻案 022）**：`suggested_enabled` 从"空状态要不要显示推荐问题"
        # 变成"入库时要不要为每个分段生成问题"。生成要花模型调用（每 8 段一次请求，
        # 发生在上传之后）——升级后不能默默开始烧 token，所以老库一律先关掉，
        # 用户自己按需打开。`suggested_count` 同步从"显示几条"变成"每段生成几条"。
        "UPDATE knowledge_bases SET suggested_enabled = 0",
    ),
)


MIGRATIONS: tuple[Migration, ...] = (
    _MIGRATION_001,
    _MIGRATION_002,
    _MIGRATION_003,
    _MIGRATION_004,
    _MIGRATION_005,
    _MIGRATION_006,
    _MIGRATION_007,
    _MIGRATION_008,
    _MIGRATION_009,
    _MIGRATION_010,
    _MIGRATION_011,
    _MIGRATION_012,
    _MIGRATION_013,
    _MIGRATION_014,
    _MIGRATION_015,
    _MIGRATION_016,
    _MIGRATION_017,
    _MIGRATION_018,
    _MIGRATION_019,
    _MIGRATION_020,
    _MIGRATION_021,
    _MIGRATION_022,
    _MIGRATION_023,
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
