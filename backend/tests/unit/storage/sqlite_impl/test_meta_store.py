"""``SqliteMetaStore`` 的接口核对与行为测试（不需要 PostgreSQL）。

镜像同构：``app/storage/sqlite_impl/meta_store.py``
→ ``tests/unit/storage/sqlite_impl/test_meta_store.py``。

三块内容：

1. **接口核对**（§6.4 第一条 + §2.1）：``SqliteMetaStore`` 的方法集合**恰好**是
   ``LOCAL_METHODS``——既不少（少一个就是某条边角路径上的 AttributeError），
   也不多（多一个就是偷偷实现了 KB 域的活），并且结构上满足那 8 个窄协议。
2. **字段一致性**（§6.4 的 R10）：记录 dataclass 的字段 ↔ 表的列名逐表比对。
   两份 schema 漂移的典型形态就是"某个字段忘了落库"，这条机械查得出来。
3. **行为**：会话 / 消息 / 事件 / 产物 / 笔记 / 文件夹级联 / 设置 / 工作区三态 /
   定时任务 CAS / MCP / 模型注册 / 用量，以及规范 4 的两条纪律与毫秒 tie（R8）、
   §6.2 的"切会话 < 50 ms"。
"""

from __future__ import annotations

import statistics
import time
from collections.abc import Iterator
from dataclasses import fields
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.core.exceptions import ConflictError
from app.storage import repositories
from app.storage.base import (
    ChatMessageRecord,
    ConversationArtifactRecord,
    ConversationRecord,
    ImportLedger,
    MCPServerRecord,
    MetaStore,
    ModelProviderRecord,
    NoteFolderRecord,
    NoteRecord,
    RegisteredModelRecord,
    ScheduledTaskRecord,
    SessionEventRecord,
    UsageEventRecord,
    WorkspaceRecord,
)
from app.storage.repositories import MaintenanceRepo
from app.storage.sqlite_impl import (
    LOCAL_EXTRA,
    LOCAL_LEDGER_METHODS,
    LOCAL_METHODS,
    LOCAL_PROTOCOLS,
)
from app.storage.sqlite_impl import meta_store as meta_store_module
from app.storage.sqlite_impl.connection import Database
from app.storage.sqlite_impl.meta_store import (
    LAST_ASSISTANT_PREVIEWS_SQL,
    LIST_CONVERSATIONS_ORDER,
    LIST_CONVERSATIONS_SEARCH_SQL,
    LIST_CONVERSATIONS_SQL,
    PREVIEW_CHARS,
    SqliteMetaStore,
)
from app.storage.sqlite_impl.schema import prepare

pytestmark = pytest.mark.local

#: 记录里的时间字段：它们在表上叫 `<名字>_ms`。
DATETIME_FIELDS = frozenset(
    {"created_at", "updated_at", "archived_at", "run_at", "next_run_at", "last_run_at"}
)


@pytest.fixture
def database(tmp_path: Path) -> Iterator[Database]:
    db = Database(tmp_path / "kylab.db")
    prepare(db)
    yield db
    db.close()


@pytest.fixture
def store(database: Database) -> SqliteMetaStore:
    return SqliteMetaStore(database)


# ------------------------------------------------------------------ 接口核对


def test_store_covers_exactly_the_local_method_set() -> None:
    """本机域方法集**恰好**是 ``LOCAL_METHODS``：一个不多、一个不少。

    阶段 5 多出来的那八个导入台账方法**不在** ``LOCAL_METHODS`` 里，它们单独登记在
    ``LOCAL_LEDGER_METHODS``（理由写在那个常量上：那两张表只有本机档有，
    所以它们既不属于"本机域"也不属于"KB 域"）。所以这条断言的右边是**两块清单**——
    多一个方法就必须进其中之一，而"哪些算本机域"这条纪律一个字没松。
    """
    public = {
        name
        for name, value in vars(SqliteMetaStore).items()
        if not name.startswith("_") and callable(value)
    }
    assert public == set(LOCAL_METHODS) | set(LOCAL_LEDGER_METHODS)
    assert len(LOCAL_METHODS) == 81
    assert len(LOCAL_LEDGER_METHODS) == 8


def test_the_ledger_methods_are_not_on_the_meta_store_abc() -> None:
    """导入台账**不在** ``MetaStore`` 上：它是本机独有的两张表（服务器档没有）。

    这条断言是"不许悄悄超域"的另一半：``LOCAL_METHODS`` 必须是 ``MetaStore``
    抽象方法的子集（上面那条用例），而这一族方法**必须不是**——真哪天有人把它们
    加到 ``MetaStore`` 上，那是有意的（服务器档也要有导入台账），而那时这条会红，
    逼着人把"服务器档怎么实现它们"一起想清楚。
    """
    assert not (set(LOCAL_LEDGER_METHODS) & set(MetaStore.__abstractmethods__))
    assert not (set(LOCAL_LEDGER_METHODS) & set(LOCAL_METHODS))


def test_the_store_satisfies_the_import_ledger_protocol(store: SqliteMetaStore) -> None:
    """结构化类型下，实现**必须真的满足**那份协议（协议里的每个方法都在）。"""
    assert isinstance(store, ImportLedger)


def test_no_abstract_methods_left() -> None:
    """没有"忘了实现"的抽象方法（本类不继承 ABC，所以是空集）。"""
    assert frozenset(getattr(SqliteMetaStore, "__abstractmethods__", frozenset())) == frozenset()


def test_local_methods_all_exist_on_the_meta_store_abc() -> None:
    """本机域的每个方法都必须真的是 ``MetaStore`` 的方法——否则是写错了名字。"""
    assert set(LOCAL_METHODS) <= set(MetaStore.__abstractmethods__)


def test_local_methods_satisfy_each_narrow_protocol(store: SqliteMetaStore) -> None:
    """8 个窄协议逐个结构核对（``@runtime_checkable`` 让这件事一句话成立）。"""
    for protocol in LOCAL_PROTOCOLS:
        assert isinstance(store, protocol), protocol.__name__


def test_extra_methods_come_from_maintenance_and_leave_kb_alone() -> None:
    """``LOCAL_EXTRA`` 的两个方法来自 ``MaintenanceRepo``；``purge_stage_events`` 归 KB 域。"""
    maintenance = {
        name
        for name, value in vars(MaintenanceRepo).items()
        if not name.startswith("_") and callable(value)
    }
    assert maintenance > LOCAL_EXTRA
    assert "purge_stage_events" not in LOCAL_METHODS
    assert "purge_stage_events" not in LOCAL_EXTRA


def test_local_protocols_do_not_touch_the_kb_domain() -> None:
    """本机域里不许出现 KB 域的方法名（文档 / 切块 / 向量 / Wiki / 任务队列）。"""
    kb_methods = {
        name
        for name, value in vars(repositories.KnowledgeBaseRepo).items()
        if not name.startswith("_") and callable(value)
    }
    assert not (kb_methods & LOCAL_METHODS)
    for prefix in ("document", "chunk", "wiki", "task", "trash", "image", "parse_result"):
        assert not [
            name for name in LOCAL_METHODS if name.startswith(prefix)
        ], f"本机域混进了 {prefix}* 的方法"


# ------------------------------------------------------------------ 字段一致性（R10）

#: ``(记录, 表, 表里有记录没有的列, 记录里有表没有的字段)``。
#:
#: 后两栏是**例外**，每一处都要有理由，不然这条守卫会被人用"加个例外"绕过去：
#: - ``conversations`` 的 ``context_summary`` / ``summary_upto``：不进 API，但导入与
#:   回读要用（§1.3），所以是"表列多于记录字段"。
#: - ``usage_events.reported``：记录上的 ``reported`` 是从 ``source`` 算出来的属性，
#:   列是照搬 PG 留下来的（写路径不填它）。
#: - ``notes.tags``：标签住 ``note_tags`` 那张表（一个字段对应一张子表），
#:   所以是"记录字段多于列"。
RECORD_TABLES: tuple[tuple[type, str, frozenset[str], frozenset[str]], ...] = (
    (
        ConversationRecord,
        "conversations",
        frozenset({"context_summary", "summary_upto"}),
        frozenset(),
    ),
    (ChatMessageRecord, "chat_messages", frozenset(), frozenset()),
    (SessionEventRecord, "session_events", frozenset(), frozenset()),
    (ConversationArtifactRecord, "conversation_artifacts", frozenset(), frozenset()),
    (NoteRecord, "notes", frozenset(), frozenset({"tags"})),
    (NoteFolderRecord, "note_folders", frozenset(), frozenset()),
    (WorkspaceRecord, "workspaces", frozenset(), frozenset()),
    (ScheduledTaskRecord, "scheduled_tasks", frozenset(), frozenset()),
    (MCPServerRecord, "mcp_servers", frozenset(), frozenset()),
    (ModelProviderRecord, "model_providers", frozenset(), frozenset()),
    (RegisteredModelRecord, "model_registry", frozenset(), frozenset()),
    (UsageEventRecord, "usage_events", frozenset({"reported"}), frozenset()),
)


@pytest.mark.parametrize(("record", "table", "table_only", "record_only"), RECORD_TABLES)
def test_record_fields_match_table_columns(
    database: Database,
    record: type,
    table: str,
    table_only: frozenset[str],
    record_only: frozenset[str],
) -> None:
    """记录字段 ↔ 表列名逐表比对（两份 schema 漂移的机械判据）。"""
    with database.read() as conn:
        columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    expected = {
        f"{item.name}_ms" if item.name in DATETIME_FIELDS else item.name
        for item in fields(record)
    } - record_only
    assert expected <= columns, f"{table} 少了这些列：{sorted(expected - columns)}"
    assert columns - table_only == expected, (
        f"{table} 多出这些列：{sorted(columns - table_only - expected)}"
    )


# ------------------------------------------------------------------ 规范 4：列表不带正文


#: 列表 SQL 里**不许出现**的东西：消息正文、过程、引用、附件、摘要，以及消息表本身。
BANNED_IN_LIST_SQL = (
    "content",
    "steps",
    "sources",
    "attachments",
    "context_summary",
    "summary_upto",
    "chat_messages",
)


def test_list_sql_never_drags_message_bodies() -> None:
    """规范 4 ①：列表会话的 SQL 不碰正文列，也**不碰消息表**（机械判据）。

    ``thinking`` 刻意不在禁列里：``conversations.thinking`` 是会话自己的"是否开思考"
    开关（记录要它），被禁的是**消息**那张表上的同名列——而"列表 SQL 里没有
    ``chat_messages``"这一条已经把消息那一侧整个排除了。
    """
    sql = (LIST_CONVERSATIONS_SQL + LIST_CONVERSATIONS_ORDER).lower()
    for banned in BANNED_IN_LIST_SQL:
        assert banned not in sql, f"列表 SQL 里出现了 {banned}"
    assert "thinking" in sql


def test_search_sql_is_the_only_place_that_looks_into_the_messages() -> None:
    """带 `q` 的那条必须查正文（"搜一句我记得说过的话"），但它只做 `EXISTS` 过滤。"""
    sql = LIST_CONVERSATIONS_SEARCH_SQL.lower()
    assert "chat_messages" in sql
    assert "exists" in sql
    assert "content" in sql


def test_previews_are_truncated_in_sql_not_in_python() -> None:
    """规范 4 ②：`substr` 截断发生在 SQL 里，preview 不许把整段正文搬进内存。"""
    assert "substr(content, 1, ?)" in LAST_ASSISTANT_PREVIEWS_SQL
    # 长度是**绑定参数**（`?`），不是写死的字面量：调用方给 PREVIEW_CHARS
    assert f"1, {PREVIEW_CHARS}" not in LAST_ASSISTANT_PREVIEWS_SQL


def test_preview_is_capped_at_the_declared_length(store: SqliteMetaStore) -> None:
    store.create_conversation(ConversationRecord(id="c1", title="会话"))
    body = "回答正文" * 200  # 800 字，远超预览长度
    store.append_message(
        ChatMessageRecord(id="m1", conversation_id="c1", role="assistant", content=body)
    )
    previews = store.last_assistant_previews(["c1"])
    assert previews["c1"] == body[:PREVIEW_CHARS]
    assert len(previews["c1"]) == PREVIEW_CHARS


# ------------------------------------------------------------------ 规范 3：索引真的被用上


def test_list_query_uses_a_covering_index_without_a_temp_sort(database: Database) -> None:
    """§6.2：列表查询的 ``EXPLAIN QUERY PLAN`` 不含 ``USE TEMP B-TREE FOR ORDER BY``。"""
    sql = LIST_CONVERSATIONS_SQL + LIST_CONVERSATIONS_ORDER
    with database.read() as conn:
        plan = " | ".join(
            str(row["detail"]) for row in conn.execute(f"EXPLAIN QUERY PLAN {sql}")
        )
    assert "idx_conversations_recent" in plan
    assert "TEMP B-TREE" not in plan.upper()


def test_switching_a_conversation_stays_under_budget(database: Database) -> None:
    """§6.2：「切会话 < 50 ms」。

    造 500 会话 × 40 消息，量**服务层一次"切会话"真正发起的那几条查询**
    （``get_conversation`` + ``list_messages`` + ``count_messages``），取 p95。
    本机实测是个位数毫秒；门限给宽是为了不让 CI 抖动把它变成偶发红。
    """
    store = SqliteMetaStore(database)
    conversations = 500
    messages_per = 40
    now = datetime(2026, 1, 1, tzinfo=UTC)
    with database.session() as conn:
        conn.executemany(
            "INSERT INTO conversations (id, title, kb_ids, pinned, context_summary,"
            " created_at_ms, updated_at_ms) VALUES (?, ?, '[]', ?, '', ?, ?)",
            [
                (
                    f"conv_{index:04d}",
                    f"会话 {index}",
                    index % 2,
                    int((now + timedelta(seconds=index)).timestamp() * 1000),
                    int((now + timedelta(seconds=index)).timestamp() * 1000),
                )
                for index in range(conversations)
            ],
        )
        conn.executemany(
            "INSERT INTO chat_messages (id, conversation_id, role, content, created_at_ms)"
            " VALUES (?, ?, ?, ?, ?)",
            [
                (
                    f"msg_{index:04d}_{position:03d}",
                    f"conv_{index:04d}",
                    "user" if position % 2 == 0 else "assistant",
                    f"第 {position} 条消息的正文",
                    int((now + timedelta(seconds=index, milliseconds=position)).timestamp() * 1000),
                )
                for index in range(conversations)
                for position in range(messages_per)
            ],
        )

    samples: list[float] = []
    for index in range(100):
        target = f"conv_{index * 5:04d}"
        started = time.perf_counter()
        record = store.get_conversation(target)
        messages = store.list_messages(target)
        count = store.count_messages(target)
        samples.append((time.perf_counter() - started) * 1000)
        assert record is not None and len(messages) == messages_per and count == messages_per

    p95 = statistics.quantiles(samples, n=20)[-1]
    assert p95 <= 50, f"切会话 p95 = {p95:.2f} ms（样本 {len(samples)}）"


# ------------------------------------------------------------------ 毫秒 tie（R8）


def test_two_touches_in_the_same_millisecond_still_advance(
    store: SqliteMetaStore, monkeypatch
) -> None:
    """§1.2 / 风险 R8：同一毫秒里的两次推进**必须**排得出先后。

    冻结 ``_now`` 到同一个毫秒再连推两次——没有 ``max(?, 旧值 + 1)`` 那条纪律，
    第二次会写回同一个值，于是"最近活动"的名次停住不动。
    """
    frozen = datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC)
    monkeypatch.setattr(meta_store_module, "_now", lambda: frozen)
    store.create_conversation(ConversationRecord(id="c1", title="会话"))

    store.touch_conversation("c1")
    first = store.get_conversation("c1")
    store.touch_conversation("c1")
    second = store.get_conversation("c1")

    assert first is not None and second is not None
    assert first.updated_at is not None and second.updated_at is not None
    assert second.updated_at > first.updated_at
    assert (second.updated_at - first.updated_at) == timedelta(milliseconds=1)


def test_same_millisecond_updates_advance_other_advanced_columns(
    store: SqliteMetaStore, database: Database, monkeypatch
) -> None:
    """同一套纪律覆盖其余"必须推进"的写（设置 / 笔记 / 工作区 / 模型 / MCP）。"""
    frozen = datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC)
    monkeypatch.setattr(meta_store_module, "_now", lambda: frozen)

    store.set_setting("ui.theme", "dark")
    store.set_setting("ui.theme", "light")
    assert store.get_setting("ui.theme") == "light"
    with database.read() as conn:
        stamp = conn.execute(
            "SELECT updated_at_ms FROM app_settings WHERE key = 'ui.theme'"
        ).fetchone()[0]
    assert stamp == int(frozen.timestamp() * 1000) + 1

    note = store.create_note(NoteRecord(id="n1", user_id="u1", title="笔记"))
    store.update_note("n1", title="笔记", content_md="改一次", pinned=False, updated_at=frozen)
    store.update_note("n1", title="笔记", content_md="改两次", pinned=False, updated_at=frozen)
    changed = next(item for item in store.list_notes(user_id="u1") if item.id == "n1")
    assert changed.updated_at > (note.updated_at or frozen)


# ------------------------------------------------------------------ 会话 / 消息 / 事件


def test_conversation_round_trip_keeps_the_tri_state_columns(store: SqliteMetaStore) -> None:
    """可空的三态列（``thinking`` / ``workspace_id``）**保持 None**，不折成 False/空串。"""
    store.create_conversation(ConversationRecord(id="c1", title="会话"))
    plain = store.get_conversation("c1")
    assert plain is not None
    assert plain.thinking is None and plain.workspace_id is None and plain.archived_at is None

    store.set_conversation_thinking("c1", True, "high")
    turned_on = store.get_conversation("c1")
    assert turned_on is not None and turned_on.thinking is True
    store.set_conversation_thinking("c1", None, None)
    turned_off = store.get_conversation("c1")
    assert turned_off is not None and turned_off.thinking is None


def test_list_conversations_orders_pinned_first_then_recent(store: SqliteMetaStore) -> None:
    base = datetime(2026, 3, 1, tzinfo=UTC)
    for index in range(3):
        store.create_conversation(
            ConversationRecord(
                id=f"c{index}",
                title=f"会话 {index}",
                created_at=base + timedelta(seconds=index),
                updated_at=base + timedelta(seconds=index),
            )
        )
    store.set_conversation_pinned("c0", True)
    assert [item.id for item in store.list_conversations()] == ["c0", "c2", "c1"]
    assert [item.id for item in store.list_conversations(limit=2)] == ["c0", "c2"]


def test_list_conversations_searches_title_and_body(store: SqliteMetaStore) -> None:
    store.create_conversation(ConversationRecord(id="c1", title="关于检索"))
    store.create_conversation(ConversationRecord(id="c2", title="闲聊"))
    store.append_message(
        ChatMessageRecord(id="m1", conversation_id="c2", role="user", content="检索是什么")
    )
    assert {item.id for item in store.list_conversations(q="检索")} == {"c1", "c2"}
    # 通配符要被转义成字面量（搜 "a_b" 不该命中 "axb"）
    store.create_conversation(ConversationRecord(id="c3", title="a_b"))
    store.create_conversation(ConversationRecord(id="c4", title="axb"))
    assert {item.id for item in store.list_conversations(q="a_b")} == {"c3"}


def test_append_turn_writes_messages_and_events_in_one_transaction(
    store: SqliteMetaStore,
) -> None:
    store.create_conversation(ConversationRecord(id="c1", title="会话"))
    store.append_turn(
        messages=[
            ChatMessageRecord(id="m1", conversation_id="c1", role="user", content="问题"),
            ChatMessageRecord(id="m2", conversation_id="c1", role="assistant", content="回答"),
        ],
        events=[SessionEventRecord(conversation_id="c1", kind="turn_started", payload={"a": 1})],
    )
    assert [item.id for item in store.list_messages("c1")] == ["m1", "m2"]
    assert store.count_messages("c1") == 2
    events = store.list_session_events("c1")
    assert [(item.seq, item.kind) for item in events] == [(1, "turn_started")]
    assert events[0].payload == {"a": 1}
    assert events[0].id == 1


def test_session_event_seq_keeps_increasing_and_can_be_filtered(store: SqliteMetaStore) -> None:
    store.create_conversation(ConversationRecord(id="c1", title="会话"))
    store.append_session_events([SessionEventRecord(conversation_id="c1", kind="a")])
    added = store.append_session_events(
        [
            SessionEventRecord(conversation_id="c1", kind="b"),
            SessionEventRecord(conversation_id="c1", kind="a"),
        ]
    )
    assert [item.seq for item in added] == [2, 3]
    assert [item.seq for item in store.list_session_events("c1", kinds=["a"])] == [1, 3]
    assert [item.seq for item in store.list_session_events("c1")] == [1, 2, 3]


def test_session_events_of_another_conversation_are_rejected(store: SqliteMetaStore) -> None:
    """一批事件必须同属一个会话（否则 `seq` 没法用一条 max 算）。"""
    store.create_conversation(ConversationRecord(id="c1", title="会话"))
    store.create_conversation(ConversationRecord(id="c2", title="会话"))
    with pytest.raises(ValueError, match="同一个会话"):
        store.append_session_events(
            [
                SessionEventRecord(conversation_id="c1", kind="a"),
                SessionEventRecord(conversation_id="c2", kind="a"),
            ]
        )


def test_summary_round_trip(store: SqliteMetaStore) -> None:
    store.create_conversation(ConversationRecord(id="c1", title="会话"))
    assert store.get_conversation_summary("c1") == ("", None)
    store.set_conversation_summary("c1", "压缩后的上下文", "m9")
    assert store.get_conversation_summary("c1") == ("压缩后的上下文", "m9")
    assert store.get_conversation_summary("不存在") == ("", None)


def test_delete_conversation_takes_its_children_with_it(store: SqliteMetaStore) -> None:
    store.create_conversation(ConversationRecord(id="c1", title="会话"))
    store.append_message(
        ChatMessageRecord(id="m1", conversation_id="c1", role="user", content="问题")
    )
    store.append_session_events([SessionEventRecord(conversation_id="c1", kind="a")])
    store.create_artifact(
        ConversationArtifactRecord(id="art1", conversation_id="c1", name="报告.docx", format="docx")
    )
    store.delete_conversation("c1")
    assert store.get_conversation("c1") is None
    assert store.list_messages("c1") == []
    assert store.list_session_events("c1") == []
    assert store.list_artifacts("c1") == []


def test_delete_chat_messages_returns_the_count(store: SqliteMetaStore) -> None:
    store.create_conversation(ConversationRecord(id="c1", title="会话"))
    store.append_turn(
        messages=[
            ChatMessageRecord(id="m1", conversation_id="c1", role="user", content="一"),
            ChatMessageRecord(id="m2", conversation_id="c1", role="assistant", content="二"),
        ],
        events=[],
    )
    assert store.delete_chat_messages(["m2", "不存在"]) == 1
    assert store.delete_chat_messages([]) == 0


# ------------------------------------------------------------------ 产物


def test_artifact_lifecycle(store: SqliteMetaStore) -> None:
    store.create_conversation(ConversationRecord(id="c1", title="会话"))
    store.create_artifact(
        ConversationArtifactRecord(
            id="art1",
            conversation_id="c1",
            name="报告.docx",
            format="docx",
            size_bytes=2048,
            storage="workspace",
            location="C:/项目/报告.docx",
        )
    )
    loaded = store.get_artifact("art1")
    assert loaded is not None
    assert loaded.location == "C:/项目/报告.docx"
    assert loaded.size_bytes == 2048
    assert [item.id for item in store.list_artifacts("c1")] == ["art1"]
    assert store.get_artifact("不存在") is None

    store.mark_artifact_ingested("art1", knowledge_base_id="kb1", document_id="doc1")
    ingested = store.get_artifact("art1")
    assert ingested is not None
    assert ingested.knowledge_base_id == "kb1" and ingested.document_id == "doc1"
    # **入库是复制**：产物自己的落点不动
    assert ingested.location == "C:/项目/报告.docx"


# ------------------------------------------------------------------ 笔记 / 文件夹


def test_note_round_trip_with_tags(store: SqliteMetaStore) -> None:
    store.create_note(
        NoteRecord(
            id="n1",
            user_id="u1",
            title="会议记录",
            content_md="正文",
            tags=["工作", "周会"],
        )
    )
    loaded = store.get_note("n1")
    # 标签顺序由存储层定（`ORDER BY tag`，即 UTF-8 字面序），断言集合即可
    assert loaded is not None and set(loaded.tags) == {"工作", "周会"}
    store.update_note(
        "n1",
        title="会议记录",
        content_md="改过",
        pinned=True,
        updated_at=datetime.now(UTC),
        tags=["工作"],
    )
    updated = store.get_note("n1")
    assert updated is not None and updated.tags == ["工作"] and updated.pinned is True
    tags = store.list_note_tags(user_id="u1")
    assert [tag for tag, _count in tags] == ["工作"]
    assert tags[0][1] == 1
    store.delete_note("n1")
    assert store.get_note("n1") is None
    assert store.list_note_tags(user_id="u1") == []


def test_note_search_and_paging(store: SqliteMetaStore) -> None:
    base = datetime(2026, 2, 1, tzinfo=UTC)
    for index in range(5):
        store.create_note(
            NoteRecord(
                id=f"n{index}",
                user_id="u1",
                title=f"笔记 {index}",
                content_md="共同的关键词" if index % 2 == 0 else "别的内容",
                created_at=base + timedelta(seconds=index),
                updated_at=base + timedelta(seconds=index),
            )
        )
    assert store.count_notes(user_id="u1") == 5
    assert store.count_notes(user_id="u1", query="关键词") == 3
    assert [item.id for item in store.list_notes(user_id="u1", limit=2)] == ["n4", "n3"]
    assert [item.id for item in store.list_notes(user_id="u1", limit=2, offset=2)] == ["n2", "n1"]
    assert store.list_notes(user_id="someone-else") == []


def test_note_folder_cascade_semantics(store: SqliteMetaStore) -> None:
    """删文件夹 → **子文件夹删掉、里面的笔记回到未归档**（两条外键语义都要成立）。"""
    store.create_note_folder(NoteFolderRecord(id="f1", user_id="u1", name="工作"))
    store.create_note_folder(NoteFolderRecord(id="f2", user_id="u1", name="子目录", parent_id="f1"))
    store.create_note(NoteRecord(id="n1", user_id="u1", title="笔记", folder_id="f2"))
    assert store.count_notes_by_folder(user_id="u1") == {"f2": 1}

    store.delete_note_folder("f1")
    assert store.get_note_folder("f1") is None
    assert store.get_note_folder("f2") is None  # 子文件夹跟着走
    survivor = store.get_note("n1")
    assert survivor is not None and survivor.folder_id is None  # 笔记回到未归档
    assert store.count_notes_by_folder(user_id="u1") == {None: 1}


def test_note_folder_listing_is_case_insensitive_by_name(store: SqliteMetaStore) -> None:
    for index, name in enumerate(["beta", "Alpha", "gamma"]):
        store.create_note_folder(
            NoteFolderRecord(id=f"f{index}", user_id="u1", name=name, created_at=datetime.now(UTC))
        )
    assert [item.name for item in store.list_note_folders(user_id="u1")] == [
        "Alpha",
        "beta",
        "gamma",
    ]


def test_attach_note_document_records_the_edge(store: SqliteMetaStore) -> None:
    store.create_note(NoteRecord(id="n1", user_id="u1", title="笔记"))
    store.attach_note_document("n1", kb_id="kb1", doc_id="doc1")
    attached = store.get_note("n1")
    assert attached is not None and attached.kb_id == "kb1" and attached.doc_id == "doc1"


# ------------------------------------------------------------------ 设置


def test_settings_round_trip(store: SqliteMetaStore) -> None:
    assert store.get_setting("k") is None
    assert store.get_settings([]) == {}
    store.set_setting("k1", "v1")
    store.set_setting("k2", "v2")
    assert store.get_setting("k1") == "v1"
    assert store.get_settings(["k1", "k2", "缺失"]) == {"k1": "v1", "k2": "v2"}
    store.delete_setting("k1")
    assert store.get_setting("k1") is None


# ------------------------------------------------------------------ 工作区


def test_workspace_device_filter_is_three_state(store: SqliteMetaStore) -> None:
    """``any_device`` / 具体设备 / ``None``（服务器端）三档，与 PG 侧同一口径。"""
    store.create_workspace(WorkspaceRecord(id="w_server", name="服务器", root_path="/srv"))
    store.create_workspace(
        WorkspaceRecord(id="w_a", name="这台", root_path="C:/项目", device_id="dev-a")
    )
    store.create_workspace(
        WorkspaceRecord(id="w_b", name="另一台", root_path="D:/项目", device_id="dev-b")
    )
    assert {item.id for item in store.list_workspaces()} == {"w_server"}
    assert {item.id for item in store.list_workspaces(device_id="dev-a")} == {"w_a"}
    assert {item.id for item in store.list_workspaces(any_device=True)} == {
        "w_server",
        "w_a",
        "w_b",
    }
    assert store.get_workspace("w_a") is not None
    assert store.get_workspace("w_a").device_name == ""  # NULL 归一到空串


def test_deleting_a_workspace_sends_its_conversations_back_unfiled(
    store: SqliteMetaStore,
) -> None:
    store.create_workspace(WorkspaceRecord(id="w1", name="项目", root_path="C:/项目"))
    store.create_conversation(ConversationRecord(id="c1", title="会话", workspace_id="w1"))
    assert store.count_workspace_conversations("w1") == 1
    store.delete_workspace("w1")
    survivor = store.get_conversation("c1")
    assert survivor is not None and survivor.workspace_id is None


def test_workspace_archive_and_update(store: SqliteMetaStore) -> None:
    store.create_workspace(WorkspaceRecord(id="w1", name="项目", root_path="C:/项目"))
    # 读回来比对（库里存到毫秒，`create_*` 返回的记录还带着微秒）
    before = store.get_workspace("w1")
    assert before is not None
    store.set_workspace_archived("w1", True)
    archived = store.get_workspace("w1")
    assert archived is not None and archived.archived_at is not None
    # 归档是整理动作：**不推 updated_at**
    assert archived.updated_at == before.updated_at
    store.set_workspace_archived("w1", False)
    cancelled = store.get_workspace("w1")
    assert cancelled is not None and cancelled.archived_at is None

    before.name = "改名后的项目"
    store.update_workspace(before)
    renamed = store.get_workspace("w1")
    assert renamed is not None and renamed.name == "改名后的项目"


# ------------------------------------------------------------------ 定时任务


def _task(**overrides: object) -> ScheduledTaskRecord:
    base: dict[str, object] = {
        "id": "s1",
        "name": "每天汇总",
        "prompt": "把昨天的日志汇总一下",
        "kind": "cron",
        "cron": "0 9 * * *",
    }
    base.update(overrides)
    return ScheduledTaskRecord(**base)  # type: ignore[arg-type]


def test_scheduled_task_lifecycle_and_cas(store: SqliteMetaStore) -> None:
    due_at = datetime(2026, 4, 1, 9, 0, tzinfo=UTC)
    store.create_conversation(ConversationRecord(id="c1", title="任务跑出来的会话"))
    store.create_scheduled_task(_task(next_run_at=due_at))
    assert [item.id for item in store.due_scheduled_tasks(now=due_at, limit=5)] == ["s1"]
    assert store.due_scheduled_tasks(now=due_at - timedelta(seconds=1)) == []

    # CAS 认领：第一次改得到行，第二次（游标已经变了）改不到
    assert (
        store.arm_scheduled_task(
            "s1",
            expected_next_run_at=due_at,
            next_run_at=due_at + timedelta(days=1),
            enabled=True,
        )
        is True
    )
    assert (
        store.arm_scheduled_task(
            "s1",
            expected_next_run_at=due_at,
            next_run_at=due_at + timedelta(days=2),
            enabled=True,
        )
        is False
    )

    store.finish_scheduled_run(
        "s1", status="ok", error=None, last_run_at=due_at, conversation_id="c1"
    )
    record = store.get_scheduled_task("s1")
    assert record is not None and record.run_count == 1 and record.last_status == "ok"
    assert record.conversation_id == "c1"
    # COALESCE：之后忘了带 conversation_id 也不会把这条边抹掉
    store.finish_scheduled_run("s1", status="failed", error="超时", last_run_at=due_at)
    again = store.get_scheduled_task("s1")
    assert again is not None and again.conversation_id == "c1"
    assert again.run_count == 2 and again.last_error == "超时"


def test_arm_scheduled_task_can_claim_from_null(store: SqliteMetaStore) -> None:
    """一次性任务是从 ``next_run_at = NULL`` 认领的——``=`` 会永远改不到行。"""
    store.create_scheduled_task(_task(id="s2", kind="once", cron="", run_at=None))
    assert (
        store.arm_scheduled_task(
            "s2",
            expected_next_run_at=None,
            next_run_at=datetime(2026, 4, 2, 9, 0, tzinfo=UTC),
            enabled=True,
        )
        is True
    )


def test_list_scheduled_tasks_puts_finished_ones_last(store: SqliteMetaStore) -> None:
    store.create_scheduled_task(_task(id="s_done", next_run_at=None))
    store.create_scheduled_task(
        _task(id="s_soon", next_run_at=datetime(2026, 4, 1, tzinfo=UTC))
    )
    store.create_scheduled_task(
        _task(id="s_later", next_run_at=datetime(2026, 5, 1, tzinfo=UTC))
    )
    assert [item.id for item in store.list_scheduled_tasks()] == ["s_soon", "s_later", "s_done"]


def test_update_and_delete_scheduled_task(store: SqliteMetaStore) -> None:
    record = store.create_scheduled_task(_task())
    record.name = "改名后的任务"
    record.enabled = False
    store.update_scheduled_task(record)
    loaded = store.get_scheduled_task("s1")
    assert loaded is not None and loaded.name == "改名后的任务" and loaded.enabled is False
    store.delete_scheduled_task("s1")
    assert store.get_scheduled_task("s1") is None


# ------------------------------------------------------------------ MCP 服务


def test_mcp_server_round_trip(store: SqliteMetaStore) -> None:
    store.create_mcp_server(
        MCPServerRecord(
            id="mcp1",
            name="本地工具",
            transport="stdio",
            target="uvx",
            args=["mcp-server-fetch"],
            env={"TOKEN": "明文凭据"},
            headers={"X-Auth": "abc"},
            policy="ask",
        )
    )
    loaded = store.get_mcp_server("mcp1")
    assert loaded is not None
    assert tuple(loaded.args) == ("mcp-server-fetch",)
    assert loaded.env == {"TOKEN": "明文凭据"}
    assert loaded.headers == {"X-Auth": "abc"}
    assert loaded.enabled is True

    loaded.policy = "deny"
    loaded.enabled = False
    store.update_mcp_server(loaded)
    updated = store.get_mcp_server("mcp1")
    assert updated is not None and updated.policy == "deny" and updated.enabled is False
    assert [item.id for item in store.list_mcp_servers()] == ["mcp1"]
    store.delete_mcp_server("mcp1")
    assert store.get_mcp_server("mcp1") is None


# ------------------------------------------------------------------ 模型注册器


def test_model_registry_round_trip_and_conflict(store: SqliteMetaStore) -> None:
    provider = store.create_model_provider(
        ModelProviderRecord(id="p1", kind="llm", name="供应商", base_url="https://api.example.com")
    )
    assert provider.enabled is True
    model = store.create_registered_model(
        RegisteredModelRecord(
            id="m1",
            provider_id="p1",
            model_id="deepseek-chat",
            label="对话",
            capabilities=["chat"],
            options={"temperature": 0.3},
        )
    )
    loaded = store.get_registered_model(model.id)
    assert loaded is not None and loaded.capabilities == ("chat",)
    assert loaded.options == {"temperature": 0.3}

    with pytest.raises(ConflictError, match="已经登记过模型"):
        store.create_registered_model(
            RegisteredModelRecord(id="m2", provider_id="p1", model_id="deepseek-chat")
        )

    assert [item.id for item in store.list_model_providers()] == ["p1"]
    assert [item.id for item in store.list_registered_models(provider_id="p1")] == ["m1"]
    # 删供应商连带删掉它的模型（否则会留下孤儿）
    store.delete_model_provider("p1")
    assert store.get_registered_model("m1") is None


def test_resolve_model_binding_walks_the_settings_key(store: SqliteMetaStore) -> None:
    store.create_model_provider(
        ModelProviderRecord(id="p1", kind="llm", name="供应商", api_key="sk-x")
    )
    store.create_registered_model(
        RegisteredModelRecord(
            id="m1",
            provider_id="p1",
            model_id="chat-model",
            capabilities=["chat"],
        )
    )
    assert store.resolve_model_binding("model.chat") is None
    store.set_setting("model.chat", "m1")
    resolved = store.resolve_model_binding("model.chat")
    assert resolved is not None
    provider, model = resolved
    assert provider.id == "p1" and provider.api_key == "sk-x"
    assert model.id == "m1" and model.model_id == "chat-model"


def test_update_registered_model_rewrites_the_json_columns(store: SqliteMetaStore) -> None:
    store.create_model_provider(ModelProviderRecord(id="p1", kind="llm", name="供应商"))
    record = store.create_registered_model(
        RegisteredModelRecord(id="m1", provider_id="p1", model_id="a", capabilities=["chat"])
    )
    record.capabilities = ["chat", "reasoning"]
    record.label = "改名"
    store.update_registered_model(record)
    loaded = store.get_registered_model("m1")
    assert loaded is not None
    assert loaded.capabilities == ("chat", "reasoning") and loaded.label == "改名"


# ------------------------------------------------------------------ 用量 / 维护


def test_usage_round_trip_and_purge(store: SqliteMetaStore) -> None:
    old = datetime(2026, 1, 1, tzinfo=UTC)
    new = datetime(2026, 6, 1, tzinfo=UTC)
    store.record_usage(UsageEventRecord(id="u1", kind="chat", prompt_tokens=10, created_at=old))
    store.record_usage(
        UsageEventRecord(
            id="u2",
            kind="embedding",
            completion_tokens=5,
            items=3,
            source="estimated",
            created_at=new,
        )
    )
    assert [item.id for item in store.list_usage()] == ["u1", "u2"]
    assert [item.id for item in store.list_usage(since=datetime(2026, 3, 1, tzinfo=UTC))] == ["u2"]
    # 记录上的 reported 是从 source 算出来的属性（列是照搬 PG 的，不在写路径上）
    assert store.list_usage()[0].reported is False
    assert store.list_usage()[1].reported is False and store.list_usage()[1].source == "estimated"

    assert store.purge_usage_before(datetime(2026, 3, 1, tzinfo=UTC)) == 1
    assert [item.id for item in store.list_usage()] == ["u2"]


def test_storage_stats_returns_the_two_keys_the_service_reads(store: SqliteMetaStore) -> None:
    """键名与 PG 那版**逐字一致**：``MaintenanceService.overview`` 直接按它们取值。"""
    stats = store.storage_stats()
    assert set(stats) == {"file_bytes", "free_bytes"}
    assert stats["file_bytes"] > 0
    assert stats["free_bytes"] >= 0


def test_vacuum_runs_outside_a_transaction(store: SqliteMetaStore) -> None:
    """``VACUUM`` 不能在事务里跑——它在 ``maintenance()`` 的临时连接上跑。"""
    store.create_conversation(ConversationRecord(id="c1", title="会话"))
    store.delete_conversation("c1")
    store.vacuum()
    assert store.storage_stats()["file_bytes"] > 0


def test_import_tables_exist_and_are_wired_up(store: SqliteMetaStore, database: Database) -> None:
    """导入台账那两张表（阶段 1 建表、阶段 5 接活）。

    阶段 1 那条断言写的是"**没有任何方法**碰它们"（当时是事实）；现在反过来——
    每次写台账都必须**真的落到库里**（``imports`` 一行 + ``import_items`` 一行），
    所以这里读一遍表名，再走一遍最常用的那条写路径。
    """
    with database.read() as conn:
        names = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
                " AND name IN ('imports', 'import_items')"
            )
        }
    assert names == {"imports", "import_items"}
    # 台账的两块清单在**本机域之外**（见上面那条用例），所以"本机域名单里没有 import*"
    # 这句话现在仍然是纪律：超域的东西要登记在 LOCAL_LEDGER_METHODS 里，不许混进去。
    assert not [name for name in LOCAL_METHODS if "import" in name]
