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

from app.models.enums import (
    ApiKeyPermission,
    DataSourceKind,
    DocumentStage,
    TaskKind,
    TaskState,
    TrashKind,
)
from app.storage.base import (
    ApiKeyRecord,
    ChunkRecord,
    DataSourceRecord,
    DocumentPartRecord,
    DocumentRecord,
    ImageRecord,
    KnowledgeBaseRecord,
    MetaStore,
    ParseResultRecord,
    TaskRecord,
    TrashRecord,
    WebhookRecord,
)
from app.storage.sqlite_impl.connection import Database


def _now() -> datetime:
    return datetime.now(UTC)


def _dump(moment: datetime | None) -> str | None:
    return moment.isoformat() if moment else None


def _load(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


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
                    (id, name, embedding_model_id, embedding_dim, embedding_base_url,
                     chunk_strategy, chunk_size, chunk_overlap, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.name,
                    record.embedding_model_id,
                    record.embedding_dim,
                    record.embedding_base_url,
                    record.chunk_strategy,
                    record.chunk_size,
                    record.chunk_overlap,
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
                     mime_type, page_count, is_split, error, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    _dump(record.created_at),
                    _dump(record.updated_at),
                ),
            )
        return record

    def get_document(self, document_id: str) -> DocumentRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
        return self._document_from_row(row) if row else None

    def get_document_by_hash(self, kb_id: str, content_hash: str) -> DocumentRecord | None:
        """架构 §6.3 的文件级去重：同库同 hash 只应有一份。"""
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT * FROM documents WHERE knowledge_base_id = ? AND content_hash = ?",
                (kb_id, content_hash),
            ).fetchone()
        return self._document_from_row(row) if row else None

    def list_documents(self, kb_id: str) -> list[DocumentRecord]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM documents WHERE knowledge_base_id = ? ORDER BY created_at DESC",
                (kb_id,),
            ).fetchall()
        return [self._document_from_row(row) for row in rows]

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

    # ------------------------------------------------------------------ 子文件

    def create_document_parts(self, records: Sequence[DocumentPartRecord]) -> None:
        if not records:
            return
        with self._db.session() as conn:
            conn.executemany(
                """
                INSERT INTO document_parts
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
                     content_hash, heading_path, page)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    def iter_chunks(self, document_id: str) -> Iterable[ChunkRecord]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT * FROM chunks WHERE document_id = ? ORDER BY ordinal", (document_id,)
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
            )
            for row in rows
        ]

    def count_chunks(self, document_id: str) -> int:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?", (document_id,)
            ).fetchone()
        return int(row["n"])

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

    def finish_task(self, task_id: str, state: TaskState, *, error: str | None = None) -> None:
        with self._db.session() as conn:
            conn.execute(
                """
                UPDATE tasks
                   SET state = ?, error = ?, lease_owner = NULL, lease_expires_at = NULL,
                       updated_at = ?
                 WHERE id = ?
                """,
                (state.value, error, _dump(_now()), task_id),
            )

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

    def list_tasks(self, state: TaskState | None = None) -> list[TaskRecord]:
        with self._db.read() as conn:
            if state is None:
                rows = conn.execute("SELECT * FROM tasks ORDER BY created_at").fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM tasks WHERE state = ? ORDER BY created_at", (state.value,)
                ).fetchall()
        return [self._task_from_row(row) for row in rows]

    # ------------------------------------------------------------------ 数据源 / 凭据 / webhook

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
                    (id, name, key_hash, permission, knowledge_base_ids, created_at, last_used_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.name,
                    record.key_hash,
                    record.permission.value,
                    _json(list(record.knowledge_base_ids)),
                    _dump(record.created_at),
                    _dump(record.last_used_at),
                ),
            )
        return record

    def get_api_key_by_hash(self, key_hash: str) -> ApiKeyRecord | None:
        with self._db.read() as conn:
            row = conn.execute("SELECT * FROM api_keys WHERE key_hash = ?", (key_hash,)).fetchone()
        if not row:
            return None
        return ApiKeyRecord(
            id=row["id"],
            name=row["name"],
            key_hash=row["key_hash"],
            permission=ApiKeyPermission(row["permission"]),
            knowledge_base_ids=tuple(json.loads(row["knowledge_base_ids"])),
            created_at=_load(row["created_at"]),
            last_used_at=_load(row["last_used_at"]),
        )

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
        return [
            WebhookRecord(
                id=row["id"],
                url=row["url"],
                events=tuple(json.loads(row["events"])),
                secret=row["secret"],
                enabled=bool(row["enabled"]),
            )
            for row in rows
        ]

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
            embedding_model_id=row["embedding_model_id"],
            embedding_dim=row["embedding_dim"],
            embedding_base_url=row["embedding_base_url"],
            chunk_strategy=row["chunk_strategy"],
            chunk_size=row["chunk_size"],
            chunk_overlap=row["chunk_overlap"],
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
