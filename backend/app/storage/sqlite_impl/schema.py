r"""本机库 schema 的创建、校验、增量迁移与**迁移前自动备份**（M2 §1.1）。

职责边界与 PG 侧一致：**DDL 的唯一属主是应用**。启动时由 ``ensure_schema`` 建库 /
补迁移，不靠人工 ``sqlite3`` 命令（那会造出第二个真相来源）。

与 ``postgres_impl/schema.py`` 的三处有意差异：

1. **版本号住 ``schema_metadata`` 而不是 ``schema_migrations`` 表**，且**不另写
   ``PRAGMA user_version``**——那会变成第二处真相来源（§1.1，与 PG 侧"不建分区
   登记表"同一条理由）。``schema_metadata`` 是那张 ``key/value`` 表，同时装
   ``version`` / ``created_at_ms`` / ``last_backup`` / ``migration_log``。
2. **迁移前自动备份**（规范化要求，PG 那边没有）：迁移一旦跑错，库就是一个既不是
   旧版也不是新版的状态。用 ``sqlite3.Connection.backup()``（在线备份 API）
   在迁移前落一份整库副本——WAL 下它安全，目标已存在也不怕。
3. **每条迁移一个事务、版本号写在同一事务里**：DDL 在中途失败时要么整条生效、
   要么整条回滚，不会留下"表建了但版本没记"的半截状态。SQLite 的 DDL 是事务性的，
   所以这条真的能成立（PG 那边也照这个写法）。
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.storage.sqlite_impl.connection import Database

logger = logging.getLogger(__name__)

SCHEMA_PATH = Path(__file__).with_name("schema.sql")

BASELINE_VERSION = 1
"""``schema.sql`` 对应的版本号。"""

SCHEMA_VERSION = 2
"""应用期望的 schema 版本：基线 + ``MIGRATIONS`` 里已追加的增量。

比它低 → 按序补上缺的迁移；比它高 → 报错（库被更新版应用升过级，**不降级**）。
本机库与 PG 库是两份独立的 schema，所以这个数字与 ``postgres_impl`` 的 17 **无关**，
不要拿两边对齐——它们记的是各自家当的演进。

**v2 = 知识库元数据缓存**（M4 §3.1）。基线 ``schema.sql`` 与 ``BASELINE_VERSION``
一个字不改：本机库**已经发过版**（用户机器上那份就是 v1），新表只能走增量迁移——
改基线等于让老库永远升不上来。"""

#: ``schema_metadata`` 里用到的键。写在一处，免得字符串散在四个方法里。
KEY_VERSION = "version"
KEY_CREATED_AT = "created_at_ms"
KEY_LAST_BACKUP = "last_backup"
KEY_MIGRATION_LOG = "migration_log"

BACKUP_DIRNAME = "migration-backup"
"""迁移前备份的落点（``<data_dir>/migration-backup/<时间戳>-v<from>→v<to>/kylab.db``）。"""


@dataclass(frozen=True, slots=True)
class Migration:
    """一条增量迁移。**只增不改**：已经发布的条目一律不许改字面量。"""

    version: int
    description: str
    statements: tuple[str, ...]


MIGRATION_V2_KB_META_CACHE = Migration(
    version=2,
    description="知识库元数据缓存（M4 §3.1）：五个读路径资源的快照落本机",
    statements=(
        # 列与要点逐条对回方案 §3.1，两处刻意的写法：
        #
        # ① **时间列带 `_ms` 且不带 DEFAULT**（照 `schema.sql:16-34` 的类型映射纪律）：
        #    毫秒值的唯一属主是应用侧那三个 helper，SQLite 没有"当前毫秒"的表达式默认值
        #    （`unixepoch()` 要 3.38，本机下限 3.37）；
        # ② `stale` / `identity` / `last_error` 的 DEFAULT 只是给**手写 SQL 排障**用的兜底，
        #    应用一律显式给值（`put` 写全部列），所以它与①不矛盾——那三列不是时间。
        #
        # `(provider, resource, scope_key)` 三列主键就是**键空间**：地址隔离靠 provider
        # （归一化后的 base_url），资源内隔离靠 scope_key（库/条目/视图指纹）。
        # 每列的语义写在 ``app/storage/base.py`` 的 ``KbMetaCacheRecord`` 上（一处即可），
        # 这里的行内注释只标"这一列在键空间/判据里扮什么角色"。
        """\
CREATE TABLE kb_meta_cache (
    -- 提供者地址（归一化：去尾斜杠）；键空间隔离靠它
    provider        TEXT    NOT NULL,
    -- kb_list / kb_detail / doc_list / document / folders（词表在服务层，这里不校验）
    resource        TEXT    NOT NULL,
    -- 资源内键：kb_id / document_id / 视图指纹；kb_list 用 ''
    scope_key       TEXT    NOT NULL,
    -- NAS 原样 JSON（权限位已剥）；写进来的必须是合法 JSON
    payload         TEXT    NOT NULL CHECK (json_valid(payload)),
    -- 内容哈希（sha256:…）：etag 缺席时"变没变"的判据
    version         TEXT    NOT NULL,
    -- 服务端给的时候才有；今天恒 NULL（NAS 的 KB 读端点还没有条件请求）
    etag            TEXT,
    last_modified   TEXT,
    -- handshake / reader / revalidate：这行是怎么来的
    source          TEXT    NOT NULL,
    -- api_key / session：**只作排障，不许当判据**
    identity        TEXT    NOT NULL DEFAULT '',
    -- 这份"内容"是什么时候看到的（界面那句"上次更新于 X"）
    fetched_at_ms   INTEGER NOT NULL,
    -- 最近一次**确认**（含"确认过没变"）：超龄丢弃看的是这一列
    checked_at_ms   INTEGER NOT NULL,
    stale           INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
    last_error      TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (provider, resource, scope_key)
) STRICT
""",
        # 淘汰只看 `fetched_at_ms`（LRU 的判据是"这份内容什么时候看到的"，
        # 见 base.py 的 `MAX_ROWS_PER_PROVIDER`），所以索引就建在这一列上。
        "CREATE INDEX idx_kb_meta_cache_prune ON kb_meta_cache (fetched_at_ms)",
        # 按资源取（页面的三个视图各取一条）/ 按资源清（按库清那一档）。
        "CREATE INDEX idx_kb_meta_cache_scope ON kb_meta_cache (provider, resource)",
    ),
)
"""**第一条增量迁移**：基线（v1）之后的第一张新表。

它只加表、不动任何旧表——本机库装的是用户自己的会话，升级时**一条都不能丢**
（`_apply_migrations` 在动手之前先整库备份，见那个函数）。
"""

MIGRATIONS: tuple[Migration, ...] = (MIGRATION_V2_KB_META_CACHE,)
"""增量迁移。基线（``schema.sql``）就是第 1 版，之后的演进往这里追加。

**为什么本机库可以有迁移而 PG 侧是"不迁移数据"**：PG 那次是老库里没有值得搬的东西
（数据直接舍弃）。本机库不一样——它装的是用户自己的会话，升级时**一条都不能丢**，
所以 DDL 的演进只能靠迁移，不能靠"重建基线"。

已经发布的条目**一律不许改字面量**（``Migration`` 的纪律）：用户机器上跑过的 v2 就是
这一份，改一个字都会让"升过级的库"与"新装的库"结构不同。
"""


class SchemaError(RuntimeError):
    """schema 无法满足应用要求（基线 DDL 执行失败、版本不符、版本记录坏了）。"""


def _now_ms() -> int:
    """当前 UTC 毫秒（与 ``meta_store._dump(_now())`` 同一个口径）。"""
    return int(time.time() * 1000)


def _stamp() -> str:
    """目录名用的 UTC 时间戳：``20261001T080300Z``。

    **不能带冒号**（Windows 文件名禁用），这也是不用 ISO 原形的原因；
    用 UTC 而不是本地时间：备份目录名要能跨时区比较。
    """
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def current_version(db: Database) -> int | None:
    """库当前的 schema 版本。

    三种情况要分清（混起来会让"库状态不完整"被误当成"空库"而重跑建表）：

    - ``None`` —— 连 ``schema_metadata`` 表都没有，是全新库，可以建基线；
    - ``0``    —— 表在但一行版本记录都没有：不完整状态，比任何基线都低；
    - ``n``    —— 正常版本号。
    """
    with db.read() as conn:
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_metadata'"
        ).fetchone()
        if table is None:
            return None
        row = conn.execute(
            "SELECT value FROM schema_metadata WHERE key = ?", (KEY_VERSION,)
        ).fetchone()
        if row is None:
            return 0
        try:
            return int(row["value"])
        except (TypeError, ValueError) as exc:
            raise SchemaError(
                f"schema_metadata.version 的值不是十进制版本号（读到 {row['value']!r}）；"
                "库被人手改过，请先修好它再启动"
            ) from exc


def ensure_schema(db: Database) -> int:
    """确保 schema 就位；返回当前版本。

    空库 → 建基线；已有库 → 校验版本不低于基线，再把缺的增量迁移按序补上。
    版本比应用期望的还新（库被更新版应用升过）**报错，不降级**——旧代码写新结构
    的结果是静默的数据损坏，比启动失败严重得多。
    """
    version = current_version(db)

    if version is None:
        _create_baseline(db)
        version = current_version(db)

    if version is None or version < BASELINE_VERSION:
        raise SchemaError(
            f"schema 版本为 {version}，低于应用要求的基线 {BASELINE_VERSION}；"
            f"请检查 {SCHEMA_PATH} 是否正确执行"
        )
    if version > SCHEMA_VERSION:
        raise SchemaError(
            f"schema 版本为 {version}，高于本应用已知的 {SCHEMA_VERSION}；"
            "库是被更新版应用升过级的，请升级应用而不是降级数据库"
        )
    return _apply_migrations(db, version)


def _create_baseline(db: Database) -> None:
    """执行 ``schema.sql``（**版本号也在那份脚本里**，与 DDL 同一事务）。

    ``Database.script()`` 把整段 DDL 包在一个 ``BEGIN IMMEDIATE`` 里
    （``executescript`` 会先隐式提交，所以事务必须写在脚本体内，见那边的说明），
    于是"建到一半"这件事在库层面不可能发生——包括"表建好了但版本没记"。

    建库时刻是脚本之后补的**信息性**字段：它丢了不影响任何判断
    （``current_version`` 只读 ``version``）。
    """
    ddl = SCHEMA_PATH.read_text(encoding="utf-8")
    try:
        db.script(ddl)
    except sqlite3.Error as exc:
        raise SchemaError(f"基线 schema 执行失败：{exc}") from exc
    with db.session() as conn:
        _write_meta(conn, KEY_CREATED_AT, str(_now_ms()))
    logger.info("已创建本机库基线 schema v%d：%s", BASELINE_VERSION, db.path)


def _apply_migrations(db: Database, version: int) -> int:
    """把缺的增量迁移按序补上，返回补完后的版本。

    每条迁移的顺序是：**先备份、再开事务**（表改动 + 版本号 + 迁移日志同一事务）。
    备份在事务外——它是另一条连接上的整库副本，放进事务里只会把写锁拉长到
    整份拷贝的时长。
    """
    pending = [item for item in MIGRATIONS if item.version > version]
    for item in pending:
        backup = _backup_before_migration(db, from_version=version, to_version=item.version)
        try:
            with db.session() as conn:
                for statement in item.statements:
                    conn.execute(statement)
                _write_meta(conn, KEY_VERSION, str(item.version))
                _append_migration_log(conn, item)
        except Exception as exc:
            raise SchemaError(
                f"增量迁移 v{item.version}（{item.description}）执行失败：{exc}；"
                f"迁移前的整库备份在 {backup}"
            ) from exc
        version = item.version
        logger.info("已应用增量迁移 v%d：%s", item.version, item.description)
    return current_version(db) if pending else version


def _backup_before_migration(db: Database, *, from_version: int, to_version: int) -> Path:
    """迁移前把整库复制一份，返回备份路径，并把它写回 ``schema_metadata.last_backup``。

    用 ``sqlite3.Connection.backup()`` 而不是 ``shutil.copy``：WAL 模式下库文件
    只是数据的一个**部分**（最近的提交在 ``-wal`` 里），照文件拷贝会得到一份
    "少了最后一截"的库。在线备份 API 走的是同一套页协议，拷出来的是**一致快照**。

    目录名带版本区间（``…-v1→v2``）：一次升级可能有几条迁移，落好几份时
    一眼看得出来"这份是升到哪一步之前"的。
    """
    target_dir = db.path.parent / BACKUP_DIRNAME / f"{_stamp()}-v{from_version}→v{to_version}"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / db.path.name
    source = db.connection()
    with sqlite3.connect(target) as sink:
        source.backup(sink)
    with db.session() as conn:
        _write_meta(conn, KEY_LAST_BACKUP, str(target))
    logger.info("迁移前备份：%s → %s", db.path, target)
    return target


def _write_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO schema_metadata (key, value) VALUES (?, ?)"
        " ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def _append_migration_log(conn: sqlite3.Connection, item: Migration) -> None:
    """把"这条迁移什么时候应用的"追加进 ``migration_log``（JSON 数组）。"""
    row = conn.execute(
        "SELECT value FROM schema_metadata WHERE key = ?", (KEY_MIGRATION_LOG,)
    ).fetchone()
    try:
        entries = json.loads(row["value"]) if row else []
    except (TypeError, ValueError):
        entries = []
    if not isinstance(entries, list):
        entries = []
    entries.append({"version": item.version, "description": item.description, "at_ms": _now_ms()})
    _write_meta(conn, KEY_MIGRATION_LOG, json.dumps(entries, ensure_ascii=False))


def prepare(db: Database) -> int:
    """装配时的门面：开库（PRAGMA / 版本自检）→ 建/校验 schema。返回当前版本。

    与 PG 侧的 ``prepare`` 同名同形，只是没有"校验扩展"那一步——SQLite 的
    JSON1 与 STRICT 都由版本自检覆盖（``connection.MIN_SQLITE_VERSION``）。
    """
    db.open()
    return ensure_schema(db)
