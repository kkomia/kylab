"""``MetaStore`` 的 SQLite 实现（M1 T1.2）。

设计要点：

- **只在本文件出现 SQL**：``services/`` 一律经 ``storage/base.py`` 的接口访问；
- **多写操作走一个事务**：``replace_chunks``、``reclaim_expired_tasks``、``purge_expired_trash``
  要么全成要么全不成，避免"chunk 删了没插回去"这类半写状态；
- **任务领取用单条原子语句**（``UPDATE ... WHERE id = (SELECT ...) RETURNING``）：
  先 SELECT 再 UPDATE 会在并发消费者之间产生双领，单语句可避免；
- JSON 字段（payload/config/events/knowledge_base_ids）以 TEXT 存储，只在边界处序列化。
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.core.exceptions import ConflictError, InvalidRequestError
from app.models.enums import (
    ApiKeyPermission,
    DataSourceKind,
    DocumentStage,
    SharePermission,
    TaskKind,
    TaskState,
    TrashKind,
    UserRole,
)
from app.storage.base import (
    ApiKeyRecord,
    ChatMessageRecord,
    ChunkRecord,
    ConversationRecord,
    DataSourceRecord,
    DocumentPartRecord,
    DocumentRecord,
    FolderRecord,
    IdempotencyRecord,
    ImageRecord,
    KnowledgeBaseRecord,
    MetaStore,
    ModelProviderRecord,
    NoteRecord,
    ParseResultRecord,
    RegisteredModelRecord,
    SessionRecord,
    ShareRecord,
    TaskRecord,
    TrashRecord,
    UsageEventRecord,
    UserRecord,
    WebhookRecord,
    WikiPageRecord,
    WikiSourceRecord,
)
from app.storage.sqlite_impl.connection import Database


def _now() -> datetime:
    return datetime.now(UTC)


def _dump(moment: datetime | None) -> str | None:
    return moment.isoformat() if moment else None


def _load(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def _webhook_of(row) -> WebhookRecord:  # type: ignore[no-untyped-def]
    """行 → 记录。抽出来是因为现在有四个地方要构造它（列表/单个/改开关后回读）。"""
    return WebhookRecord(
        id=row["id"],
        url=row["url"],
        events=tuple(json.loads(row["events"])),
        secret=row["secret"],
        enabled=bool(row["enabled"]),
    )


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


class SqliteMetaStore(MetaStore):
    """元数据仓储的 SQLite 实现。"""

    def __init__(self, database: Database) -> None:
        self._db = database

    # ------------------------------------------------------------------ 知识库

    def create_knowledge_base(self, record: KnowledgeBaseRecord) -> KnowledgeBaseRecord:
        stamp = _now()
        record.created_at = record.created_at or stamp
        record.updated_at = record.updated_at or stamp
        with self._db.session() as conn:
            conn.execute(
                """
                INSERT INTO knowledge_bases
                    (id, name, description, embedding_model_id, embedding_dim, embedding_base_url,
                     chunk_strategy, chunk_size, chunk_overlap, owner_id, embedding_model_pk,
                     suggested_enabled, suggested_count, suggested_model_pk, suggested_prompt,
                     wiki_enabled, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.name,
                    record.description,
                    record.embedding_model_id,
                    record.embedding_dim,
                    record.embedding_base_url,
                    record.chunk_strategy,
                    record.chunk_size,
                    record.chunk_overlap,
                    record.owner_id,
                    record.embedding_model_pk,
                    int(record.suggested_enabled),
                    record.suggested_count,
                    record.suggested_model_pk,
                    record.suggested_prompt,
                    int(record.wiki_enabled),
                    _dump(record.created_at),
                    _dump(record.updated_at),
                ),
            )
        return record

    def get_knowledge_base(self, kb_id: str) -> KnowledgeBaseRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM knowledge_bases WHERE id = ?", (kb_id,)).fetchone()
        return self._kb_from_row(row) if row else None

    def list_knowledge_bases(self) -> list[KnowledgeBaseRecord]:
        with self._db.read() as conn:
            rows = conn.execute("SELECT * FROM knowledge_bases ORDER BY created_at").fetchall()
        return [self._kb_from_row(row) for row in rows]

    def rename_knowledge_base(self, kb_id: str, name: str) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE knowledge_bases SET name = ?, updated_at = ? WHERE id = ?",
                (name, _dump(_now()), kb_id),
            )

    def set_knowledge_base_chunking(self, kb_id: str, size: int, overlap: int) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE knowledge_bases SET chunk_size = ?, chunk_overlap = ?, updated_at = ?"
                " WHERE id = ?",
                (size, overlap, _dump(_now()), kb_id),
            )

    def set_knowledge_base_description(self, kb_id: str, description: str) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE knowledge_bases SET description = ?, updated_at = ? WHERE id = ?",
                (description, _dump(_now()), kb_id),
            )

    def set_knowledge_base_suggested(
        self,
        kb_id: str,
        *,
        enabled: bool,
        count: int,
        model_pk: str | None,
        prompt: str,
    ) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE knowledge_bases SET suggested_enabled = ?, suggested_count = ?,"
                " suggested_model_pk = ?, suggested_prompt = ?, updated_at = ? WHERE id = ?",
                (int(enabled), count, model_pk, prompt, _dump(_now()), kb_id),
            )

    def set_knowledge_base_wiki(self, kb_id: str, *, enabled: bool) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE knowledge_bases SET wiki_enabled = ?, updated_at = ? WHERE id = ?",
                (int(enabled), _dump(_now()), kb_id),
            )

    def storage_stats(self) -> dict:
        """数据库的物理占用与空闲页。

        为什么需要"空闲页"这个数字：SQLite 删数据**不会**把文件变小，
        删掉的页进 freelist 等着复用（实测一个只有 169 个切块的库，
        21MB 里有 4MB 是空闲页）。不看这个数字，用户会以为"删了没用"。
        """
        with self._db.read() as conn:
            page_count = conn.execute("PRAGMA page_count").fetchone()[0]
            page_size = conn.execute("PRAGMA page_size").fetchone()[0]
            freelist = conn.execute("PRAGMA freelist_count").fetchone()[0]
        file_bytes = 0
        if not self._db.is_memory:
            try:
                file_bytes = Path(self._db.path).stat().st_size
            except OSError:  # pragma: no cover - 文件被外部挪走等边缘情况
                file_bytes = 0
        return {
            "file_bytes": file_bytes,
            "page_count": int(page_count),
            "page_size": int(page_size),
            "free_pages": int(freelist),
            "free_bytes": int(freelist) * int(page_size),
        }

    def vacuum(self) -> None:
        """回收空闲页（VACUUM）。

        **不能用 `session()`**：VACUUM 不能在事务里跑（SQLite 会直接报
        "cannot VACUUM from within a transaction"）。连接本身是 autocommit
        （`isolation_level=None`），所以单独 execute 一次即可。
        它会重写整个库文件，几 GB 的库要几十秒——所以调用方必须是显式的用户动作，
        不是每次删除后自动跑。
        """
        conn = self._db.connect()
        try:
            conn.execute("VACUUM")
        finally:
            conn.close()

    def document_stats_by_kbs(self) -> dict[str, tuple[int, datetime | None]]:
        """每个库的"文档数 + 最近更新时间"，一条 `GROUP BY` 出全部。"""
        with self._db.read() as conn:
            rows = conn.execute(
                """
                SELECT knowledge_base_id AS kb_id,
                       COUNT(*) AS total,
                       MAX(updated_at) AS last_update
                  FROM documents
                 GROUP BY knowledge_base_id
                """
            ).fetchall()
        return {
            row["kb_id"]: (int(row["total"]), _load(row["last_update"])) for row in rows
        }

    def update_knowledge_base_embedding(
        self, kb_id: str, *, model_id: str, dim: int, base_url: str | None
    ) -> None:
        with self._db.session() as conn:
            conn.execute(
                """
                UPDATE knowledge_bases
                   SET embedding_model_id = ?, embedding_dim = ?, embedding_base_url = ?,
                       updated_at = ?
                 WHERE id = ?
                """,
                (model_id, dim, base_url, _dump(_now()), kb_id),
            )

    def delete_knowledge_base(self, kb_id: str) -> None:
        with self._db.session() as conn:
            conn.execute("DELETE FROM knowledge_bases WHERE id = ?", (kb_id,))

    def count_kb_chunks(self, kb_id: str) -> int:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM chunks WHERE knowledge_base_id = ?", (kb_id,)
            ).fetchone()
        return int(row["n"])

    # ------------------------------------------------------------------ 文档

    def create_document(self, record: DocumentRecord) -> DocumentRecord:
        stamp = _now()
        record.created_at = record.created_at or stamp
        record.updated_at = record.updated_at or stamp
        with self._db.session() as conn:
            conn.execute(
                """
                INSERT INTO documents
                    (id, knowledge_base_id, name, source_kind, content_hash, stage, size_bytes,
                     mime_type, page_count, is_split, error, uploaded_by, folder_id, disabled,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.knowledge_base_id,
                    record.name,
                    record.source_kind.value,
                    record.content_hash,
                    record.stage.value,
                    record.size_bytes,
                    record.mime_type,
                    record.page_count,
                    int(record.is_split),
                    record.error,
                    record.uploaded_by,
                    record.folder_id,
                    int(record.disabled),
                    _dump(record.created_at),
                    _dump(record.updated_at),
                ),
            )
        return record

    def get_document(self, document_id: str) -> DocumentRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
        return self._document_from_row(row) if row else None

    def get_documents_by_ids(self, document_ids: Sequence[str]) -> dict[str, DocumentRecord]:
        if not document_ids:
            return {}
        # 分片拼 `IN (?, ?, …)`：SQLite 的变量上限是 999（旧版）/32766（新版），
        # 任务列表一次几百条也可能撞上，按 500 一批切，稳妥且不影响可读性
        result: dict[str, DocumentRecord] = {}
        unique = list(dict.fromkeys(document_ids))
        with self._db.read() as conn:
            for start in range(0, len(unique), 500):
                batch = unique[start : start + 500]
                placeholders = ",".join("?" * len(batch))
                rows = conn.execute(
                    # placeholders 只由 "?" 拼成，没有插值任何外部数据；
                    # 真正的值走参数绑定。S608 在这里是误报。
                    f"SELECT * FROM documents WHERE id IN ({placeholders})",  # noqa: S608
                    batch,
                ).fetchall()
                for row in rows:
                    record = self._document_from_row(row)
                    result[record.id] = record
        return result

    def get_document_by_hash(self, kb_id: str, content_hash: str) -> DocumentRecord | None:
        """架构 §6.3 的文件级去重：同库同 hash 只应有一份。"""
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT * FROM documents WHERE knowledge_base_id = ? AND content_hash = ?",
                (kb_id, content_hash),
            ).fetchone()
        return self._document_from_row(row) if row else None

    @staticmethod
    def _document_where(
        kb_id: str,
        *,
        folder_id: str | None = None,
        root_only: bool = False,
        q: str | None = None,
        stage: str | None = None,
        source_kind: str | None = None,
    ) -> tuple[str, list[object]]:
        """文档列表的 ``WHERE`` 片段与参数。

        **列与计数共用同一个构造器**：分页要同时给出"这一页"和"共几篇"，
        两处各写一遍过滤条件，迟早会漂——漂的那天接口会返回"第 2 页 0 篇但总数 100"。
        """
        clauses = ["knowledge_base_id = ?"]
        params: list[object] = [kb_id]
        if root_only:
            clauses.append("folder_id IS NULL")
        elif folder_id is not None:
            clauses.append("folder_id = ?")
            params.append(folder_id)
        if q:
            # 转义 LIKE 的通配符：用户搜 "a_b" 时字面匹配，而不是"a 后跟任意一字符"。
            # ESCAPE 子句让转义字符可判——没有它，反斜杠会被当普通字符，
            # `\%` 反而匹配到真正的 "%"。
            escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            clauses.append("name LIKE ? ESCAPE '\\'")
            params.append(f"%{escaped}%")
        if stage:
            clauses.append("stage = ?")
            params.append(stage)
        if source_kind:
            clauses.append("source_kind = ?")
            params.append(source_kind)
        return " AND ".join(clauses), params

    def list_documents(
        self,
        kb_id: str,
        *,
        folder_id: str | None = None,
        root_only: bool = False,
        q: str | None = None,
        stage: str | None = None,
        source_kind: str | None = None,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[DocumentRecord]:
        where, params = self._document_where(
            kb_id,
            folder_id=folder_id,
            root_only=root_only,
            q=q,
            stage=stage,
            source_kind=source_kind,
        )
        # `id` 是**分页的定序键**：同秒上传的文档 `created_at` 可能相同，
        # 只按它排时 SQLite 不保证两次查询顺序一致，LIMIT/OFFSET 就会漏行或重复。
        # 与笔记列表（`ORDER BY n.updated_at DESC, n.id DESC`）同一口径。
        sql = f"SELECT * FROM documents WHERE {where} ORDER BY created_at DESC, id DESC"  # noqa: S608
        if limit is not None:
            # 服务内部的调用点（统计/批处理/生命周期）要全量，limit=None 时不分页；
            # SQLite 的 OFFSET 必须配 LIMIT，所以只有给了 limit 才带 offset。
            sql += " LIMIT ? OFFSET ?"
            params.extend([max(0, limit), max(0, offset)])
        with self._db.read() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._document_from_row(row) for row in rows]

    def count_documents(
        self,
        kb_id: str,
        *,
        folder_id: str | None = None,
        root_only: bool = False,
        q: str | None = None,
        stage: str | None = None,
        source_kind: str | None = None,
    ) -> int:
        where, params = self._document_where(
            kb_id,
            folder_id=folder_id,
            root_only=root_only,
            q=q,
            stage=stage,
            source_kind=source_kind,
        )
        with self._db.read() as conn:
            row = conn.execute(
                f"SELECT COUNT(*) AS n FROM documents WHERE {where}",  # noqa: S608
                params,
            ).fetchone()
        return int(row["n"]) if row else 0

    # ------------------------------------------------------------------ 目录（v13）

    def create_folder(self, record: FolderRecord) -> FolderRecord:
        record.created_at = record.created_at or _now()
        with self._db.session() as conn:
            try:
                conn.execute(
                    "INSERT INTO kb_folders (id, kb_id, name, created_at) VALUES (?, ?, ?, ?)",
                    (
                        record.id,
                        record.kb_id,
                        record.name,
                        _dump(record.created_at),
                    ),
                )
            except sqlite3.IntegrityError as exc:
                # 同库重名由 UNIQUE(kb_id, name) 兜底；服务层也会先查一次给出可读文案，
                # 这里是并发/直连场景的最后一道
                raise ConflictError(f"目录已存在：{record.name}") from exc
        return record

    def get_folder(self, folder_id: str) -> FolderRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM kb_folders WHERE id = ?", (folder_id,)).fetchone()
        return self._folder_from_row(row) if row else None

    def list_folders(self, kb_id: str) -> list[FolderRecord]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM kb_folders WHERE kb_id = ? ORDER BY name COLLATE NOCASE",
                (kb_id,),
            ).fetchall()
        return [self._folder_from_row(row) for row in rows]

    def rename_folder(self, folder_id: str, name: str) -> None:
        with self._db.session() as conn:
            try:
                conn.execute("UPDATE kb_folders SET name = ? WHERE id = ?", (name, folder_id))
            except sqlite3.IntegrityError as exc:
                raise ConflictError(f"目录已存在：{name}") from exc

    def delete_folder(self, folder_id: str) -> None:
        """只删目录本身——**成员的去向由服务层决定**（当前策略：非空则拒绝删）。"""
        with self._db.session() as conn:
            conn.execute("DELETE FROM kb_folders WHERE id = ?", (folder_id,))

    def count_documents_by_folders(self, kb_id: str) -> dict[str, int]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT folder_id, COUNT(*) AS n FROM documents"
                " WHERE knowledge_base_id = ? AND folder_id IS NOT NULL"
                " GROUP BY folder_id",
                (kb_id,),
            ).fetchall()
        return {row["folder_id"]: int(row["n"]) for row in rows}

    def set_document_folder(self, document_id: str, folder_id: str | None) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE documents SET folder_id = ? WHERE id = ?", (folder_id, document_id)
            )

    @staticmethod
    def _folder_from_row(row: sqlite3.Row) -> FolderRecord:
        return FolderRecord(
            id=row["id"],
            kb_id=row["kb_id"],
            name=row["name"],
            created_at=_load(row["created_at"]),
        )

    # ------------------------------------------------------------------ 笔记（v20）

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
            pinned=bool(row["pinned"]),
            tags=list(tags),
            created_at=_load(row["created_at"]),
            updated_at=_load(row["updated_at"]),
        )

    @staticmethod
    def _note_filters(
        user_id: str | None, query: str | None, tag: str | None
    ) -> tuple[str, list]:
        """拼 WHERE 子句。

        用 ``user_id IS ?`` 而不是 ``= ?``：SQLite 里 ``IS`` 对 NULL 也成立。
        ``user_id=None`` 表示**不过滤归属**（管理员/API Key 通道要看全部，
        与 ``list_conversations`` 同口径）；成员传自己的 id，只看自己的。

        搜索用 ``LIKE`` 子串匹配而不是 FTS：笔记是个人规模的数据，
        子串匹配对中文天然可用（不需要分词），也没有"改了正文忘了同步索引"这类静默故障。
        多个词之间取 AND，命中更准。``%``/``_`` 会被转义，避免用户输入的它们变成通配符。
        """
        where: list[str] = []
        params: list = []
        if user_id is not None:
            where.append("n.user_id IS ?")
            params.append(user_id)
        for term in (query or "").split():
            escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            where.append("(n.title LIKE ? ESCAPE '\\' OR n.content_md LIKE ? ESCAPE '\\')")
            params.extend([f"%{escaped}%", f"%{escaped}%"])
        if tag:
            where.append("n.id IN (SELECT note_id FROM note_tags WHERE tag = ?)")
            params.append(tag)
        return (" AND ".join(where) or "1 = 1"), params

    def _tags_of(self, conn: sqlite3.Connection, note_ids: Sequence[str]) -> dict[str, list[str]]:
        """一次取回多条笔记的标签（逐条查就是 N+1）。"""
        if not note_ids:
            return {}
        placeholders = ",".join("?" for _ in note_ids)
        rows = conn.execute(
            # placeholders 只由「?」拼成，值全部走参数绑定；表名是字面量
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
                " kb_id, doc_id, pinned, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.user_id,
                    record.title,
                    record.content_md,
                    record.source_kind,
                    record.source_ref,
                    record.kb_id,
                    record.doc_id,
                    1 if record.pinned else 0,
                    _dump(record.created_at),
                    _dump(record.updated_at),
                ),
            )
            if record.tags:
                conn.executemany(
                    "INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)",
                    [(record.id, tag) for tag in record.tags],
                )
        return record

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
        limit: int = 50,
        offset: int = 0,
    ) -> list[NoteRecord]:
        where, params = self._note_filters(user_id, query, tag)
        sql = (
            # where 由本文件内部拼装：列名是字面量，值一律走 ? 绑定
            f"SELECT n.* FROM notes n WHERE {where}"  # noqa: S608
            " ORDER BY n.pinned DESC, n.updated_at DESC, n.id DESC LIMIT ? OFFSET ?"
        )
        with self._db.read() as conn:
            rows = conn.execute(sql, [*params, limit, offset]).fetchall()
            tags = self._tags_of(conn, [row["id"] for row in rows])
        return [self._note_from_row(row, tags.get(row["id"], [])) for row in rows]

    def count_notes(
        self, *, user_id: str | None, query: str | None = None, tag: str | None = None
    ) -> int:
        where, params = self._note_filters(user_id, query, tag)
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
        with self._db.session() as conn:
            conn.execute(
                "UPDATE notes SET title = ?, content_md = ?, pinned = ?, updated_at = ?"
                " WHERE id = ?",
                (title, content_md, 1 if pinned else 0, _dump(updated_at), note_id),
            )
            if tags is not None:
                # 全量替换：标签是随笔记一起编辑的短列表，diff 没必要
                conn.execute("DELETE FROM note_tags WHERE note_id = ?", (note_id,))
                conn.executemany(
                    "INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)",
                    [(note_id, tag) for tag in tags],
                )

    def delete_note(self, note_id: str) -> None:
        with self._db.session() as conn:
            conn.execute("DELETE FROM note_tags WHERE note_id = ?", (note_id,))
            conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))

    def attach_note_document(self, note_id: str, *, kb_id: str, doc_id: str) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE notes SET kb_id = ?, doc_id = ? WHERE id = ?", (kb_id, doc_id, note_id)
            )

    def list_note_tags(self, *, user_id: str | None) -> list[tuple[str, int]]:
        where = "" if user_id is None else "WHERE n.user_id IS ?"
        params: tuple = () if user_id is None else (user_id,)
        # where 只有两种取值（空串 / 一个字面量条件），用户值走绑定
        sql = (
            "SELECT t.tag AS tag, COUNT(*) AS n FROM note_tags t"  # noqa: S608
            f" JOIN notes n ON n.id = t.note_id {where}"
            " GROUP BY t.tag ORDER BY n DESC, t.tag"
        )
        with self._db.read() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [(row["tag"], int(row["n"])) for row in rows]

    def update_document_stage(
        self, document_id: str, stage: DocumentStage, *, error: str | None = None
    ) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE documents SET stage = ?, error = ?, updated_at = ? WHERE id = ?",
                (stage.value, error, _dump(_now()), document_id),
            )

    def delete_document(self, document_id: str) -> None:
        with self._db.session() as conn:
            conn.execute("DELETE FROM documents WHERE id = ?", (document_id,))

    def rename_document(self, document_id: str, name: str) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE documents SET name = ?, updated_at = ? WHERE id = ?",
                (name, _dump(_now()), document_id),
            )

    def set_document_disabled(self, document_id: str, disabled: bool) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE documents SET disabled = ?, updated_at = ? WHERE id = ?",
                (int(disabled), _dump(_now()), document_id),
            )

    def any_disabled_documents(self, kb_ids: Sequence[str]) -> bool:
        if not kb_ids:
            return False
        placeholders = ",".join("?" * len(kb_ids))
        with self._db.read() as conn:
            row = conn.execute(
                # placeholders 只由 "?" 拼成，值走参数绑定（S608 误报）
                f"SELECT EXISTS("  # noqa: S608
                f"SELECT 1 FROM documents WHERE disabled = 1 "
                f"AND knowledge_base_id IN ({placeholders})"
                f") AS has_disabled",
                tuple(kb_ids),
            ).fetchone()
        return bool(row["has_disabled"])

    # ------------------------------------------------------------------ 子文件

    def create_document_parts(self, records: Sequence[DocumentPartRecord]) -> None:
        if not records:
            return
        with self._db.session() as conn:
            # `INSERT OR REPLACE` 而不是 `INSERT`：摄入失败重跑时子文件 id 是同一批
            # （由 document_id + 段序号派生），普通 INSERT 会撞主键，把**设计内**的
            # 重跑路径（状态机支持从 parsing 继续）变成硬失败。
            # 另有 UNIQUE(document_id, part_index)：段数变少时旧的高序号段会被替换掉
            # 之外仍留着，所以由调用方先按 document_id 清一遍（delete_document_parts）。
            conn.executemany(
                """
                INSERT OR REPLACE INTO document_parts
                    (id, document_id, part_index, page_start, page_end, stage, error)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        part.id,
                        part.document_id,
                        part.part_index,
                        part.page_start,
                        part.page_end,
                        part.stage.value,
                        part.error,
                    )
                    for part in records
                ],
            )

    def list_document_parts(self, document_id: str) -> list[DocumentPartRecord]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM document_parts WHERE document_id = ? ORDER BY part_index",
                (document_id,),
            ).fetchall()
        return [
            DocumentPartRecord(
                id=row["id"],
                document_id=row["document_id"],
                part_index=row["part_index"],
                page_start=row["page_start"],
                page_end=row["page_end"],
                stage=DocumentStage(row["stage"]),
                error=row["error"],
            )
            for row in rows
        ]

    def update_part_stage(
        self, part_id: str, stage: DocumentStage, *, error: str | None = None
    ) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE document_parts SET stage = ?, error = ? WHERE id = ?",
                (stage.value, error, part_id),
            )

    def delete_document_parts(self, document_id: str) -> None:
        with self._db.session() as conn:
            conn.execute("DELETE FROM document_parts WHERE document_id = ?", (document_id,))

    def update_document_page_count(self, document_id: str, page_count: int | None) -> None:
        """把解析阶段得知的页数落库。

        **单独一个方法而不是塞进 ``update_document_stage``**：页数是**解析产物**，
        不是一个阶段推进事件。合成一个方法的话，每个调 ``update_document_stage``
        的地方都要想"我这次要不要带页数"，而那 8 处里的 7 处根本没这个信息。
        """
        if page_count is None or page_count <= 0:
            # 0 页不是"文档有 0 页"，是"没测出来"。写 0 会让界面显示"0 页"，
            # 而 NULL 会被界面渲染成"—"，后者才是诚实的。
            return
        with self._db.session() as conn:
            conn.execute(
                "UPDATE documents SET page_count = ?, updated_at = ? WHERE id = ?",
                (page_count, _dump(_now()), document_id),
            )

    def mark_document_split(self, document_id: str, is_split: bool = True) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE documents SET is_split = ?, updated_at = ? WHERE id = ?",
                (1 if is_split else 0, _dump(_now()), document_id),
            )

    # ------------------------------------------------------------------ chunk

    def replace_chunks(self, document_id: str, chunks: Sequence[ChunkRecord]) -> None:
        """整体替换某文档的 chunk（同一事务内先删后插），供增量更新与重跑使用。"""
        with self._db.session() as conn:
            conn.execute("DELETE FROM chunks WHERE document_id = ?", (document_id,))
            if not chunks:
                return
            conn.executemany(
                """
                INSERT INTO chunks
                    (chunk_id, document_id, knowledge_base_id, part_id, ordinal, text,
                     content_hash, heading_path, page, questions)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        chunk.chunk_id,
                        chunk.document_id,
                        chunk.knowledge_base_id,
                        chunk.part_id,
                        chunk.ordinal,
                        chunk.text,
                        chunk.content_hash,
                        chunk.heading_path,
                        chunk.page,
                        _json(list(chunk.questions)),
                    )
                    for chunk in chunks
                ],
            )
            conn.executemany(
                "INSERT INTO chunk_images (chunk_id, image_id) VALUES (?, ?)",
                [
                    (chunk.chunk_id, image_id)
                    for chunk in chunks
                    for image_id in chunk.image_ids
                ],
            )

    def iter_chunks(self, document_id: str, *, limit: int | None = None) -> Iterable[ChunkRecord]:
        # LIMIT 直接下推到 SQL：预览只要前几块，没必要把整份正文读出来再切
        sql = "SELECT * FROM chunks WHERE document_id = ? ORDER BY ordinal"
        params: list[object] = [document_id]
        if limit is not None:
            sql += " LIMIT ?"
            params.append(max(0, limit))
        with self._db.read() as conn:
            rows = conn.execute(sql, params).fetchall()
            images = self._images_by_chunk(conn, [row["chunk_id"] for row in rows])
        return [
            ChunkRecord(
                chunk_id=row["chunk_id"],
                document_id=row["document_id"],
                knowledge_base_id=row["knowledge_base_id"],
                part_id=row["part_id"],
                ordinal=row["ordinal"],
                text=row["text"],
                content_hash=row["content_hash"],
                heading_path=row["heading_path"],
                page=row["page"],
                image_ids=tuple(images.get(row["chunk_id"], ())),
                disabled=bool(row["disabled"]),
                questions=tuple(json.loads(row["questions"])),
            )
            for row in rows
        ]

    def sample_chunks(
        self, kb_ids: Sequence[str], *, limit: int, with_questions_only: bool = False
    ) -> list[ChunkRecord]:
        """从若干知识库随机抽切块（跳过人工禁用的）。

        两个用途：入库时出题的语料采样，以及**读端**（对话页空状态）随机抽几块、
        把它们已存的问题取出来展示（v23）。

        ``with_questions_only=True`` 是读端必须加的：库里的块**绝大部分没有题**
        （只有开过出题或事后补过的文档才有），在全库随机抽只会一次次抽到空块，
        于是"库里明明有上百条问题，空状态却什么都没有"（v24 实测：10 次调用有 5 次为空）。
        加上这个过滤，抽样的分母就是"有题的块"，有几条就能稳定看到几条。
        """
        if not kb_ids or limit <= 0:
            return []
        placeholders = ",".join("?" * len(kb_ids))
        # questions 的写入侧只经 _json（replace_chunks / update_chunk），永远是合法 JSON 数组
        only_questions = " AND questions <> '[]'" if with_questions_only else ""
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM chunks "  # noqa: S608
                f"WHERE knowledge_base_id IN ({placeholders}) AND disabled = 0"
                f"{only_questions}"
                " ORDER BY RANDOM() LIMIT ?",
                [*kb_ids, limit],
            ).fetchall()
        return [
            ChunkRecord(
                chunk_id=row["chunk_id"],
                document_id=row["document_id"],
                knowledge_base_id=row["knowledge_base_id"],
                part_id=row["part_id"],
                ordinal=row["ordinal"],
                text=row["text"],
                content_hash=row["content_hash"],
                heading_path=row["heading_path"],
                page=row["page"],
                disabled=bool(row["disabled"]),
                questions=tuple(json.loads(row["questions"])),
            )
            for row in rows
        ]

    def get_chunks(self, chunk_ids: Sequence[str]) -> list[ChunkRecord]:
        """按 ID 批量取回。检索时向量只给得出 chunk_id，正文与图片锚点得回表取；
        逐个查会退化成 N 次查询，所以接口层就要求批量。"""
        if not chunk_ids:
            return []
        placeholders = ",".join("?" * len(chunk_ids))

        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM chunks "  # noqa: S608
                f"WHERE chunk_id IN ({placeholders})",
                list(chunk_ids),
            ).fetchall()
            images = self._images_by_chunk(conn, [row["chunk_id"] for row in rows])
        return [
            ChunkRecord(
                chunk_id=row["chunk_id"],
                document_id=row["document_id"],
                knowledge_base_id=row["knowledge_base_id"],
                part_id=row["part_id"],
                ordinal=row["ordinal"],
                text=row["text"],
                content_hash=row["content_hash"],
                heading_path=row["heading_path"],
                page=row["page"],
                image_ids=tuple(images.get(row["chunk_id"], ())),
                disabled=bool(row["disabled"]),
                questions=tuple(json.loads(row["questions"])),
            )
            for row in rows
        ]

    def count_chunks(self, document_id: str) -> int:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?", (document_id,)
            ).fetchone()
        return int(row["n"])

    # ------------------------------------------------------------------ 切块人工干预

    def update_chunk(self, record: ChunkRecord) -> None:
        """就地更新一个块。

        **不改 chunk_id**：它是向量表与全文索引的主键，改了就得三处联动重建；
        而"用户改了一段文字"这件事本身不改变这块在文档里的身份。

        ``ordinal`` 要一起更新：删块之后的重排全靠它。原先漏了这一列，
        于是"重排"变成空操作——删掉中间一块后界面仍显示第 1、2、4 块，
        用户以为丢了数据（测试抓到）。
        """
        with self._db.session() as conn:
            conn.execute(
                "UPDATE chunks SET text = ?, content_hash = ?, heading_path = ?,"
                " page = ?, disabled = ?, ordinal = ?, questions = ? WHERE chunk_id = ?",
                (
                    record.text,
                    record.content_hash,
                    record.heading_path,
                    record.page,
                    int(record.disabled),
                    record.ordinal,
                    _json(list(record.questions)),
                    record.chunk_id,
                ),
            )

    def set_chunk_disabled(self, chunk_id: str, *, disabled: bool) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE chunks SET disabled = ? WHERE chunk_id = ?",
                (int(disabled), chunk_id),
            )

    def delete_chunk(self, chunk_id: str) -> None:
        """删除单个块及其图片关联。

        只删元数据：**全文索引与向量必须由调用方一并清理**——
        它们分属不同仓储（FTS 表、向量分区），在这里跨仓储删除会破坏分层纪律
        （services/ 之下不该出现跨存储的编排）。所以这个方法的契约是
        "调用方负责连带清理"，由 ``services/chunk.py`` 统一编排。
        """
        with self._db.session() as conn:
            conn.execute("DELETE FROM chunk_images WHERE chunk_id = ?", (chunk_id,))
            conn.execute("DELETE FROM chunks WHERE chunk_id = ?", (chunk_id,))

    def count_chunks_by_documents(self, document_ids: Sequence[str]) -> dict[str, int]:
        """一次查完多个文档的切块数。

        文档列表页要显示每个文档"有多少块"，逐个 ``count_chunks`` 就是 N+1：
        1000 个文档 = 1000 次查询。这里用一条 ``GROUP BY`` 拿全，缺的补 0。
        """
        wanted = list(dict.fromkeys(document_ids))  # 去重但保序
        if not wanted:
            return {}
        placeholders = ",".join("?" * len(wanted))
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT document_id, COUNT(*) AS n FROM chunks "  # noqa: S608
                f"WHERE document_id IN ({placeholders}) GROUP BY document_id",
                tuple(wanted),
            ).fetchall()
        counted = {str(row["document_id"]): int(row["n"]) for row in rows}
        return {document_id: counted.get(document_id, 0) for document_id in wanted}

    def question_stats_by_documents(
        self, document_ids: Sequence[str]
    ) -> dict[str, tuple[int, int]]:
        """批量查每个文档的 ``(有题块数, 问题总数)``。

        ``json_array_length`` 走 SQLite 自带的 JSON1（3.38+ 默认编译进来）；
        ``questions`` 这一列的写入侧只经 ``_json``（见 replace_chunks / update_chunk），
        所以永远是合法 JSON 数组——不会因为一行脏数据把整个列表接口打挂。
        """
        wanted = list(dict.fromkeys(document_ids))  # 去重但保序
        if not wanted:
            return {}
        placeholders = ",".join("?" * len(wanted))
        sql = (
            "SELECT document_id,"  # noqa: S608
            " SUM(CASE WHEN questions <> '[]' THEN 1 ELSE 0 END) AS with_questions,"
            " SUM(json_array_length(questions)) AS total"
            f" FROM chunks WHERE document_id IN ({placeholders}) GROUP BY document_id"
        )
        with self._db.read() as conn:
            rows = conn.execute(sql, tuple(wanted)).fetchall()
        stats = {
            str(row["document_id"]): (int(row["with_questions"] or 0), int(row["total"] or 0))
            for row in rows
        }
        return {document_id: stats.get(document_id, (0, 0)) for document_id in wanted}

    def active_question_documents(self, document_ids: Sequence[str]) -> set[str]:
        wanted = list(dict.fromkeys(document_ids))
        if not wanted:
            return set()
        placeholders = ",".join("?" * len(wanted))
        sql = (
            "SELECT DISTINCT document_id FROM tasks"  # noqa: S608
            " WHERE kind = ? AND state IN (?, ?)"
            f" AND document_id IN ({placeholders})"
        )
        with self._db.read() as conn:
            rows = conn.execute(
                sql,
                (
                    TaskKind.QUESTIONS.value,
                    TaskState.PENDING.value,
                    TaskState.RUNNING.value,
                    *wanted,
                ),
            ).fetchall()
        return {str(row["document_id"]) for row in rows if row["document_id"]}

    # ------------------------------------------------------------------ Wiki（v24）

    @staticmethod
    def _wiki_page_from_row(row: sqlite3.Row) -> WikiPageRecord:
        return WikiPageRecord(
            id=row["id"],
            kb_id=row["kb_id"],
            parent_id=row["parent_id"],
            level=row["level"],
            ord=row["ord"],
            slug=row["slug"],
            title=row["title"],
            brief=row["brief"],
            content_md=row["content_md"],
            status=row["status"],
            model=row["model"],
            generated_at=_load(row["generated_at"]),
            created_at=_load(row["created_at"]),
            updated_at=_load(row["updated_at"]),
        )

    def replace_wiki_pages(
        self,
        kb_id: str,
        pages: Sequence[WikiPageRecord],
        sources: Sequence[WikiSourceRecord],
    ) -> None:
        with self._db.session() as conn:
            # 先删出处再删页面：不依赖 `PRAGMA foreign_keys` 是否打开
            # （老库/内存库的取值不一定一致），级联只是兜底。
            conn.execute(
                "DELETE FROM wiki_page_sources WHERE page_id IN"
                " (SELECT id FROM wiki_pages WHERE kb_id = ?)",
                (kb_id,),
            )
            conn.execute("DELETE FROM wiki_pages WHERE kb_id = ?", (kb_id,))
            if not pages:
                return
            stamp = _dump(_now())
            conn.executemany(
                "INSERT INTO wiki_pages"
                " (id, kb_id, parent_id, level, ord, slug, title, brief, content_md,"
                "  status, model, generated_at, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        page.id,
                        page.kb_id,
                        page.parent_id,
                        page.level,
                        page.ord,
                        page.slug,
                        page.title,
                        page.brief,
                        page.content_md,
                        page.status,
                        page.model,
                        _dump(page.generated_at) if page.generated_at else None,
                        _dump(page.created_at) if page.created_at else stamp,
                        _dump(page.updated_at) if page.updated_at else stamp,
                    )
                    for page in pages
                ],
            )
            if sources:
                conn.executemany(
                    "INSERT INTO wiki_page_sources"
                    " (page_id, chunk_id, document_id, rank, heading_path, page)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    [
                        (
                            item.page_id,
                            item.chunk_id,
                            item.document_id,
                            item.index,
                            item.heading_path,
                            item.page,
                        )
                        for item in sources
                    ],
                )

    def list_wiki_pages(self, kb_id: str) -> list[WikiPageRecord]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM wiki_pages WHERE kb_id = ? ORDER BY level, ord, title",
                (kb_id,),
            ).fetchall()
        return [self._wiki_page_from_row(row) for row in rows]

    def get_wiki_page(self, page_id: str) -> WikiPageRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM wiki_pages WHERE id = ?", (page_id,)).fetchone()
        return self._wiki_page_from_row(row) if row else None

    def list_wiki_sources(self, page_id: str) -> list[WikiSourceRecord]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM wiki_page_sources WHERE page_id = ? ORDER BY rank",
                (page_id,),
            ).fetchall()
        return [
            WikiSourceRecord(
                page_id=row["page_id"],
                chunk_id=row["chunk_id"],
                document_id=row["document_id"],
                rank=row["rank"],
                index=row["rank"],
                heading_path=row["heading_path"],
                page=row["page"],
            )
            for row in rows
        ]

    def wiki_stats(self, kb_id: str) -> tuple[int, datetime | None]:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n, MAX(generated_at) AS latest FROM wiki_pages WHERE kb_id = ?",
                (kb_id,),
            ).fetchone()
        if row is None:
            return 0, None
        return int(row["n"]), _load(row["latest"])

    # ------------------------------------------------------------------ 图片

    def add_images(self, records: Sequence[ImageRecord]) -> None:
        if not records:
            return
        with self._db.session() as conn:
            conn.executemany(
                """
                INSERT INTO images (image_id, document_id, storage_path, page, bbox, caption)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(image_id) DO UPDATE SET
                    storage_path = excluded.storage_path,
                    page = excluded.page,
                    bbox = excluded.bbox,
                    caption = excluded.caption
                """,
                [
                    (image.image_id, image.document_id, image.storage_path, image.page,
                     image.bbox, image.caption)
                    for image in records
                ],
            )

    def list_images(self, document_id: str) -> list[ImageRecord]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM images WHERE document_id = ? ORDER BY page, image_id",
                (document_id,),
            ).fetchall()
        return [
            ImageRecord(
                image_id=row["image_id"],
                document_id=row["document_id"],
                storage_path=row["storage_path"],
                page=row["page"],
                bbox=row["bbox"],
                caption=row["caption"],
            )
            for row in rows
        ]

    # ------------------------------------------------------------------ 解析产物

    def save_parse_result(self, record: ParseResultRecord) -> None:
        """按 (document_id, part_id) 幂等写入：重跑解析覆盖旧产物而不留垃圾。"""
        record.created_at = record.created_at or _now()
        with self._db.session() as conn:
            conn.execute(
                """
                INSERT INTO parse_results
                    (document_id, part_id, parser_name, markdown_path, probe_meta, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(document_id, part_id) DO UPDATE SET
                    parser_name = excluded.parser_name,
                    markdown_path = excluded.markdown_path,
                    probe_meta = excluded.probe_meta,
                    created_at = excluded.created_at
                """,
                (
                    record.document_id,
                    record.part_id or "",
                    record.parser_name,
                    record.markdown_path,
                    _json(record.probe_meta),
                    _dump(record.created_at),
                ),
            )

    def get_parse_result(self, document_id: str) -> ParseResultRecord | None:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT * FROM parse_results WHERE document_id = ? ORDER BY part_id LIMIT 1",
                (document_id,),
            ).fetchone()
        if not row:
            return None
        return ParseResultRecord(
            document_id=row["document_id"],
            part_id=row["part_id"] or None,
            parser_name=row["parser_name"],
            markdown_path=row["markdown_path"],
            probe_meta=json.loads(row["probe_meta"]),
            created_at=_load(row["created_at"]),
        )

    # ------------------------------------------------------------------ 任务队列

    def enqueue_task(self, record: TaskRecord) -> TaskRecord:
        stamp = _now()
        record.created_at = record.created_at or stamp
        record.updated_at = record.updated_at or stamp
        with self._db.session() as conn:
            conn.execute(
                """
                INSERT INTO tasks
                    (id, kind, state, payload, document_id, part_id, attempts, max_attempts,
                     lease_owner, lease_expires_at, next_run_at, error, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.kind.value,
                    record.state.value,
                    _json(record.payload),
                    record.document_id,
                    record.part_id,
                    record.attempts,
                    record.max_attempts,
                    record.lease_owner,
                    _dump(record.lease_expires_at),
                    _dump(record.next_run_at),
                    record.error,
                    _dump(record.created_at),
                    _dump(record.updated_at),
                ),
            )
        return record

    def claim_task(self, *, owner: str, lease_seconds: int) -> TaskRecord | None:
        """原子领取一个待执行任务。单条语句完成"选中 + 加租约 + 计数"，避免并发双领。"""
        now = _now()
        with self._db.session() as conn:
            row = conn.execute(
                """
                UPDATE tasks
                   SET state = ?,
                       lease_owner = ?,
                       lease_expires_at = ?,
                       attempts = attempts + 1,
                       updated_at = ?
                 WHERE id = (
                       SELECT id FROM tasks
                        WHERE state = ?
                          AND (next_run_at IS NULL OR next_run_at <= ?)
                        ORDER BY created_at
                        LIMIT 1
                 )
                RETURNING *
                """,
                (
                    TaskState.RUNNING.value,
                    owner,
                    _dump(now + timedelta(seconds=lease_seconds)),
                    _dump(now),
                    TaskState.PENDING.value,
                    _dump(now),
                ),
            ).fetchone()
        return self._task_from_row(row) if row else None

    def heartbeat_task(self, task_id: str, *, owner: str, lease_seconds: int) -> bool:
        """续租。只有仍持有租约的消费者能续，返回 False 表示已被回收。"""
        now = _now()
        with self._db.session() as conn:
            cursor = conn.execute(
                """
                UPDATE tasks
                   SET lease_expires_at = ?, updated_at = ?
                 WHERE id = ? AND lease_owner = ? AND state = ?
                """,
                (
                    _dump(now + timedelta(seconds=lease_seconds)),
                    _dump(now),
                    task_id,
                    owner,
                    TaskState.RUNNING.value,
                ),
            )
        return cursor.rowcount == 1

    def finish_task(
        self, task_id: str, state: TaskState, *, owner: str, error: str | None = None
    ) -> bool:
        """落终态。条件更新 ``lease_owner = owner``：租约被回收后原消费者写不进来。"""
        with self._db.session() as conn:
            cursor = conn.execute(
                """
                UPDATE tasks
                   SET state = ?, error = ?, lease_owner = NULL, lease_expires_at = NULL,
                       updated_at = ?
                 WHERE id = ? AND lease_owner = ?
                """,
                (state.value, error, _dump(_now()), task_id, owner),
            )
        return cursor.rowcount == 1

    def cancel_tasks_for_document(self, document_id: str) -> int:
        """把这个文档还没结束的任务标成 canceled（见 ``MetaStore`` 的说明）。"""
        with self._db.session() as conn:
            cursor = conn.execute(
                """
                UPDATE tasks
                   SET state = ?, error = '已取消', lease_owner = NULL,
                       lease_expires_at = NULL, updated_at = ?
                 WHERE document_id = ? AND state IN (?, ?)
                """,
                (
                    TaskState.CANCELED.value,
                    _dump(_now()),
                    document_id,
                    TaskState.PENDING.value,
                    TaskState.RUNNING.value,
                ),
            )
        return int(cursor.rowcount)

    def reclaim_expired_tasks(self, *, now: datetime | None = None) -> int:
        """回收超时任务：还有重试额度就回到 PENDING（断点续跑），否则判失败。"""
        moment = _dump(now or _now())
        with self._db.session() as conn:
            exhausted = conn.execute(
                """
                UPDATE tasks
                   SET state = ?, error = '超过最大重试次数，已放弃', lease_owner = NULL,
                       lease_expires_at = NULL, updated_at = ?
                 WHERE state = ? AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
                   AND attempts >= max_attempts
                """,
                (TaskState.FAILED.value, moment, TaskState.RUNNING.value, moment),
            ).rowcount
            requeued = conn.execute(
                """
                UPDATE tasks
                   SET state = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
                 WHERE state = ? AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
                   AND attempts < max_attempts
                """,
                (TaskState.PENDING.value, moment, TaskState.RUNNING.value, moment),
            ).rowcount
        return int(exhausted + requeued)

    def reschedule_task(
        self, task_id: str, *, owner: str, next_run_at: datetime, error: str | None
    ) -> bool:
        """退回待执行并设定下次可领时间，同时释放租约（指数退避的落地）。

        同样按 ``owner`` 条件更新：租约被回收后原消费者不能再把任务拽回队列，
        否则会把新消费者刚领走的任务改回 PENDING，造成同一份文档被两个人同时处理。
        """
        with self._db.session() as conn:
            cursor = conn.execute(
                """
                UPDATE tasks
                   SET state = ?, next_run_at = ?, error = ?, lease_owner = NULL,
                       lease_expires_at = NULL, updated_at = ?
                 WHERE id = ? AND lease_owner = ?
                """,
                (
                    TaskState.PENDING.value,
                    _dump(next_run_at),
                    error,
                    _dump(_now()),
                    task_id,
                    owner,
                ),
            )
        return cursor.rowcount == 1

    def list_tasks(self, state: TaskState | None = None) -> list[TaskRecord]:
        with self._db.read() as conn:
            if state is None:
                rows = conn.execute("SELECT * FROM tasks ORDER BY created_at").fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM tasks WHERE state = ? ORDER BY created_at", (state.value,)
                ).fetchall()
        return [self._task_from_row(row) for row in rows]

    def get_task(self, task_id: str) -> TaskRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return self._task_from_row(row) if row else None

    # ------------------------------------------------------------------ 数据源 / 凭据 / webhook

    @staticmethod
    def _data_source_from_row(row: sqlite3.Row) -> DataSourceRecord:
        return DataSourceRecord(
            id=row["id"],
            knowledge_base_id=row["knowledge_base_id"],
            kind=DataSourceKind(row["kind"]),
            name=row["name"],
            config=json.loads(row["config"]),
            etag=row["etag"],
            last_pulled_at=_load(row["last_pulled_at"]),
            enabled=bool(row["enabled"]),
        )

    def get_data_source(self, source_id: str) -> DataSourceRecord | None:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT * FROM data_sources WHERE id = ?", (source_id,)
            ).fetchone()
        return self._data_source_from_row(row) if row else None

    def list_all_data_sources(self) -> list[DataSourceRecord]:
        with self._db.read() as conn:
            rows = conn.execute("SELECT * FROM data_sources ORDER BY id").fetchall()
        return [self._data_source_from_row(row) for row in rows]

    def update_data_source(self, record: DataSourceRecord) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE data_sources SET name = ?, config = ?, enabled = ? WHERE id = ?",
                (record.name, _json(record.config), int(record.enabled), record.id),
            )

    def delete_data_source(self, source_id: str) -> None:
        with self._db.session() as conn:
            conn.execute("DELETE FROM data_sources WHERE id = ?", (source_id,))

    def mark_data_source_pulled(self, source_id: str, *, etag: str | None) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE data_sources SET etag = ?, last_pulled_at = ? WHERE id = ?",
                (etag, _dump(_now()), source_id),
            )

    def create_data_source(self, record: DataSourceRecord) -> DataSourceRecord:
        with self._db.session() as conn:
            conn.execute(
                """
                INSERT INTO data_sources
                    (id, knowledge_base_id, kind, name, config, etag, last_pulled_at, enabled)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.knowledge_base_id,
                    record.kind.value,
                    record.name,
                    _json(record.config),
                    record.etag,
                    _dump(record.last_pulled_at),
                    int(record.enabled),
                ),
            )
        return record

    def list_data_sources(self, kb_id: str) -> list[DataSourceRecord]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM data_sources WHERE knowledge_base_id = ? ORDER BY name", (kb_id,)
            ).fetchall()
        return [
            DataSourceRecord(
                id=row["id"],
                knowledge_base_id=row["knowledge_base_id"],
                kind=DataSourceKind(row["kind"]),
                name=row["name"],
                config=json.loads(row["config"]),
                etag=row["etag"],
                last_pulled_at=_load(row["last_pulled_at"]),
                enabled=bool(row["enabled"]),
            )
            for row in rows
        ]

    def create_api_key(self, record: ApiKeyRecord) -> ApiKeyRecord:
        """只落哈希：明文 key 永不进库（架构 §3.2）。"""
        record.created_at = record.created_at or _now()
        with self._db.session() as conn:
            conn.execute(
                """
                INSERT INTO api_keys
                    (id, name, key_hash, permission, knowledge_base_ids, key_prefix,
                     created_by, created_at, last_used_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.name,
                    record.key_hash,
                    record.permission.value,
                    _json(list(record.knowledge_base_ids)),
                    record.key_prefix,
                    record.created_by,
                    _dump(record.created_at),
                    _dump(record.last_used_at),
                ),
            )
        return record

    @staticmethod
    def _api_key_from_row(row: sqlite3.Row) -> ApiKeyRecord:
        return ApiKeyRecord(
            id=row["id"],
            name=row["name"],
            key_hash=row["key_hash"],
            permission=ApiKeyPermission(row["permission"]),
            knowledge_base_ids=tuple(json.loads(row["knowledge_base_ids"])),
            key_prefix=row["key_prefix"],
            created_by=row["created_by"],
            created_at=_load(row["created_at"]),
            last_used_at=_load(row["last_used_at"]),
        )

    def get_api_key_by_hash(self, key_hash: str) -> ApiKeyRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM api_keys WHERE key_hash = ?", (key_hash,)).fetchone()
        return self._api_key_from_row(row) if row else None

    def list_api_keys(self) -> list[ApiKeyRecord]:
        with self._db.read() as conn:
            rows = conn.execute("SELECT * FROM api_keys ORDER BY created_at DESC").fetchall()
        return [self._api_key_from_row(row) for row in rows]

    def delete_api_key(self, key_id: str) -> None:
        with self._db.session() as conn:
            conn.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))

    def touch_api_key(self, key_id: str, *, used_at: datetime | None = None) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE api_keys SET last_used_at = ? WHERE id = ?",
                (_dump(used_at or _now()), key_id),
            )

    # ------------------------------------------------------------------ 幂等键

    def create_idempotency_key(self, record: IdempotencyRecord) -> IdempotencyRecord:
        """占住一个幂等键。

        用一个原子 INSERT 来"抢锁"：并发下只有一个会成功，另一个拿到唯一约束冲突。
        这比自己先 SELECT 再 INSERT 可靠——后者在两次调用之间有一个窗口，
        两个并发请求会同时看到"不存在"。
        """
        record.created_at = record.created_at or _now()
        try:
            with self._db.session() as conn:
                conn.execute(
                    "INSERT INTO idempotency_keys (key, request_hash, response, created_at)"
                    " VALUES (?, ?, ?, ?)",
                    # response 写真正的 SQL NULL，不写 _json(None) 得到的字符串 "null"：
                    # 后者让"还没挂响应"这件事在 SQL 侧没法用 IS NULL 判定，
                    # 而释放键与"进行中"判定都要靠它（实测踩到：释放成了空操作）
                    (
                        record.key,
                        record.request_hash,
                        _json(record.response) if record.response is not None else None,
                        _dump(record.created_at),
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise ConflictError(f"幂等键已被占用：{record.key}") from exc
        return record

    def get_idempotency_key(self, key: str) -> IdempotencyRecord | None:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT * FROM idempotency_keys WHERE key = ?", (key,)
            ).fetchone()
        if not row:
            return None
        raw = row["response"]
        return IdempotencyRecord(
            key=row["key"],
            request_hash=row["request_hash"],
            response=json.loads(raw) if raw else None,
            created_at=_load(row["created_at"]),
        )

    def save_idempotent_response(self, key: str, response: dict[str, object]) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE idempotency_keys SET response = ? WHERE key = ?",
                (_json(response), key),
            )

    def purge_expired_idempotency_keys(self, *, before: datetime) -> int:
        with self._db.session() as conn:
            cursor = conn.execute(
                "DELETE FROM idempotency_keys WHERE created_at < ?", (_dump(before),)
            )
        return cursor.rowcount or 0

    def release_idempotency_key(self, key: str) -> None:
        # 只删"还没挂上响应"的那种：已经成功过的键不能因为一次重放异常被放掉，
        # 那会让同一个键再被用来跑一遍业务。
        with self._db.session() as conn:
            conn.execute(
                "DELETE FROM idempotency_keys WHERE key = ? AND response IS NULL", (key,)
            )

    # ------------------------------------------------------------------ 使用者名册

    @staticmethod
    def _user_from_row(row: sqlite3.Row) -> UserRecord:
        return UserRecord(
            id=row["id"],
            name=row["name"],
            note=row["note"],
            username=row["username"],
            password_hash=row["password_hash"],
            role=UserRole(row["role"]),
            disabled=bool(row["disabled"]),
            created_at=_load(row["created_at"]),
        )

    def create_user(self, record: UserRecord) -> UserRecord:
        record.created_at = record.created_at or _now()
        try:
            with self._db.session() as conn:
                conn.execute(
                    """
                    INSERT INTO users (id, name, note, username, password_hash,
                                       role, disabled, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record.id,
                        record.name,
                        record.note,
                        record.username,
                        record.password_hash,
                        record.role.value,
                        int(record.disabled),
                        _dump(record.created_at),
                    ),
                )
        except sqlite3.IntegrityError as exc:
            # 冲突可能来自 id 主键、name 或 username 两个唯一索引，查出是哪个再给文案：
            # 管理员开通账号时，"用户名被占"与"花名册里有同名的人"是两种不同的处理
            with self._db.read() as conn:
                if conn.execute(
                    "SELECT 1 FROM users WHERE id = ?", (record.id,)
                ).fetchone():
                    raise ConflictError(f"使用者 id「{record.id}」已存在") from exc
                if record.username and conn.execute(
                    "SELECT 1 FROM users WHERE username = ?", (record.username,)
                ).fetchone():
                    raise ConflictError(f"用户名「{record.username}」已被占用") from exc
            raise ConflictError(f"已经有叫「{record.name}」的使用者了") from exc
        return record

    def get_user(self, user_id: str) -> UserRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return self._user_from_row(row) if row else None

    def find_user_by_name(self, name: str) -> UserRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM users WHERE name = ?", (name,)).fetchone()
        return self._user_from_row(row) if row else None

    def list_users(self) -> list[UserRecord]:
        with self._db.read() as conn:
            rows = conn.execute("SELECT * FROM users ORDER BY created_at, id").fetchall()
        return [self._user_from_row(row) for row in rows]

    def delete_user(self, user_id: str) -> None:
        """删使用者，但**保留他传过的数据**。

        文档已经进了知识库、已经向量化、可能已被引用——把使用者删掉就顺手
        删掉他的文档，那是数据丢失而不是权限撤销。所有归属列（文档上传者、
        库 owner、会话 owner、API Key 创建者）一律置空，界面显示"未记录"。
        会话与分享记录不靠这里清：它们挂在 FK 级联上（connection.py 开了
        ``PRAGMA foreign_keys``），随 users 行一起消失。
        """
        with self._db.session() as conn:
            conn.execute(
                "UPDATE documents SET uploaded_by = NULL WHERE uploaded_by = ?", (user_id,)
            )
            conn.execute(
                "UPDATE knowledge_bases SET owner_id = NULL WHERE owner_id = ?", (user_id,)
            )
            conn.execute(
                "UPDATE conversations SET owner_id = NULL WHERE owner_id = ?", (user_id,)
            )
            conn.execute(
                "UPDATE api_keys SET created_by = NULL WHERE created_by = ?", (user_id,)
            )
            conn.execute("DELETE FROM users WHERE id = ?", (user_id,))

    def count_documents_by_user(self, user_id: str) -> int:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM documents WHERE uploaded_by = ?", (user_id,)
            ).fetchone()
        return int(row["n"])

    # ------------------------------------------------------------------ 账号与会话

    def find_user_by_username(self, username: str) -> UserRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        return self._user_from_row(row) if row else None

    def update_user_password(self, user_id: str, password_hash: str) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id)
            )

    def set_user_disabled(self, user_id: str, disabled: bool) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE users SET disabled = ? WHERE id = ?", (int(disabled), user_id)
            )

    def claim_legacy_ownership(self, owner_id: str) -> dict[str, int]:
        with self._db.session() as conn:
            kbs = conn.execute(
                "UPDATE knowledge_bases SET owner_id = ? WHERE owner_id IS NULL", (owner_id,)
            ).rowcount
            conversations = conn.execute(
                "UPDATE conversations SET owner_id = ? WHERE owner_id IS NULL", (owner_id,)
            ).rowcount
        return {"knowledge_bases": kbs or 0, "conversations": conversations or 0}

    # ------------------------------------------------------------------ 会话

    @staticmethod
    def _session_from_row(row: sqlite3.Row) -> SessionRecord:
        return SessionRecord(
            id=row["id"],
            user_id=row["user_id"],
            created_at=_load(row["created_at"]),
            expires_at=_load(row["expires_at"]),  # type: ignore[arg-type]
            last_seen_at=_load(row["last_seen_at"]),
        )

    def create_session(self, record: SessionRecord) -> SessionRecord:
        stamp = _now()
        record.created_at = record.created_at or stamp
        record.last_seen_at = record.last_seen_at or stamp
        try:
            with self._db.session() as conn:
                conn.execute(
                    """
                    INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        record.id,
                        record.user_id,
                        _dump(record.created_at),
                        _dump(record.expires_at),
                        _dump(record.last_seen_at),
                    ),
                )
        except sqlite3.IntegrityError as exc:
            # 主键撞车（哈希碰撞，实际不可能）与外键违例（账号不存在）都落这里；
            # 对上层都是"这条会话建不成"，翻成领域错误而不是漏原生 sqlite 异常
            raise InvalidRequestError("会话创建失败：账号不存在或会话标识冲突") from exc
        return record

    def get_session(self, session_id: str) -> SessionRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return self._session_from_row(row) if row else None

    def touch_session(
        self, session_id: str, *, last_seen_at: datetime, expires_at: datetime
    ) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?",
                (_dump(last_seen_at), _dump(expires_at), session_id),
            )

    def delete_session(self, session_id: str) -> None:
        with self._db.session() as conn:
            conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    def delete_sessions_for_user(
        self, user_id: str, *, except_session_id: str | None = None
    ) -> int:
        with self._db.session() as conn:
            if except_session_id is None:
                cursor = conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            else:
                cursor = conn.execute(
                    "DELETE FROM sessions WHERE user_id = ? AND id != ?",
                    (user_id, except_session_id),
                )
        return cursor.rowcount or 0

    # ------------------------------------------------------------------ 知识库分享

    @staticmethod
    def _share_from_row(row: sqlite3.Row) -> ShareRecord:
        return ShareRecord(
            kb_id=row["kb_id"],
            user_id=row["user_id"],
            permission=SharePermission(row["permission"]),
            created_at=_load(row["created_at"]),
        )

    def put_share(self, record: ShareRecord) -> ShareRecord:
        record.created_at = record.created_at or _now()
        try:
            with self._db.session() as conn:
                conn.execute(
                    """
                    INSERT INTO kb_shares (kb_id, user_id, permission, created_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(kb_id, user_id) DO UPDATE SET permission = excluded.permission
                    """,
                    (
                        record.kb_id,
                        record.user_id,
                        record.permission.value,
                        _dump(record.created_at),
                    ),
                )
        except sqlite3.IntegrityError as exc:
            # 复合主键冲突已被 ON CONFLICT 接住，能落到这里的只剩外键违例
            raise InvalidRequestError("知识库或使用者不存在，无法分享") from exc
        # 重授只改档位：``created_at`` 要保留**首次授予**的时间，不随调整刷新——
        # 所以返回前回读一次，而不是把本地这份（带着新时间戳的）直接给出去
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT * FROM kb_shares WHERE kb_id = ? AND user_id = ?",
                (record.kb_id, record.user_id),
            ).fetchone()
        return self._share_from_row(row)

    def list_shares_for_kb(self, kb_id: str) -> list[ShareRecord]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM kb_shares WHERE kb_id = ? ORDER BY created_at", (kb_id,)
            ).fetchall()
        return [self._share_from_row(row) for row in rows]

    def list_shares_for_user(self, user_id: str) -> list[ShareRecord]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM kb_shares WHERE user_id = ? ORDER BY created_at", (user_id,)
            ).fetchall()
        return [self._share_from_row(row) for row in rows]

    def delete_share(self, kb_id: str, user_id: str) -> None:
        with self._db.session() as conn:
            conn.execute(
                "DELETE FROM kb_shares WHERE kb_id = ? AND user_id = ?", (kb_id, user_id)
            )

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
            created_at=_load(row["created_at"]),
        )

    def record_usage(self, record: UsageEventRecord) -> UsageEventRecord:
        record.created_at = record.created_at or _now()
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO usage_events"
                " (id, kind, provider, model_id, prompt_tokens, completion_tokens,"
                "  items, duration_ms, source, created_at)"
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
        params: tuple[object, ...] = ()
        if since is not None:
            sql += " WHERE created_at >= ?"
            params = (_dump(since),)
        sql += " ORDER BY created_at"
        with self._db.read() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._usage_from_row(row) for row in rows]

    def purge_usage_before(self, before: datetime) -> int:
        with self._db.session() as conn:
            cursor = conn.execute(
                "DELETE FROM usage_events WHERE created_at < ?", (_dump(before),)
            )
        return int(cursor.rowcount or 0)

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
            created_at=_load(row["created_at"]),
            updated_at=_load(row["updated_at"]),
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
            options=json.loads(row["options"]),
            created_at=_load(row["created_at"]),
            updated_at=_load(row["updated_at"]),
        )

    def create_model_provider(self, record: ModelProviderRecord) -> ModelProviderRecord:
        now = _now()
        record.created_at = record.created_at or now
        record.updated_at = record.updated_at or now
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO model_providers"
                " (id, kind, name, base_url, api_key, enabled, created_at, updated_at)"
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
                "SELECT * FROM model_providers ORDER BY created_at, id"
            ).fetchall()
        return [self._provider_from_row(row) for row in rows]

    def update_model_provider(self, record: ModelProviderRecord) -> None:
        record.updated_at = _now()
        with self._db.session() as conn:
            conn.execute(
                "UPDATE model_providers SET kind = ?, name = ?, base_url = ?,"
                " api_key = ?, enabled = ?, updated_at = ? WHERE id = ?",
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
        # 显式删子行（虽然连接开了 PRAGMA foreign_keys，级联也会删）：
        # 意图写在代码里比藏在 schema 里可读。只删供应商会留下指向不存在
        # 供应商的孤儿模型，而它还会出现在模型下拉里。
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
                    "  created_at, updated_at)"
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
            raise ConflictError(
                f"该供应商下已经登记过模型 {record.model_id}"
            ) from exc
        return record

    def get_registered_model(self, model_pk: str) -> RegisteredModelRecord | None:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT * FROM model_registry WHERE id = ?", (model_pk,)
            ).fetchone()
        return self._model_from_row(row) if row else None

    def list_registered_models(
        self, provider_id: str | None = None
    ) -> list[RegisteredModelRecord]:
        sql = "SELECT * FROM model_registry"
        params: tuple[object, ...] = ()
        if provider_id is not None:
            sql += " WHERE provider_id = ?"
            params = (provider_id,)
        sql += " ORDER BY created_at, id"
        with self._db.read() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._model_from_row(row) for row in rows]

    def update_registered_model(self, record: RegisteredModelRecord) -> None:
        record.updated_at = _now()
        with self._db.session() as conn:
            conn.execute(
                "UPDATE model_registry SET model_id = ?, label = ?, dim = ?,"
                " capabilities = ?, options = ?, updated_at = ? WHERE id = ?",
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

    # ------------------------------------------------------------------ 对话留存

    @staticmethod
    def _conversation_from_row(row: sqlite3.Row) -> ConversationRecord:
        return ConversationRecord(
            id=row["id"],
            title=row["title"],
            kb_ids=tuple(json.loads(row["kb_ids"])),
            owner_id=row["owner_id"],
            model_pk=row["model_pk"],
            # 可空列在旧库里是 NULL：``None`` 表示"跟随全局默认"，不要折成 False
            thinking=None if row["thinking"] is None else bool(row["thinking"]),
            thinking_effort=row["thinking_effort"],
            pinned=bool(row["pinned"]),
            created_at=_load(row["created_at"]),
            updated_at=_load(row["updated_at"]),
        )

    @staticmethod
    def _message_from_row(row: sqlite3.Row) -> ChatMessageRecord:
        return ChatMessageRecord(
            id=row["id"],
            conversation_id=row["conversation_id"],
            role=row["role"],
            content=row["content"],
            sources=tuple(json.loads(row["sources"])),
            created_at=_load(row["created_at"]),
        )

    def create_conversation(self, record: ConversationRecord) -> ConversationRecord:
        now = _now()
        record.created_at = record.created_at or now
        record.updated_at = record.updated_at or now
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO conversations"
                " (id, title, kb_ids, owner_id, model_pk, thinking, thinking_effort,"
                "  created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.title,
                    _json(list(record.kb_ids)),
                    record.owner_id,
                    record.model_pk,
                    None if record.thinking is None else int(record.thinking),
                    record.thinking_effort,
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
        """置顶优先，其次最近更新；``q`` 按标题包含匹配（忽略大小写）。"""
        sql = "SELECT * FROM conversations"
        params: list[object] = []
        if q:
            # 与文档搜索同一套转义：用户搜 "a_b" 要字面匹配，而不是"a 后跟任意一字符"
            escaped = q.replace("\\", r"\\").replace("%", r"\%").replace("_", r"\_")
            sql += r" WHERE title LIKE ? ESCAPE '\'"
            params.append(f"%{escaped}%")
        # **置顶的排最前**，其余按最近更新。SQLite 里 pinned 是 0/1，直接 DESC 即可
        sql += " ORDER BY pinned DESC, updated_at DESC"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        with self._db.read() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._conversation_from_row(row) for row in rows]

    def set_conversation_pinned(self, conversation_id: str, pinned: bool) -> None:
        # 与改名同理：不推 updated_at
        with self._db.session() as conn:
            conn.execute(
                "UPDATE conversations SET pinned = ? WHERE id = ?",
                (1 if pinned else 0, conversation_id),
            )

    def delete_chat_messages(self, message_ids: Sequence[str]) -> int:
        if not message_ids:
            return 0
        # 与上面的批量查询同一手法：placeholders 只由 "?" 拼成（数量来自 len），
        # 真正的值走参数绑定。S608 在这里是误报。
        placeholders = ",".join("?" * len(message_ids))
        with self._db.session() as conn:
            cursor = conn.execute(
                f"DELETE FROM chat_messages WHERE id IN ({placeholders})",  # noqa: S608
                list(message_ids),
            )
        return int(cursor.rowcount or 0)

    def rename_conversation(self, conversation_id: str, title: str) -> None:
        # 改名不推 updated_at：否则用户整理一遍标题列表，会话按"最近更新"的排序
        # 会全乱——他想按对话发生的时间找，不是按自己改标题的时间
        with self._db.session() as conn:
            conn.execute(
                "UPDATE conversations SET title = ? WHERE id = ?", (title, conversation_id)
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
        with self._db.session() as conn:
            conn.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
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

        显式删消息而不是只靠外键级联（连接的 ``PRAGMA foreign_keys`` 是开的，
        级联也能删，但意图写在代码里比藏在 schema 里可读）。只删会话会留下
        一堆孤儿消息，而且它们会一直被 ``list_messages`` 之外的地方查到
        （例如按会话聚合的统计）。
        """
        with self._db.session() as conn:
            conn.execute(
                "DELETE FROM chat_messages WHERE conversation_id = ?", (conversation_id,)
            )
            conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))

    def append_message(self, record: ChatMessageRecord) -> ChatMessageRecord:
        record.created_at = record.created_at or _now()
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO chat_messages"
                " (id, conversation_id, role, content, sources, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.conversation_id,
                    record.role,
                    record.content,
                    _json([dict(item) for item in record.sources]),
                    _dump(record.created_at),
                ),
            )
        return record

    def list_messages(self, conversation_id: str) -> list[ChatMessageRecord]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM chat_messages WHERE conversation_id = ?"
                " ORDER BY created_at, rowid",
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

    def create_webhook(self, record: WebhookRecord) -> WebhookRecord:
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO webhooks (id, url, events, secret, enabled) VALUES (?, ?, ?, ?, ?)",
                (record.id, record.url, _json(list(record.events)), record.secret,
                 int(record.enabled)),
            )
        return record

    def list_webhooks(self) -> list[WebhookRecord]:
        with self._db.read() as conn:
            rows = conn.execute("SELECT * FROM webhooks ORDER BY id").fetchall()
        return [_webhook_of(row) for row in rows]

    def get_webhook(self, webhook_id: str) -> WebhookRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM webhooks WHERE id = ?", (webhook_id,)).fetchone()
        return _webhook_of(row) if row else None

    def set_webhook_enabled(self, webhook_id: str, enabled: bool) -> WebhookRecord | None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE webhooks SET enabled = ? WHERE id = ?", (int(enabled), webhook_id)
            )
        return self.get_webhook(webhook_id)

    def delete_webhook(self, webhook_id: str) -> None:
        with self._db.session() as conn:
            conn.execute("DELETE FROM webhooks WHERE id = ?", (webhook_id,))

    # ------------------------------------------------------------------ 回收站

    def add_to_trash(self, record: TrashRecord) -> None:
        record.created_at = record.created_at or _now()
        with self._db.session() as conn:
            conn.execute(
                """
                INSERT INTO trash (id, document_id, kind, storage_path, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.document_id,
                    record.kind.value,
                    record.storage_path,
                    _dump(record.expires_at),
                    _dump(record.created_at),
                ),
            )

    def list_trash(self) -> list[TrashRecord]:
        with self._db.read() as conn:
            rows = conn.execute("SELECT * FROM trash ORDER BY created_at").fetchall()
        return [
            TrashRecord(
                id=row["id"],
                document_id=row["document_id"],
                kind=TrashKind(row["kind"]),
                storage_path=row["storage_path"],
                expires_at=_load(row["expires_at"]),  # type: ignore[arg-type]
                created_at=_load(row["created_at"]),
            )
            for row in rows
        ]

    def set_trash_expiry(self, trash_id: str, expires_at: datetime) -> None:
        with self._db.session() as conn:
            conn.execute(
                "UPDATE trash SET expires_at = ? WHERE id = ?",
                (_dump(expires_at), trash_id),
            )

    def delete_trash(self, trash_id: str) -> None:
        with self._db.session() as conn:
            conn.execute("DELETE FROM trash WHERE id = ?", (trash_id,))

    def purge_expired_trash(self, *, now: datetime | None = None) -> list[TrashRecord]:
        """到期清理：先取出待删清单（供调用方删文件），再在**同一事务**里删记录。"""
        moment = _dump(now or _now())
        with self._db.session() as conn:
            rows = conn.execute(
                "SELECT * FROM trash WHERE expires_at <= ? ORDER BY expires_at", (moment,)
            ).fetchall()
            conn.execute("DELETE FROM trash WHERE expires_at <= ?", (moment,))
        return [
            TrashRecord(
                id=row["id"],
                document_id=row["document_id"],
                kind=TrashKind(row["kind"]),
                storage_path=row["storage_path"],
                expires_at=_load(row["expires_at"]),  # type: ignore[arg-type]
                created_at=_load(row["created_at"]),
            )
            for row in rows
        ]

    # ------------------------------------------------------------------ 设置

    def get_setting(self, key: str) -> str | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_setting(self, key: str, value: str) -> None:
        with self._db.session() as conn:
            conn.execute(
                """
                INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                               updated_at = excluded.updated_at
                """,
                (key, value, _dump(_now())),
            )

    def delete_setting(self, key: str) -> None:
        with self._db.session() as conn:
            conn.execute("DELETE FROM app_settings WHERE key = ?", (key,))

    # ------------------------------------------------------------------ 行映射

    @staticmethod
    def _images_by_chunk(
        conn: sqlite3.Connection, chunk_ids: Sequence[str]
    ) -> dict[str, list[str]]:
        if not chunk_ids:
            return {}
        placeholders = ",".join("?" * len(chunk_ids))

        # 这是 SQLite 里 IN (?, ?, ...) 的标准写法，不存在拼接注入面。
        rows = conn.execute(
            "SELECT chunk_id, image_id FROM chunk_images "  # noqa: S608
            f"WHERE chunk_id IN ({placeholders})",
            list(chunk_ids),
        ).fetchall()
        grouped: dict[str, list[str]] = {}
        for row in rows:
            grouped.setdefault(row["chunk_id"], []).append(row["image_id"])
        return grouped

    @staticmethod
    def _kb_from_row(row: sqlite3.Row) -> KnowledgeBaseRecord:
        return KnowledgeBaseRecord(
            id=row["id"],
            name=row["name"],
            description=row["description"],
            embedding_model_id=row["embedding_model_id"],
            embedding_dim=row["embedding_dim"],
            embedding_base_url=row["embedding_base_url"],
            embedding_model_pk=row["embedding_model_pk"],
            chunk_strategy=row["chunk_strategy"],
            chunk_size=row["chunk_size"],
            chunk_overlap=row["chunk_overlap"],
            suggested_enabled=bool(row["suggested_enabled"]),
            suggested_count=row["suggested_count"],
            wiki_enabled=bool(row["wiki_enabled"]),
            suggested_model_pk=row["suggested_model_pk"],
            suggested_prompt=row["suggested_prompt"],
            owner_id=row["owner_id"],
            created_at=_load(row["created_at"]),
            updated_at=_load(row["updated_at"]),
        )

    @staticmethod
    def _document_from_row(row: sqlite3.Row) -> DocumentRecord:
        return DocumentRecord(
            id=row["id"],
            knowledge_base_id=row["knowledge_base_id"],
            name=row["name"],
            source_kind=DataSourceKind(row["source_kind"]),
            content_hash=row["content_hash"],
            stage=DocumentStage(row["stage"]),
            size_bytes=row["size_bytes"],
            mime_type=row["mime_type"],
            page_count=row["page_count"],
            is_split=bool(row["is_split"]),
            error=row["error"],
            uploaded_by=row["uploaded_by"],
            folder_id=row["folder_id"],
            disabled=bool(row["disabled"]),
            created_at=_load(row["created_at"]),
            updated_at=_load(row["updated_at"]),
        )

    @staticmethod
    def _task_from_row(row: sqlite3.Row) -> TaskRecord:
        return TaskRecord(
            id=row["id"],
            kind=TaskKind(row["kind"]),
            state=TaskState(row["state"]),
            payload=json.loads(row["payload"]),
            document_id=row["document_id"],
            part_id=row["part_id"],
            attempts=row["attempts"],
            max_attempts=row["max_attempts"],
            lease_owner=row["lease_owner"],
            lease_expires_at=_load(row["lease_expires_at"]),
            next_run_at=_load(row["next_run_at"]),
            error=row["error"],
            created_at=_load(row["created_at"]),
            updated_at=_load(row["updated_at"]),
        )
