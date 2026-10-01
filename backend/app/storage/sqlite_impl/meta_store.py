r"""``MetaStore`` 本机域的 SQLite 实现（M2 §2.1 / §7 阶段 1）。

与 ``postgres_impl/meta_store.py`` 的对应关系：**逐方法平移**，接口、返回值语义与
异常类型都保持一致。机械差异只有下面几类，逐条说明为什么（§7 阶段 1 那两条：

- **占位符**：``%s`` → ``?``。
- **时间戳**：列是 INTEGER（UTC 毫秒，列名带 ``_ms``）。``_dump`` / ``_load``
  与 PG 侧同名同形，但不再是恒等助手——它们真的做 ``datetime`` ↔ 毫秒的换算，
  读侧再把毫秒变回 aware UTC ``datetime``，于是服务层看到的东西两边一样。
- **JSON**：列是 ``TEXT`` + ``CHECK (json_valid(...))``。写入走 :func:`_json`
  （``json.dumps(..., ensure_ascii=False)``），读回要 ``json.loads``——
  PG 那边是 ``jsonb``，psycopg 已经替你反序列化了，这边得自己来。
- **布尔**：列是 INTEGER 0/1，写 ``int(...)``、读 ``bool(...)``；
  **可空的三态列**（``thinking`` / ``next_run_at`` 那几处）保持 ``None`` 不动
  ——``None`` 的语义是"跟随默认"，折成 False 就丢了一个状态。
- **方言**：``ILIKE`` → ``LIKE``（SQLite 的 LIKE 对 ASCII 默认就不敏感，与 PG 的
  ILIKE 同口径）；``IS NOT DISTINCT FROM`` → ``IS``；``DISTINCT ON`` → 窗口函数；
  ``= ANY(%s)`` → ``IN (?,?,…)``；``to_jsonb`` → 列别名。
- **并发**：``FOR UPDATE`` 删掉——写路径走 ``BEGIN IMMEDIATE`` 的**库级写锁**
  （整个事务独占写者），语义等价（§1.5）。

**毫秒精度带来的新纪律**：时间戳只到毫秒，所以"必须推进"的写（``touch_conversation``
与各 ``update_*``）落值是 ``max(now_ms, 旧值 + 1)``，见下面那段"毫秒推进纪律"。
同一毫秒里的两次推进会因此排得出先后，而"最近活动"这类排序正是靠它。

**只实现本机域**：本模块的方法集合**恰好**是
``app.storage.sqlite_impl.LOCAL_METHODS``（机械导出，见那个模块），
知识库 / 文档 / 切块 / 向量 / 全文 / Wiki / 任务队列 / 回收站 / 账号会话
一个都不在这里——它们是 NAS 的家当。分档路由（``RouterMetaStore``）是阶段 2。
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from typing import Any

from app.core.exceptions import ConflictError
from app.storage.base import (
    ChatMessageRecord,
    ConversationArtifactRecord,
    ConversationRecord,
    MCPServerRecord,
    ModelProviderRecord,
    NoteFolderRecord,
    NoteRecord,
    RegisteredModelRecord,
    ScheduledTaskRecord,
    SessionEventRecord,
    UsageEventRecord,
    WorkspaceRecord,
)
from app.storage.sqlite_impl.connection import Database

# ------------------------------------------------------------------ 三个 helper
#
# 与 `postgres_impl/meta_store.py:121/125/135` 同名同形，但这里真的在换算：
# PG 的目标列是 timestamptz（psycopg 原生适配 datetime），本机是 INTEGER 毫秒。


def _now() -> datetime:
    return datetime.now(UTC)


def _dump(moment: datetime | None) -> int | None:
    """``datetime`` → UTC 毫秒。

    **naive datetime 按 UTC 解释**：本库只存 UTC 毫秒，而"没有时区的 datetime
    该算哪个时区"只能有一个答案。按本机时区解释会让同一份数据在两台机器上落成
    两个值（导入的会话尤其明显）；按 UTC 解释是确定性的，且与
    ``_load`` 读回来的东西对得上。

    取整方式是**截断**：毫秒以下是本库表达不了的精度，round 会让
    ``_load(_dump(x))`` 在边界上偶尔大于 x，而测试里拿它比大小会很费解。
    """
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return int(moment.timestamp() * 1000)


def _load(value: int | None) -> datetime | None:
    """UTC 毫秒 → aware ``datetime``（``None`` 原样返回）。"""
    if value is None:
        return None
    return datetime.fromtimestamp(int(value) / 1000, UTC)


def _json(value: object) -> str:
    """写 JSON 文本列（对应 PG 侧的 ``_json()`` 包 ``Jsonb``）。"""
    return json.dumps(value, ensure_ascii=False)


#: 毫秒推进纪律（风险 R8）：**"必须推进"的写，落值一律是 `max(?, 旧值 + 1)`**。
#:
#: 为什么：时间戳只到毫秒，同一毫秒里的两次推进会落成同一个值，于是"最近活动"
#: 排不出先后——而列表正是按它排的。这与 `session_events.seq` 是同一类问题的两种
#: 解法：一个用在只追加表（写事务里 `max(seq)+1`，见 `_insert_events`），
#: 一个用在原地更新表（`UPDATE … SET updated_at_ms = max(?, updated_at_ms + 1)`）。
#:
#: 写成**逐处字面 SQL**而不是一个拼 SQL 的 helper：拼出来的语句既让 S608
#: 说不出话，也让人读不出"这一条到底推进了哪一列"。要核对这条纪律时，
#: `grep "max(?, " meta_store.py` 就是全部落点。


def _placeholders(count: int) -> str:
    """生成 ``?,?,…``（对应 PG 侧的 ``%s, %s, …``）。"""
    return ",".join(["?"] * count)


# ------------------------------------------------------------------ 列表 SQL（规范 4）
#
# **规范 4「列表预览与正文分离」的落点**：正文**留在表内**（不外置成文件）。
# 理由：这条规范的本意是"列表页不许拖着正文"（调研 §4 的反面教材是"改一个会话
# 重写整个 JSON"），而在 SQLite 里读一列 TEXT 就是最终形态；把正文搬到文件只会
# 新增"正文与引用不一致"的风险面——那正是 M2 风险表点名要防的东西。
#
# 于是落实成两条**机械可测**的纪律，而这几个模块级常量就是那份"可测"：
#
#   ① `LIST_CONVERSATIONS_SQL` 只选会话自己那几列，**不选任何正文列**
#      （`content` / `steps` / `thinking`(消息的) / `sources` / `attachments` /
#      `context_summary`），也**不碰 `chat_messages` 这张表**——
#      列表页永远不 JOIN 消息表。用例直接断言这几条。
#   ② `LAST_ASSISTANT_PREVIEWS_SQL` 在 SQL 里 `substr(content, 1, ?)` 截断
#      （列表只要开头两行，不把整段正文搬进内存）。
#
# 注意 `conversations.thinking` **不在**禁列里：它是会话自己的"是否开思考"开关，
# 不是消息正文。禁列针对的是消息那侧的同名列。

#: 会话自己的列（`ConversationRecord` 需要的全部，且只有这些）。
#: **刻意不写 `SELECT *`**：`context_summary` / `summary_upto` 是正文那一侧的体积，
#: 列表页要它们没用（规范 4），而写成显式列名让"禁列"这条纪律在源码里一眼可查。
LIST_CONVERSATIONS_SQL = (
    "SELECT id, title, kb_ids, owner_id, model_pk, thinking, thinking_effort, pinned,"
    " workspace_id, archived_at_ms, created_at_ms, updated_at_ms"
    " FROM conversations"
)

#: 带 `q` 的变体：**标题或消息正文**包含匹配（D12 走查那次的修正）。
#: 用 `EXISTS` 而不是 JOIN：一条会话可能有多条消息命中，JOIN 会把它复制成多行，
#: 而调用方的 LIMIT 语义是"前 N 条**会话**"。`LIKE` 在 SQLite 里对 ASCII 不敏感、
#: 对非 ASCII 敏感——与 PG 的 ILIKE 恰好同一个口径，所以这里不换函数。
#: 拼的左边是**本文件里的字面量常量**（没有任何外部值进 SQL），S608 在这里是误报。
LIST_CONVERSATIONS_SEARCH_SQL = (
    LIST_CONVERSATIONS_SQL  # noqa: S608
    + r" WHERE title LIKE ? ESCAPE '\'"
    + r" OR EXISTS (SELECT 1 FROM chat_messages m"
    + r" WHERE m.conversation_id = conversations.id AND m.content LIKE ? ESCAPE '\')"
)

#: 服务层真正下推的那条排序（`ConversationService.list` 的归属/工作区/归档过滤
#: 发生在 Python 侧）。`idx_conversations_recent` 就是照它建的。
LIST_CONVERSATIONS_ORDER = " ORDER BY pinned DESC, updated_at_ms DESC"

#: 列表预览的截断长度（§1.4-4 ②）。
PREVIEW_CHARS = 200

LAST_ASSISTANT_PREVIEWS_SQL = (
    "SELECT conversation_id, substr(content, 1, ?) AS preview"
    " FROM (SELECT conversation_id, content,"
    " ROW_NUMBER() OVER (PARTITION BY conversation_id"
    " ORDER BY created_at_ms DESC, rowid DESC) AS rn"
    " FROM chat_messages"
    " WHERE role = 'assistant' AND conversation_id IN ({ids}))"
    " WHERE rn = 1"
)
"""每个会话最后一条回答的**开头 PREVIEW_CHARS 字**。

PG 那边是 ``DISTINCT ON (conversation_id)``；SQLite 没有这个语法，用窗口函数
（3.25+，远低于本库的 3.37 下限）等价表达：分组内按时间倒序取第一行。
``rowid DESC`` 是同一毫秒里的兜底——否则"最后一条"在毫秒内没有确定的答案。

``{ids}`` 由 :func:`_placeholders` 填，永远只出现 ``?``。
"""


def _mcp_server_from_row(row: sqlite3.Row) -> MCPServerRecord:
    return MCPServerRecord(
        id=row["id"],
        name=row["name"],
        transport=row["transport"],
        target=row["target"],
        args=tuple(json.loads(row["args"])),
        env=dict(json.loads(row["env"])),
        headers=dict(json.loads(row["headers"])),
        policy=row["policy"],
        enabled=bool(row["enabled"]),
        owner_id=row["owner_id"],
        created_at=_load(row["created_at_ms"]),
        updated_at=_load(row["updated_at_ms"]),
    )


class SqliteMetaStore:
    """本机域的元数据仓储：会话 / 笔记 / 设置 / 工作区 / 定时任务 / MCP / 模型 / 用量。

    **不继承 `MetaStore`**（有意）：那个 ABC 有两百来个方法，其中知识库那半在本机
    没有数据源，硬凑出来只会得到一堆"抛异常的实现"，还会让"这个类到底覆盖了什么"
    变得看不出来。覆盖范围由 ``LOCAL_METHODS`` 机械给出，用例逐名核对。
    """

    def __init__(self, database: Database) -> None:
        self._db = database

    # ------------------------------------------------------------------ 设置

    def get_setting(self, key: str) -> str | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def get_settings(self, keys: Sequence[str]) -> dict[str, str]:
        wanted = list(dict.fromkeys(keys))
        if not wanted:
            return {}
        sql = (
            "SELECT key, value FROM app_settings"  # noqa: S608
            f" WHERE key IN ({_placeholders(len(wanted))})"
        )
        with self._db.read() as conn:
            rows = conn.execute(sql, tuple(wanted)).fetchall()
        return {str(row["key"]): str(row["value"]) for row in rows}

    def set_setting(self, key: str, value: str) -> None:
        """写一个设置项（UPSERT）。

        ``updated_at_ms`` 也走 ``max(新值, 旧值 + 1)``：改设置是"必须推进"的写，
        而"这一项什么时候改的"在运维排障时是有用的东西——同一毫秒里改两次时
        它至少能说出先后。
        """
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO app_settings (key, value, updated_at_ms) VALUES (?, ?, ?)"
                " ON CONFLICT (key) DO UPDATE SET value = excluded.value,"
                " updated_at_ms = max(excluded.updated_at_ms, app_settings.updated_at_ms + 1)",
                (key, value, _dump(_now())),
            )

    def delete_setting(self, key: str) -> None:
        with self._db.session() as conn:
            conn.execute("DELETE FROM app_settings WHERE key = ?", (key,))

    # ------------------------------------------------------------------ 会话

    @staticmethod
    def _conversation_from_row(row: sqlite3.Row) -> ConversationRecord:
        return ConversationRecord(
            id=row["id"],
            title=row["title"],
            kb_ids=tuple(json.loads(row["kb_ids"])),
            owner_id=row["owner_id"],
            model_pk=row["model_pk"],
            # 可空列在库里是 NULL：``None`` 表示"跟随全局默认"，不要折成 False
            thinking=None if row["thinking"] is None else bool(row["thinking"]),
            thinking_effort=row["thinking_effort"],
            pinned=bool(row["pinned"]),
            # 未归档的会话这一列是 NULL —— 保持 None，不要折成空串
            workspace_id=row["workspace_id"],
            archived_at=_load(row["archived_at_ms"]),
            created_at=_load(row["created_at_ms"]),
            updated_at=_load(row["updated_at_ms"]),
        )

    def create_conversation(self, record: ConversationRecord) -> ConversationRecord:
        now = _now()
        record.created_at = record.created_at or now
        record.updated_at = record.updated_at or now
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO conversations"
                " (id, title, kb_ids, owner_id, model_pk, thinking, thinking_effort,"
                "  pinned, context_summary, summary_upto, workspace_id, archived_at_ms,"
                "  created_at_ms, updated_at_ms)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.title,
                    _json(list(record.kb_ids)),
                    record.owner_id,
                    record.model_pk,
                    None if record.thinking is None else int(record.thinking),
                    record.thinking_effort,
                    int(record.pinned),
                    "",
                    None,
                    record.workspace_id,
                    _dump(record.archived_at),
                    _dump(record.created_at),
                    _dump(record.updated_at),
                ),
            )
        return record

    def get_conversation(self, conversation_id: str) -> ConversationRecord | None:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
        return self._conversation_from_row(row) if row else None

    def list_conversations(
        self, *, limit: int | None = None, q: str | None = None
    ) -> list[ConversationRecord]:
        """置顶优先，其次最近更新；``q`` 按**标题或消息正文**包含匹配。

        SQL 文本来自模块级的两个常量（见那边的说明）：列表路径**不选正文列、
        不碰消息表**，这一点由用例机械断言，别把它改成 `SELECT *`。
        """
        sql = LIST_CONVERSATIONS_SQL
        params: list[Any] = []
        if q:
            # 与文档搜索同一套转义：用户搜 "a_b" 要字面匹配，而不是"a 后跟任意一字符"
            escaped = q.replace("\\", r"\\").replace("%", r"\%").replace("_", r"\_")
            sql = LIST_CONVERSATIONS_SEARCH_SQL
            params.extend([f"%{escaped}%", f"%{escaped}%"])
        sql += LIST_CONVERSATIONS_ORDER
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        with self._db.read() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._conversation_from_row(row) for row in rows]

    def rename_conversation(self, conversation_id: str, title: str) -> None:
        # 改名不推 updated_at：否则用户整理一遍标题列表，会话按"最近更新"的排序
        # 会全乱——他想按对话发生的时间找，不是按自己改标题的时间
        with self._db.session() as conn:
            conn.execute(
                "UPDATE conversations SET title = ? WHERE id = ?", (title, conversation_id)
            )

    def set_conversation_archived(self, conversation_id: str, archived: bool) -> None:
        # 不推 updated_at：归类动作不该改变"最近活动"的名次（与置顶/改名同理）
        with self._db.session() as conn:
            conn.execute(
                "UPDATE conversations SET archived_at_ms = CASE WHEN ? THEN ? ELSE NULL END"
                " WHERE id = ?",
                (int(archived), _dump(_now()), conversation_id),
            )

    def set_conversation_workspace(self, conversation_id: str, workspace_id: str | None) -> None:
        # 不推 updated_at：整理动作不该改变"最近活动"的名次
        with self._db.session() as conn:
            conn.execute(
                "UPDATE conversations SET workspace_id = ? WHERE id = ?",
                (workspace_id, conversation_id),
            )

    def set_conversation_pinned(self, conversation_id: str, pinned: bool) -> None:
        # 与改名同理：不推 updated_at
        with self._db.session() as conn:
            conn.execute(
                "UPDATE conversations SET pinned = ? WHERE id = ?",
                (int(pinned), conversation_id),
            )

    def set_conversation_model(self, conversation_id: str, model_pk: str | None) -> None:
        # 与改名同理：切模型不算"发生了对话"，不推 updated_at
        with self._db.session() as conn:
            conn.execute(
                "UPDATE conversations SET model_pk = ? WHERE id = ?",
                (model_pk, conversation_id),
            )

    def set_conversation_thinking(
        self, conversation_id: str, thinking: bool | None, effort: str | None
    ) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE conversations SET thinking = ?, thinking_effort = ? WHERE id = ?",
                (None if thinking is None else int(thinking), effort, conversation_id),
            )

    def touch_conversation(self, conversation_id: str) -> None:
        """推 `updated_at` 到"现在"，**至少比旧值大 1 毫秒**（风险 R8）。

        这是全仓唯一的"推进最近活动"入口，同一毫秒里被调两次时（一轮对话里
        消息与事件都落完才 touch）必须还分得出先后——列表就是按它排的。
        """
        with self._db.session() as conn:
            conn.execute(
                "UPDATE conversations SET updated_at_ms = max(?, updated_at_ms + 1) WHERE id = ?",
                (_dump(_now()), conversation_id),
            )

    def get_conversation_summary(self, conversation_id: str) -> tuple[str, str | None]:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT context_summary, summary_upto FROM conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
        if row is None:
            return "", None
        return row["context_summary"] or "", row["summary_upto"]

    def set_conversation_summary(
        self, conversation_id: str, summary: str, upto_message_id: str | None
    ) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE conversations SET context_summary = ?, summary_upto = ? WHERE id = ?",
                (summary, upto_message_id, conversation_id),
            )

    def delete_conversation(self, conversation_id: str) -> None:
        """删会话及其消息。

        显式删消息与产物记录（**意图写在代码里比藏在 schema 里可读**）——
        与会话事件同一口径，后者由外键级联删掉。
        产物的**文件本体**由服务层先处理：落在对象存储里的那份要删掉，
        落在工作区里的那些是用户项目里的真实文件，不能跟着会话一起消失。
        """
        with self._db.session() as conn:
            conn.execute("DELETE FROM chat_messages WHERE conversation_id = ?", (conversation_id,))
            conn.execute(
                "DELETE FROM conversation_artifacts WHERE conversation_id = ?",
                (conversation_id,),
            )
            conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))

    def count_workspace_conversations(self, workspace_id: str) -> int:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT count(*) AS total FROM conversations WHERE workspace_id = ?",
                (workspace_id,),
            ).fetchone()
        return int(row["total"]) if row else 0

    def delete_chat_messages(self, message_ids: Sequence[str]) -> int:
        if not message_ids:
            return 0
        # placeholders 只由 "?" 拼成（数量来自 len），真正的值走参数绑定
        placeholders = _placeholders(len(message_ids))
        with self._db.session() as conn:
            cursor = conn.execute(
                f"DELETE FROM chat_messages WHERE id IN ({placeholders})",  # noqa: S608
                list(message_ids),
            )
        return int(cursor.rowcount or 0)

    # ------------------------------------------------------------------ 消息

    @staticmethod
    def _message_from_row(row: sqlite3.Row) -> ChatMessageRecord:
        return ChatMessageRecord(
            id=row["id"],
            conversation_id=row["conversation_id"],
            role=row["role"],
            content=row["content"],
            sources=tuple(json.loads(row["sources"])),
            steps=tuple(json.loads(row["steps"] or "[]")),
            thinking=row["thinking"] or "",
            attachments=tuple(json.loads(row["attachments"] or "[]")),
            created_at=_load(row["created_at_ms"]),
        )

    def append_message(self, record: ChatMessageRecord) -> ChatMessageRecord:
        record.created_at = record.created_at or _now()
        with self._db.session() as conn:
            self._insert_message(conn, record)
        return record

    @staticmethod
    def _insert_message(conn: sqlite3.Connection, record: ChatMessageRecord) -> None:
        """在**给定事务里**插一条消息（``append_message`` 与 ``append_turn`` 共用）。

        抽出来是为了"消息与事件同一事务"那条要求：各写一份 INSERT 的话，
        迟早有一处漏掉新列（这张表已经补过 ``steps`` / ``thinking`` / ``attachments``）。
        """
        conn.execute(
            "INSERT INTO chat_messages"
            " (id, conversation_id, role, content, sources, steps, thinking, attachments,"
            "  created_at_ms)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                record.id,
                record.conversation_id,
                record.role,
                record.content,
                _json([dict(item) for item in record.sources]),
                _json([dict(item) for item in record.steps]),
                record.thinking,
                _json([dict(item) for item in record.attachments]),
                _dump(record.created_at),
            ),
        )

    def list_messages(self, conversation_id: str) -> list[ChatMessageRecord]:
        """按 ``created_at_ms`` 升序；同一毫秒里用 ``rowid``（插入序）兜底。

        PG 那边用的是系统列 ``ctid``，同一个用意。这张表不改消息内容
        （「重新生成」是删尾部再追加），所以 rowid 就是插入序。
        """
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM chat_messages WHERE conversation_id = ?"
                " ORDER BY created_at_ms, rowid",
                (conversation_id,),
            ).fetchall()
        return [self._message_from_row(row) for row in rows]

    def count_messages(self, conversation_id: str) -> int:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        return int(row["n"])

    def last_assistant_previews(self, conversation_ids: Sequence[str]) -> dict[str, str]:
        """一次查完每个会话最后一条回答的**开头 PREVIEW_CHARS 字**。

        截断发生在 SQL 里（``substr``），不是读回来再切：列表页要的只是开头两行，
        把整段正文搬进内存再丢掉，正是"列表页拖着正文"那条规范要防的事。
        """
        if not conversation_ids:
            return {}
        sql = LAST_ASSISTANT_PREVIEWS_SQL.format(ids=_placeholders(len(conversation_ids)))
        with self._db.read() as conn:
            rows = conn.execute(sql, (PREVIEW_CHARS, *conversation_ids)).fetchall()
        return {row["conversation_id"]: row["preview"] for row in rows}

    # ------------------------------------------------------------------ 会话事件

    @staticmethod
    def _session_event_from_row(row: sqlite3.Row) -> SessionEventRecord:
        return SessionEventRecord(
            id=int(row["id"]),
            conversation_id=row["conversation_id"],
            seq=int(row["seq"]),
            kind=row["kind"],
            payload=dict(json.loads(row["payload"])),
            created_at=_load(row["created_at_ms"]),
        )

    def append_turn(
        self,
        *,
        messages: Sequence[ChatMessageRecord],
        events: Sequence[SessionEventRecord],
    ) -> None:
        """一轮的消息与它的事件**同一个事务**。

        顺序刻意是"先消息、后事件"？不——**两条都在一个事务里，先后无所谓**，
        唯一重要的是它们要么都在、要么都不在。
        """
        if not messages:
            return
        now = _now()
        for message in messages:
            message.created_at = message.created_at or now
        with self._db.session() as conn:
            for message in messages:
                self._insert_message(conn, message)
            if events:
                self._insert_events(conn, events, now)

    def append_session_events(
        self, records: Sequence[SessionEventRecord]
    ) -> list[SessionEventRecord]:
        if not records:
            return []
        with self._db.session() as conn:
            return self._insert_events(conn, records, _now())

    def _insert_events(
        self,
        conn: sqlite3.Connection,
        records: Sequence[SessionEventRecord],
        now: datetime,
    ) -> list[SessionEventRecord]:
        """在给定事务里只追加一批事件，并把 ``seq`` / ``id`` 补回记录。

        ``seq`` 在**写这个事务里**算（``max(seq)+1`` 起逐个递增）：让数据库之外的
        任何一方来决定序号，都会在下一次并发写时撞上唯一约束。

        **删掉了 PG 那句 ``SELECT … FOR UPDATE``**（§1.5）：这里整个写事务已经在
        ``BEGIN IMMEDIATE`` 的**库级写锁**里，任何另一方都进不来，锁会话行是多余的一跳。
        """
        conversation_id = records[0].conversation_id
        row = conn.execute(
            "SELECT COALESCE(MAX(seq), 0) AS s FROM session_events WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchone()
        seq = int(row["s"]) if row is not None else 0
        for record in records:
            if record.conversation_id != conversation_id:
                # 一批事件必须同属一个会话：跨会话的那一批没法用一条 max 算 seq，
                # 硬要支持只会让这个函数变成两段几乎不重叠的代码。
                raise ValueError("同一批会话事件必须属于同一个会话")
            seq += 1
            record.seq = seq
            record.created_at = record.created_at or now
            cursor = conn.execute(
                "INSERT INTO session_events (conversation_id, seq, kind, payload, created_at_ms)"
                " VALUES (?, ?, ?, ?, ?)",
                (
                    record.conversation_id,
                    record.seq,
                    record.kind,
                    _json(record.payload),
                    _dump(record.created_at),
                ),
            )
            record.id = int(cursor.lastrowid or 0)
        return list(records)

    def list_session_events(
        self, conversation_id: str, *, kinds: Sequence[str] | None = None
    ) -> list[SessionEventRecord]:
        sql = "SELECT * FROM session_events WHERE conversation_id = ?"
        params: list[Any] = [conversation_id]
        if kinds:
            # `IN (?,?,…)` 而不是 `= ANY(?)`：SQLite 没有数组参数，
            # 而拼字面量就又多一处"把外部值拼进 SQL"的机会。
            sql += f" AND kind IN ({_placeholders(len(kinds))})"
            params.extend(list(kinds))
        # **按 seq 排序，不按 created_at_ms**：同一毫秒里的一批并发工具调用
        # 靠时间戳分不出先后（见 `SessionEventRecord.seq`）。
        sql += " ORDER BY seq"
        with self._db.read() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._session_event_from_row(row) for row in rows]

    # ------------------------------------------------------------------ 会话产物

    @staticmethod
    def _artifact_from_row(row: sqlite3.Row) -> ConversationArtifactRecord:
        return ConversationArtifactRecord(
            id=row["id"],
            conversation_id=row["conversation_id"],
            name=row["name"],
            format=row["format"],
            size_bytes=int(row["size_bytes"] or 0),
            storage=row["storage"],
            location=row["location"] or "",
            workspace_id=row["workspace_id"],
            owner_id=row["owner_id"],
            knowledge_base_id=row["knowledge_base_id"],
            document_id=row["document_id"],
            created_at=_load(row["created_at_ms"]),
        )

    def create_artifact(self, record: ConversationArtifactRecord) -> ConversationArtifactRecord:
        record.created_at = record.created_at or _now()
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO conversation_artifacts"
                " (id, conversation_id, name, format, size_bytes, storage, location,"
                "  workspace_id, owner_id, knowledge_base_id, document_id, created_at_ms)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.conversation_id,
                    record.name,
                    record.format,
                    record.size_bytes,
                    record.storage,
                    record.location,
                    record.workspace_id,
                    record.owner_id,
                    record.knowledge_base_id,
                    record.document_id,
                    _dump(record.created_at),
                ),
            )
        return record

    def get_artifact(self, artifact_id: str) -> ConversationArtifactRecord | None:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT * FROM conversation_artifacts WHERE id = ?", (artifact_id,)
            ).fetchone()
        return None if row is None else self._artifact_from_row(row)

    def list_artifacts(self, conversation_id: str) -> list[ConversationArtifactRecord]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM conversation_artifacts WHERE conversation_id = ?"
                " ORDER BY created_at_ms, id",
                (conversation_id,),
            ).fetchall()
        return [self._artifact_from_row(row) for row in rows]

    def mark_artifact_ingested(
        self, artifact_id: str, *, knowledge_base_id: str, document_id: str
    ) -> None:
        """记下"这份产物进了哪个库"。**只写这两个字段**，不动 ``location``：
        入库是**复制**一份进知识库，产物本身还在原处。
        """
        with self._db.session() as conn:
            conn.execute(
                "UPDATE conversation_artifacts"
                " SET knowledge_base_id = ?, document_id = ? WHERE id = ?",
                (knowledge_base_id, document_id, artifact_id),
            )

    # ------------------------------------------------------------------ 工作区

    @staticmethod
    def _workspace_from_row(row: sqlite3.Row) -> WorkspaceRecord:
        return WorkspaceRecord(
            id=row["id"],
            name=row["name"],
            root_path=row["root_path"],
            owner_id=row["owner_id"],
            description=row["description"],
            kb_ids=tuple(json.loads(row["kb_ids"])),
            created_at=_load(row["created_at_ms"]),
            updated_at=_load(row["updated_at_ms"]),
            archived_at=_load(row["archived_at_ms"]),
            # 按列名取，不按位置：这一行的列序会随迁移增长。
            # `device_name` 是可空列，存量记录读回来是 NULL——归一到空串，
            # 免得 `None` 从存储层漏进模型的 `str` 字段。
            device_id=row["device_id"],
            device_name=row["device_name"] or "",
        )

    def create_workspace(self, record: WorkspaceRecord) -> WorkspaceRecord:
        now = _now()
        record.created_at = record.created_at or now
        record.updated_at = record.updated_at or now
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO workspaces"
                " (id, owner_id, name, root_path, description, kb_ids, archived_at_ms,"
                "  device_id, device_name, created_at_ms, updated_at_ms)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.owner_id,
                    record.name,
                    record.root_path,
                    record.description,
                    _json(list(record.kb_ids)),
                    _dump(record.archived_at),
                    # `None` 原样落库 = 服务器端（网页版/直连 API 看到的那些）
                    record.device_id,
                    record.device_name or "",
                    _dump(record.created_at),
                    _dump(record.updated_at),
                ),
            )
        return record

    def get_workspace(self, workspace_id: str) -> WorkspaceRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,)).fetchone()
        return self._workspace_from_row(row) if row else None

    def list_workspaces(
        self, *, device_id: str | None = None, any_device: bool = False
    ) -> list[WorkspaceRecord]:
        # 设备过滤三态（见 base.py 协议）：`any_device` 不过滤；否则精确比 `device_id`，
        # 其中 `None` 是**服务器端**这一档（`IS NULL`，不是"没条件"）。
        # 归属过滤不在这里做——存储层不认识调用者身份（与会话列表同一取舍）。
        sql = "SELECT * FROM workspaces"
        params: list[Any] = []
        if not any_device:
            if device_id is None:
                sql += " WHERE device_id IS NULL"
            else:
                sql += " WHERE device_id = ?"
                params.append(device_id)
        sql += " ORDER BY updated_at_ms DESC"
        with self._db.read() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._workspace_from_row(row) for row in rows]

    def update_workspace(self, record: WorkspaceRecord) -> WorkspaceRecord:
        record.updated_at = _now()
        with self._db.session() as conn:
            conn.execute(
                "UPDATE workspaces SET name = ?, root_path = ?, description = ?, kb_ids = ?,"
                " updated_at_ms = max(?, updated_at_ms + 1) WHERE id = ?",
                (
                    record.name,
                    record.root_path,
                    record.description,
                    _json(list(record.kb_ids)),
                    _dump(record.updated_at),
                    record.id,
                ),
            )
        return record

    def set_workspace_archived(self, workspace_id: str, archived: bool) -> None:
        # 与 `set_conversation_archived` 逐字同一条：**不推 updated_at**。
        with self._db.session() as conn:
            conn.execute(
                "UPDATE workspaces SET archived_at_ms = CASE WHEN ? THEN ? ELSE NULL END"
                " WHERE id = ?",
                (int(archived), _dump(_now()), workspace_id),
            )

    def delete_workspace(self, workspace_id: str) -> None:
        # 外键是 ON DELETE SET NULL：里面的会话**退回未归档**，不跟着删。
        with self._db.session() as conn:
            conn.execute("DELETE FROM workspaces WHERE id = ?", (workspace_id,))

    # ------------------------------------------------------------------ 定时任务

    @staticmethod
    def _scheduled_from_row(row: sqlite3.Row) -> ScheduledTaskRecord:
        return ScheduledTaskRecord(
            id=row["id"],
            name=row["name"],
            prompt=row["prompt"],
            kind=row["kind"],
            cron=row["cron"],
            run_at=_load(row["run_at_ms"]),
            next_run_at=_load(row["next_run_at_ms"]),
            enabled=bool(row["enabled"]),
            kb_ids=tuple(json.loads(row["kb_ids"])),
            model_pk=row["model_pk"],
            # 可空列：``None`` = 跟随会话/全局默认，不要折成 False
            thinking=None if row["thinking"] is None else bool(row["thinking"]),
            thinking_effort=row["thinking_effort"],
            conversation_id=row["conversation_id"],
            owner_id=row["owner_id"],
            last_run_at=_load(row["last_run_at_ms"]),
            last_status=row["last_status"],
            last_error=row["last_error"],
            run_count=int(row["run_count"]),
            created_at=_load(row["created_at_ms"]),
            updated_at=_load(row["updated_at_ms"]),
        )

    def create_scheduled_task(self, record: ScheduledTaskRecord) -> ScheduledTaskRecord:
        now = _now()
        record.created_at = record.created_at or now
        record.updated_at = record.updated_at or now
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO scheduled_tasks"
                " (id, name, prompt, kind, cron, run_at_ms, next_run_at_ms, enabled, kb_ids,"
                "  model_pk, thinking, thinking_effort, conversation_id, owner_id,"
                "  last_run_at_ms, last_status, last_error, run_count, created_at_ms,"
                "  updated_at_ms)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.name,
                    record.prompt,
                    record.kind,
                    record.cron,
                    _dump(record.run_at),
                    _dump(record.next_run_at),
                    int(record.enabled),
                    _json(list(record.kb_ids)),
                    record.model_pk,
                    None if record.thinking is None else int(record.thinking),
                    record.thinking_effort,
                    record.conversation_id,
                    record.owner_id,
                    _dump(record.last_run_at),
                    record.last_status,
                    record.last_error,
                    record.run_count,
                    _dump(record.created_at),
                    _dump(record.updated_at),
                ),
            )
        return record

    def get_scheduled_task(self, scheduled_id: str) -> ScheduledTaskRecord | None:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT * FROM scheduled_tasks WHERE id = ?", (scheduled_id,)
            ).fetchone()
        return self._scheduled_from_row(row) if row else None

    def list_scheduled_tasks(self) -> list[ScheduledTaskRecord]:
        # 待跑的排前面、按时间正序；跑完/停用的（`next_run_at_ms IS NULL`）沉到最后，
        # 内部按最近更新倒序——用户找的多半是"下次什么时候跑"。
        # SQLite 的 `ORDER BY x ASC` 默认把 NULL 排最前，所以 `NULLS LAST` 必须显式写。
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM scheduled_tasks"
                " ORDER BY next_run_at_ms ASC NULLS LAST, updated_at_ms DESC"
            ).fetchall()
        return [self._scheduled_from_row(row) for row in rows]

    def update_scheduled_task(self, record: ScheduledTaskRecord) -> ScheduledTaskRecord:
        record.updated_at = _now()
        with self._db.session() as conn:
            conn.execute(
                "UPDATE scheduled_tasks SET name = ?, prompt = ?, kind = ?, cron = ?,"
                " run_at_ms = ?, next_run_at_ms = ?, enabled = ?, kb_ids = ?, model_pk = ?,"
                " thinking = ?, thinking_effort = ?, conversation_id = ?,"
                " last_run_at_ms = ?, last_status = ?, last_error = ?, run_count = ?,"
                " updated_at_ms = max(?, updated_at_ms + 1) WHERE id = ?",
                (
                    record.name,
                    record.prompt,
                    record.kind,
                    record.cron,
                    _dump(record.run_at),
                    _dump(record.next_run_at),
                    int(record.enabled),
                    _json(list(record.kb_ids)),
                    record.model_pk,
                    None if record.thinking is None else int(record.thinking),
                    record.thinking_effort,
                    record.conversation_id,
                    _dump(record.last_run_at),
                    record.last_status,
                    record.last_error,
                    record.run_count,
                    _dump(record.updated_at),
                    record.id,
                ),
            )
        return record

    def delete_scheduled_task(self, scheduled_id: str) -> None:
        # 只删这条调度：**已经跑出来的会话不删**（那是用户问过的内容）
        with self._db.session() as conn:
            conn.execute("DELETE FROM scheduled_tasks WHERE id = ?", (scheduled_id,))

    def due_scheduled_tasks(self, *, now: datetime, limit: int = 10) -> list[ScheduledTaskRecord]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM scheduled_tasks"
                " WHERE enabled = 1 AND next_run_at_ms IS NOT NULL AND next_run_at_ms <= ?"
                " ORDER BY next_run_at_ms ASC LIMIT ?",
                (_dump(now), max(1, limit)),
            ).fetchall()
        return [self._scheduled_from_row(row) for row in rows]

    def arm_scheduled_task(
        self,
        scheduled_id: str,
        *,
        expected_next_run_at: datetime | None,
        next_run_at: datetime | None,
        enabled: bool,
    ) -> bool:
        """认领一次运行（CAS）。**判定写进 WHERE**，不靠"先读后写"——
        两个 worker 同时扫到同一条时，只有一条 UPDATE 能改到行（见协议里的说明）。

        PG 那边用 ``IS NOT DISTINCT FROM`` 是为了让 ``NULL = NULL`` 成立
        （一次性任务的认领正是从 NULL 认领）；SQLite 的 ``IS`` 就是同一个语义，
        而且读起来更像一句话。
        """
        with self._db.session() as conn:
            cursor = conn.execute(
                "UPDATE scheduled_tasks SET next_run_at_ms = ?, enabled = ?,"
                " updated_at_ms = max(?, updated_at_ms + 1)"
                " WHERE id = ? AND next_run_at_ms IS ?",
                (
                    _dump(next_run_at),
                    int(enabled),
                    _dump(_now()),
                    scheduled_id,
                    _dump(expected_next_run_at),
                ),
            )
            return cursor.rowcount > 0

    def finish_scheduled_run(
        self,
        scheduled_id: str,
        *,
        status: str,
        error: str | None,
        last_run_at: datetime,
        conversation_id: str | None = None,
    ) -> None:
        """记一次运行的结果。

        ``conversation_id`` **用 COALESCE 而不是直接覆盖**：它只在第一次运行时为空，
        之后每次都传同一个值；万一某次调用忘了带，COALESCE 拦住的是"任务与它
        那条会话失联"（那种状态在界面上表现为"跑过但看不到结果"）。
        """
        with self._db.session() as conn:
            conn.execute(
                "UPDATE scheduled_tasks SET last_run_at_ms = ?, last_status = ?,"
                " last_error = ?, run_count = run_count + 1,"
                " updated_at_ms = max(?, updated_at_ms + 1),"
                " conversation_id = COALESCE(?, conversation_id)"
                " WHERE id = ?",
                (
                    _dump(last_run_at),
                    status,
                    error or "",
                    _dump(_now()),
                    conversation_id,
                    scheduled_id,
                ),
            )

    # ------------------------------------------------------------------ MCP 服务

    def create_mcp_server(self, record: MCPServerRecord) -> MCPServerRecord:
        now = _now()
        record.created_at = record.created_at or now
        record.updated_at = record.updated_at or now
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO mcp_servers"
                " (id, owner_id, name, transport, target, args, env, headers, policy,"
                "  enabled, created_at_ms, updated_at_ms)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.owner_id,
                    record.name,
                    record.transport,
                    record.target,
                    _json(list(record.args)),
                    _json(dict(record.env)),
                    _json(dict(record.headers)),
                    record.policy,
                    int(record.enabled),
                    _dump(record.created_at),
                    _dump(record.updated_at),
                ),
            )
        return record

    def get_mcp_server(self, server_id: str) -> MCPServerRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM mcp_servers WHERE id = ?", (server_id,)).fetchone()
        return _mcp_server_from_row(row) if row else None

    def list_mcp_servers(self) -> list[MCPServerRecord]:
        with self._db.read() as conn:
            rows = conn.execute("SELECT * FROM mcp_servers ORDER BY updated_at_ms DESC").fetchall()
        return [_mcp_server_from_row(row) for row in rows]

    def update_mcp_server(self, record: MCPServerRecord) -> MCPServerRecord:
        record.updated_at = _now()
        with self._db.session() as conn:
            conn.execute(
                "UPDATE mcp_servers SET name = ?, transport = ?, target = ?, args = ?,"
                " env = ?, headers = ?, policy = ?, enabled = ?,"
                " updated_at_ms = max(?, updated_at_ms + 1) WHERE id = ?",
                (
                    record.name,
                    record.transport,
                    record.target,
                    _json(list(record.args)),
                    _json(dict(record.env)),
                    _json(dict(record.headers)),
                    record.policy,
                    int(record.enabled),
                    _dump(record.updated_at),
                    record.id,
                ),
            )
        return record

    def delete_mcp_server(self, server_id: str) -> None:
        with self._db.session() as conn:
            conn.execute("DELETE FROM mcp_servers WHERE id = ?", (server_id,))

    # ------------------------------------------------------------------ 模型注册器

    @staticmethod
    def _provider_from_row(row: sqlite3.Row) -> ModelProviderRecord:
        return ModelProviderRecord(
            id=row["id"],
            kind=row["kind"],
            name=row["name"],
            base_url=row["base_url"],
            api_key=row["api_key"],
            enabled=bool(row["enabled"]),
            created_at=_load(row["created_at_ms"]),
            updated_at=_load(row["updated_at_ms"]),
        )

    @staticmethod
    def _model_from_row(row: sqlite3.Row) -> RegisteredModelRecord:
        return RegisteredModelRecord(
            id=row["id"],
            provider_id=row["provider_id"],
            model_id=row["model_id"],
            label=row["label"],
            dim=row["dim"],
            capabilities=tuple(json.loads(row["capabilities"])),
            options=dict(json.loads(row["options"])),
            created_at=_load(row["created_at_ms"]),
            updated_at=_load(row["updated_at_ms"]),
        )

    def create_model_provider(self, record: ModelProviderRecord) -> ModelProviderRecord:
        now = _now()
        record.created_at = record.created_at or now
        record.updated_at = record.updated_at or now
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO model_providers"
                " (id, kind, name, base_url, api_key, enabled, created_at_ms, updated_at_ms)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.kind,
                    record.name,
                    record.base_url,
                    record.api_key,
                    int(record.enabled),
                    _dump(record.created_at),
                    _dump(record.updated_at),
                ),
            )
        return record

    def get_model_provider(self, provider_id: str) -> ModelProviderRecord | None:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT * FROM model_providers WHERE id = ?", (provider_id,)
            ).fetchone()
        return self._provider_from_row(row) if row else None

    def list_model_providers(self) -> list[ModelProviderRecord]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM model_providers ORDER BY created_at_ms, id"
            ).fetchall()
        return [self._provider_from_row(row) for row in rows]

    def update_model_provider(self, record: ModelProviderRecord) -> None:
        record.updated_at = _now()
        with self._db.session() as conn:
            conn.execute(
                "UPDATE model_providers SET kind = ?, name = ?, base_url = ?, api_key = ?,"
                " enabled = ?, updated_at_ms = max(?, updated_at_ms + 1) WHERE id = ?",
                (
                    record.kind,
                    record.name,
                    record.base_url,
                    record.api_key,
                    int(record.enabled),
                    _dump(record.updated_at),
                    record.id,
                ),
            )

    def delete_model_provider(self, provider_id: str) -> None:
        # 显式删子行（虽然外键级联也会删）：意图写在代码里比藏在 schema 里可读。
        # 只删供应商会留下指向不存在供应商的孤儿模型，而它还会出现在模型下拉里。
        with self._db.session() as conn:
            conn.execute("DELETE FROM model_registry WHERE provider_id = ?", (provider_id,))
            conn.execute("DELETE FROM model_providers WHERE id = ?", (provider_id,))

    def create_registered_model(self, record: RegisteredModelRecord) -> RegisteredModelRecord:
        now = _now()
        record.created_at = record.created_at or now
        record.updated_at = record.updated_at or now
        try:
            with self._db.session() as conn:
                conn.execute(
                    "INSERT INTO model_registry"
                    " (id, provider_id, model_id, label, dim, capabilities, options,"
                    "  created_at_ms, updated_at_ms)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        record.id,
                        record.provider_id,
                        record.model_id,
                        record.label,
                        record.dim,
                        _json(list(record.capabilities)),
                        _json(record.options),
                        _dump(record.created_at),
                        _dump(record.updated_at),
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise ConflictError(f"该供应商下已经登记过模型 {record.model_id}") from exc
        return record

    def get_registered_model(self, model_pk: str) -> RegisteredModelRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM model_registry WHERE id = ?", (model_pk,)).fetchone()
        return self._model_from_row(row) if row else None

    def list_registered_models(self, provider_id: str | None = None) -> list[RegisteredModelRecord]:
        sql = "SELECT * FROM model_registry"
        params: list[Any] = []
        if provider_id is not None:
            sql += " WHERE provider_id = ?"
            params.append(provider_id)
        sql += " ORDER BY created_at_ms, id"
        with self._db.read() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._model_from_row(row) for row in rows]

    def update_registered_model(self, record: RegisteredModelRecord) -> None:
        record.updated_at = _now()
        with self._db.session() as conn:
            conn.execute(
                "UPDATE model_registry SET model_id = ?, label = ?, dim = ?, capabilities = ?,"
                " options = ?, updated_at_ms = max(?, updated_at_ms + 1) WHERE id = ?",
                (
                    record.model_id,
                    record.label,
                    record.dim,
                    _json(list(record.capabilities)),
                    _json(record.options),
                    _dump(record.updated_at),
                    record.id,
                ),
            )

    def delete_registered_model(self, model_pk: str) -> None:
        with self._db.session() as conn:
            conn.execute("DELETE FROM model_registry WHERE id = ?", (model_pk,))

    def resolve_model_binding(
        self, key: str
    ) -> tuple[ModelProviderRecord, RegisteredModelRecord] | None:
        """一条 JOIN 解出绑定（见 base.py 的同名方法：这是热路径）。

        PG 那边为了绕开"两张表都有 id / name / created_at"的列名打架，用了
        ``to_jsonb(m)``；SQLite 没有这个函数，改用**列别名 + 就地构造**：
        一条语句仍然是原子的（分成两条查询会让"供应商刚好在这中间被删掉"
        变成一个要额外处理的中间态）。
        """
        with self._db.read() as conn:
            row = conn.execute(
                """
                SELECT m.id AS m_id, m.provider_id AS m_provider_id, m.model_id AS m_model_id,
                       m.label AS m_label, m.dim AS m_dim, m.capabilities AS m_capabilities,
                       m.options AS m_options, m.created_at_ms AS m_created_at_ms,
                       m.updated_at_ms AS m_updated_at_ms,
                       p.id AS p_id, p.kind AS p_kind, p.name AS p_name,
                       p.base_url AS p_base_url, p.api_key AS p_api_key, p.enabled AS p_enabled,
                       p.created_at_ms AS p_created_at_ms, p.updated_at_ms AS p_updated_at_ms
                  FROM app_settings s
                  JOIN model_registry m ON m.id = s.value
                  JOIN model_providers p ON p.id = m.provider_id
                 WHERE s.key = ?
                """,
                (key,),
            ).fetchone()
        if row is None:
            return None
        provider = ModelProviderRecord(
            id=row["p_id"],
            kind=row["p_kind"],
            name=row["p_name"],
            base_url=row["p_base_url"],
            api_key=row["p_api_key"],
            enabled=bool(row["p_enabled"]),
            created_at=_load(row["p_created_at_ms"]),
            updated_at=_load(row["p_updated_at_ms"]),
        )
        model = RegisteredModelRecord(
            id=row["m_id"],
            provider_id=row["m_provider_id"],
            model_id=row["m_model_id"],
            label=row["m_label"],
            dim=row["m_dim"],
            capabilities=tuple(json.loads(row["m_capabilities"])),
            options=dict(json.loads(row["m_options"])),
            created_at=_load(row["m_created_at_ms"]),
            updated_at=_load(row["m_updated_at_ms"]),
        )
        return provider, model

    # ------------------------------------------------------------------ 用量

    @staticmethod
    def _usage_from_row(row: sqlite3.Row) -> UsageEventRecord:
        return UsageEventRecord(
            id=row["id"],
            kind=row["kind"],
            provider=row["provider"],
            model_id=row["model_id"],
            prompt_tokens=row["prompt_tokens"],
            completion_tokens=row["completion_tokens"],
            items=row["items"],
            duration_ms=row["duration_ms"],
            source=row["source"],
            created_at=_load(row["created_at_ms"]),
        )

    def record_usage(self, record: UsageEventRecord) -> UsageEventRecord:
        """落一条用量。

        **不写 `reported` 列**（与 PG 侧一致）：它是 schema 里照搬过来的一列，
        而 ``UsageEventRecord.reported`` 是从 ``source`` 算出来的属性——
        写入路径从来不填那个列，别在这里"顺手补上"，那会让两份口径并存。
        """
        record.created_at = record.created_at or _now()
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO usage_events"
                " (id, kind, provider, model_id, prompt_tokens, completion_tokens,"
                "  items, duration_ms, source, created_at_ms)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.kind,
                    record.provider,
                    record.model_id,
                    record.prompt_tokens,
                    record.completion_tokens,
                    record.items,
                    record.duration_ms,
                    record.source,
                    _dump(record.created_at),
                ),
            )
        return record

    def list_usage(self, *, since: datetime | None = None) -> list[UsageEventRecord]:
        sql = "SELECT * FROM usage_events"
        params: tuple[Any, ...] = ()
        if since is not None:
            sql += " WHERE created_at_ms >= ?"
            params = (_dump(since),)
        sql += " ORDER BY created_at_ms"
        with self._db.read() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._usage_from_row(row) for row in rows]

    def purge_usage_before(self, before: datetime) -> int:
        with self._db.session() as conn:
            cursor = conn.execute(
                "DELETE FROM usage_events WHERE created_at_ms < ?", (_dump(before),)
            )
        return int(cursor.rowcount or 0)

    # ------------------------------------------------------------------ 笔记

    @staticmethod
    def _note_from_row(row: sqlite3.Row, tags: Sequence[str] = ()) -> NoteRecord:
        return NoteRecord(
            id=row["id"],
            user_id=row["user_id"],
            title=row["title"],
            content_md=row["content_md"],
            source_kind=row["source_kind"],
            source_ref=row["source_ref"],
            kb_id=row["kb_id"],
            doc_id=row["doc_id"],
            folder_id=row["folder_id"],
            pinned=bool(row["pinned"]),
            tags=list(tags),
            created_at=_load(row["created_at_ms"]),
            updated_at=_load(row["updated_at_ms"]),
        )

    @staticmethod
    def _note_filters(
        user_id: str | None,
        query: str | None,
        tag: str | None,
        folder_id: str | None = None,
        unfiled: bool = False,
    ) -> tuple[str, list[Any]]:
        """拼 WHERE 子句。

        ``user_id=None`` 表示**不过滤归属**（管理员/API Key 通道要看全部，
        与 ``list_conversations`` 同口径）；成员传自己的 id，只看自己的。
        PG 那边因为 ``IS`` 不能参数化而写成"无筛选 / ``= %s``"两个分支，
        这里照同一形状写（SQLite 本来也支持 ``IS ?``，但没理由让它成为两边的差异）。

        ``folder_id`` / ``unfiled`` 是同一个轴上的两种取法，**由调用方保证不同时给**
        （``unfiled`` 优先，与文档列表那边一致）。

        搜索用子串匹配而不是全文索引：笔记是个人规模的数据，子串匹配对中文天然可用
        （不需要分词），也没有"改了正文忘了同步索引"这类静默故障。多个词之间取 AND，
        命中更准。``%``/``_`` 会被转义，避免用户输入的它们变成通配符。
        """
        where: list[str] = []
        params: list[Any] = []
        if user_id is not None:
            where.append("n.user_id = ?")
            params.append(user_id)
        if unfiled:
            where.append("n.folder_id IS NULL")
        elif folder_id is not None:
            where.append("n.folder_id = ?")
            params.append(folder_id)
        for term in (query or "").split():
            escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            where.append(r"(n.title LIKE ? ESCAPE '\' OR n.content_md LIKE ? ESCAPE '\')")
            params.extend([f"%{escaped}%", f"%{escaped}%"])
        if tag:
            where.append("n.id IN (SELECT note_id FROM note_tags WHERE tag = ?)")
            params.append(tag)
        return (" AND ".join(where) or "1 = 1"), params

    def _tags_of(self, conn: sqlite3.Connection, note_ids: Sequence[str]) -> dict[str, list[str]]:
        """一次取回多条笔记的标签（逐条查就是 N+1）。"""
        if not note_ids:
            return {}
        placeholders = _placeholders(len(note_ids))
        rows = conn.execute(
            # placeholders 只由 "?" 拼成，值全部走参数绑定；表名是字面量
            f"SELECT note_id, tag FROM note_tags WHERE note_id IN ({placeholders})"  # noqa: S608
            " ORDER BY tag",
            list(note_ids),
        ).fetchall()
        grouped: dict[str, list[str]] = {}
        for row in rows:
            grouped.setdefault(row["note_id"], []).append(row["tag"])
        return grouped

    def create_note(self, record: NoteRecord) -> NoteRecord:
        moment = _now()
        record.created_at = record.created_at or moment
        record.updated_at = record.updated_at or moment
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO notes (id, user_id, title, content_md, source_kind, source_ref,"
                " kb_id, doc_id, folder_id, pinned, created_at_ms, updated_at_ms)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.user_id,
                    record.title,
                    record.content_md,
                    record.source_kind,
                    record.source_ref,
                    record.kb_id,
                    record.doc_id,
                    record.folder_id,
                    int(record.pinned),
                    _dump(record.created_at),
                    _dump(record.updated_at),
                ),
            )
            if record.tags:
                self._insert_tags(conn, record.id, record.tags)
        return record

    @staticmethod
    def _insert_tags(conn: sqlite3.Connection, note_id: str, tags: Iterable[str]) -> None:
        # `executemany` 是 sqlite3.Connection 上的原生方法（psycopg3 那边没有，
        # 所以 PG 实现得走 cursor）——这里是两边少数**真的不一样**的手法之一。
        conn.executemany(
            "INSERT INTO note_tags (note_id, tag) VALUES (?, ?)"
            " ON CONFLICT (note_id, tag) DO NOTHING",
            [(note_id, tag) for tag in tags],
        )

    def get_note(self, note_id: str) -> NoteRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            if row is None:
                return None
            tags = self._tags_of(conn, [note_id]).get(note_id, [])
        return self._note_from_row(row, tags)

    def list_notes(
        self,
        *,
        user_id: str | None,
        query: str | None = None,
        tag: str | None = None,
        folder_id: str | None = None,
        unfiled: bool = False,
        limit: int = 50,
        offset: int = 0,
    ) -> list[NoteRecord]:
        where, params = self._note_filters(
            user_id, query, tag, folder_id=folder_id, unfiled=unfiled
        )
        sql = (
            # where 由本文件内部拼装：列名是字面量，值一律走 ? 绑定
            f"SELECT n.* FROM notes n WHERE {where}"  # noqa: S608
            " ORDER BY n.pinned DESC, n.updated_at_ms DESC, n.id DESC LIMIT ? OFFSET ?"
        )
        with self._db.read() as conn:
            rows = conn.execute(sql, [*params, limit, offset]).fetchall()
            tags = self._tags_of(conn, [row["id"] for row in rows])
        return [self._note_from_row(row, tags.get(row["id"], [])) for row in rows]

    def count_notes(
        self,
        *,
        user_id: str | None,
        query: str | None = None,
        tag: str | None = None,
        folder_id: str | None = None,
        unfiled: bool = False,
    ) -> int:
        where, params = self._note_filters(
            user_id, query, tag, folder_id=folder_id, unfiled=unfiled
        )
        with self._db.read() as conn:
            row = conn.execute(
                f"SELECT COUNT(*) AS n FROM notes n WHERE {where}",  # noqa: S608
                params,
            ).fetchone()
        return int(row["n"])

    def update_note(
        self,
        note_id: str,
        *,
        title: str,
        content_md: str,
        pinned: bool,
        updated_at: datetime,
        tags: Sequence[str] | None = None,
    ) -> None:
        """改一条笔记。

        ``updated_at_ms`` 取 ``max(调用方给的值, 旧值 + 1)``：笔记列表按它排序，
        而"同一毫秒里连编两次"在界面上就是"点了保存但顺序没动"。调用方给的
        时间戳仍然有效——只是不许它把这一行往回拨。
        """
        with self._db.session() as conn:
            conn.execute(
                "UPDATE notes SET title = ?, content_md = ?, pinned = ?,"
                " updated_at_ms = max(?, updated_at_ms + 1) WHERE id = ?",
                (title, content_md, int(pinned), _dump(updated_at), note_id),
            )
            if tags is not None:
                # 全量替换：标签是随笔记一起编辑的短列表，diff 没必要
                conn.execute("DELETE FROM note_tags WHERE note_id = ?", (note_id,))
                self._insert_tags(conn, note_id, tags)

    def delete_note(self, note_id: str) -> None:
        with self._db.session() as conn:
            conn.execute("DELETE FROM note_tags WHERE note_id = ?", (note_id,))
            conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))

    def attach_note_document(self, note_id: str, *, kb_id: str, doc_id: str) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE notes SET kb_id = ?, doc_id = ? WHERE id = ?",
                (kb_id, doc_id, note_id),
            )

    def list_note_tags(self, *, user_id: str | None) -> list[tuple[str, int]]:
        where = "" if user_id is None else "WHERE n.user_id = ?"
        params: tuple[Any, ...] = () if user_id is None else (user_id,)
        # 计数的别名刻意叫 `cnt`、笔记表别名叫 `n`——PG 那边 `ORDER BY n DESC` 里的
        # `n` 是**别名**，而这边 `n` 同时是表别名，照抄会被解析成表名。
        sql = (
            "SELECT t.tag AS tag, COUNT(*) AS cnt FROM note_tags t"  # noqa: S608
            f" JOIN notes n ON n.id = t.note_id {where}"
            " GROUP BY t.tag ORDER BY cnt DESC, t.tag"
        )
        with self._db.read() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [(row["tag"], int(row["cnt"])) for row in rows]

    # ------------------------------------------------------------------ 笔记文件夹

    @staticmethod
    def _note_folder_from_row(row: sqlite3.Row) -> NoteFolderRecord:
        return NoteFolderRecord(
            id=row["id"],
            user_id=row["user_id"],
            name=row["name"],
            parent_id=row["parent_id"],
            created_at=_load(row["created_at_ms"]),
            updated_at=_load(row["updated_at_ms"]),
        )

    def create_note_folder(self, record: NoteFolderRecord) -> NoteFolderRecord:
        moment = _now()
        record.created_at = record.created_at or moment
        record.updated_at = record.updated_at or moment
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO note_folders (id, user_id, name, parent_id, created_at_ms,"
                " updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.user_id,
                    record.name,
                    record.parent_id,
                    _dump(record.created_at),
                    _dump(record.updated_at),
                ),
            )
        return record

    def get_note_folder(self, folder_id: str) -> NoteFolderRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM note_folders WHERE id = ?", (folder_id,)).fetchone()
        return self._note_folder_from_row(row) if row else None

    def list_note_folders(self, *, user_id: str | None) -> list[NoteFolderRecord]:
        # 与知识库目录同一条口径：按名字排（PG 用 lower(name) 是因为它没有 NOCASE；
        # SQLite 照抄 lower(name) 保持两边读出来的顺序**逐字相同**）。
        where = "" if user_id is None else "WHERE user_id = ?"
        params: tuple[Any, ...] = () if user_id is None else (user_id,)
        with self._db.read() as conn:
            rows = conn.execute(
                f"SELECT * FROM note_folders {where} ORDER BY lower(name), id",  # noqa: S608
                params,
            ).fetchall()
        return [self._note_folder_from_row(row) for row in rows]

    def rename_note_folder(self, folder_id: str, name: str) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE note_folders SET name = ?, updated_at_ms = max(?, updated_at_ms + 1)"
                " WHERE id = ?",
                (name, _dump(_now()), folder_id),
            )

    def set_note_folder_parent(self, folder_id: str, parent_id: str | None) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE note_folders SET parent_id = ?,"
                " updated_at_ms = max(?, updated_at_ms + 1) WHERE id = ?",
                (parent_id, _dump(_now()), folder_id),
            )

    def delete_note_folder(self, folder_id: str) -> None:
        """**一条 DELETE 就是全部**：子文件夹由 ``parent_id`` 的外键级联删掉，
        里面的笔记由 ``notes.folder_id`` 的 ``ON DELETE SET NULL`` 回到未归档。
        在 Python 里手写"先查子树再逐个删"只会把这两条已经声明在表上的语义
        复制成第二处会漂的定义——而那两条语义正是本机库 ``foreign_keys=ON`` 的理由。
        """
        with self._db.session() as conn:
            conn.execute("DELETE FROM note_folders WHERE id = ?", (folder_id,))

    def count_notes_by_folder(self, *, user_id: str | None) -> dict[str | None, int]:
        """``{文件夹 id / None（未归档）: 笔记数}``，一次聚合取全（含未归档那一行）。"""
        where = "" if user_id is None else "WHERE user_id = ?"
        params: tuple[Any, ...] = () if user_id is None else (user_id,)
        with self._db.read() as conn:
            rows = conn.execute(
                # where 只有两种取值（空串 / 一个字面量条件），用户值走绑定
                f"SELECT folder_id, COUNT(*) AS n FROM notes {where}"  # noqa: S608
                " GROUP BY folder_id",
                params,
            ).fetchall()
        return {row["folder_id"]: int(row["n"]) for row in rows}

    def set_note_folder(self, note_id: str, folder_id: str | None) -> None:
        """**不动 `updated_at`**：移动是"归了个档"，不是改了这条笔记。
        顺手把它顶到列表最前面（列表按 updated_at 排）等于把用户刚翻到的地方打乱。
        """
        with self._db.session() as conn:
            conn.execute("UPDATE notes SET folder_id = ? WHERE id = ?", (folder_id, note_id))

    # ------------------------------------------------------------------ 存储维护

    def storage_stats(self) -> dict:
        """库文件的物理占用与可回收空间（SQLite 口径）。

        与 PG 那版同名同职，只是口径换回"文件里的页"：
        ``page_count * page_size`` 是整库物理大小，``freelist_count * page_size``
        是删了数据之后还没还回去的页（VACUUM 能收回的那部分）。
        ``-wal`` 的大小不算进来：它是**流动**的（检查点后归零），
        把它计入会让"库有多大"这个数字忽大忽小。

        返回的键与 PG 那版**必须逐字一致**（``file_bytes`` / ``free_bytes``）：
        ``MaintenanceService.overview`` 直接按这两个键取值。
        """
        with self._db.read() as conn:
            page_size = int(conn.execute("PRAGMA page_size").fetchone()[0])
            page_count = int(conn.execute("PRAGMA page_count").fetchone()[0])
            freelist = int(conn.execute("PRAGMA freelist_count").fetchone()[0])
        return {"file_bytes": page_size * page_count, "free_bytes": page_size * freelist}

    def vacuum(self) -> None:
        """回收空闲页（``VACUUM``）。**必须在事务之外执行**，只能由显式动作触发。

        用 ``Database.maintenance()`` 拿一条临时连接：``VACUUM`` 不能在事务里跑，
        而 ``read()`` 借出的是本线程那条长连接（它可能正处在某个事务的上下文里）。
        它会重写整份库文件，几 GB 的库可能要几十秒——所以不加额外超时，
        真撞上并发写时由 ``busy_timeout`` 排队，超时就把错误原样抛出。
        """
        with self._db.maintenance() as conn:
            conn.execute("VACUUM")
