"""``VectorStore`` 的 SQLite + sqlite-vec 实现（M1 T1.4）。

按知识库分区：每个库一张 ``vec_<kb_id>`` 虚拟表，**维度在分区创建时确定**（D4 的落地方式）。
这样"换模型要新建库、换 endpoint 可保留"（架构 §6.4）就是运行时校验，而非 schema 常量。

本机实测（sqlite-vec 0.1.9）确定的三条实现约束：

1. ``vec0`` 支持 ``chunk_id TEXT PRIMARY KEY``，可用业务 ID 直接做主键；
2. **``INSERT OR REPLACE`` 在 vec0 上不可用**（报 UNIQUE constraint failed），
   覆盖写必须"先 DELETE 再 INSERT"，且必须在同一事务里；
3. 维度不符时 sqlite-vec 自己会拒绝写入，但我们仍先显式校验——为了给出可读的错误，
   而不是让调用方看到一句 ``OperationalError``。

量化说明：当前用 float32 存原始向量（正确性优先）。架构 §8.3 计划默认 int8 量化，
属容量优化项，需先有 bench 数据（M3）再切换，届时走新增迁移，不改已发布迁移。
"""

from __future__ import annotations

import re
import struct
from collections.abc import Sequence

from app.storage.base import VectorDimensionMismatch, VectorMatch, VectorStore
from app.storage.sqlite_impl.connection import Database

_TABLE_PREFIX = "vec_"
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
"""知识库 ID 会拼进表名（SQL 无法参数化表名），因此必须白名单校验。"""

_DECLARED_DIM = re.compile(r"float\[(\d+)\]")


def _pack(vector: Sequence[float]) -> bytes:
    """打包成 float32 小端二进制：比 JSON 文本省一半空间且无需解析。"""
    return struct.pack(f"{len(vector)}f", *vector)


class SqliteVectorStore(VectorStore):
    """向量仓储的 SQLite 实现。"""

    def __init__(self, database: Database) -> None:
        self._db = database

    # ------------------------------------------------------------------ 分区

    def ensure_partition(self, kb_id: str, *, dim: int) -> None:
        if dim <= 0:
            raise ValueError("向量维度必须为正整数")
        table = self._table(kb_id)

        with self._db.session() as conn:
            existing = self._declared_dim(conn, table)
            if existing is None:
                conn.execute(
                    f"CREATE VIRTUAL TABLE {table} USING vec0("
                    f"chunk_id TEXT PRIMARY KEY, embedding float[{int(dim)}])"
                )
            elif existing != dim:
                raise VectorDimensionMismatch(
                    f"知识库 {kb_id} 的向量分区已是 {existing} 维，"
                    f"不能按 {dim} 维写入（架构 §6.4：维度不同不可混用）"
                )

    def drop_partition(self, kb_id: str) -> None:
        with self._db.session() as conn:
            conn.execute(f"DROP TABLE IF EXISTS {self._table(kb_id)}")

    def declared_dim(self, kb_id: str) -> int | None:
        """读取分区实际维度；未建分区返回 None。供上层做模型/维度校验。"""
        with self._db.read() as conn:
            return self._declared_dim(conn, self._table(kb_id))

    # ------------------------------------------------------------------ 写入

    def upsert_vectors(
        self, kb_id: str, *, items: Sequence[tuple[str, Sequence[float]]]
    ) -> None:
        if not items:
            return
        table = self._table(kb_id)
        with self._db.session() as conn:
            dim = self._declared_dim(conn, table)
            if dim is None:
                raise VectorDimensionMismatch(f"知识库 {kb_id} 尚未建立向量分区")

            for chunk_id, vector in items:
                if len(vector) != dim:
                    raise VectorDimensionMismatch(
                        f"chunk {chunk_id} 的向量是 {len(vector)} 维，分区是 {dim} 维"
                    )

            # vec0 不支持 INSERT OR REPLACE，只能先删后插（同一事务，不会出现空洞）
            conn.executemany(
                f"DELETE FROM {table} WHERE chunk_id = ?",  # noqa: S608
                [(chunk_id,) for chunk_id, _ in items],
            )
            conn.executemany(
                f"INSERT INTO {table}(chunk_id, embedding) VALUES (?, ?)",  # noqa: S608
                [(chunk_id, _pack(vector)) for chunk_id, vector in items],
            )

    def delete_vectors(self, kb_id: str, *, chunk_ids: Sequence[str]) -> int:
        if not chunk_ids:
            return 0
        table = self._table(kb_id)
        with self._db.session() as conn:
            if self._declared_dim(conn, table) is None:
                return 0
            cursor = conn.executemany(
                f"DELETE FROM {table} WHERE chunk_id = ?",  # noqa: S608
                [(chunk_id,) for chunk_id in chunk_ids],
            )
        return cursor.rowcount if cursor.rowcount > 0 else 0

    # ------------------------------------------------------------------ 检索

    def search(
        self, kb_id: str, *, query_vector: Sequence[float], top_k: int
    ) -> list[VectorMatch]:
        if top_k <= 0:
            return []
        table = self._table(kb_id)
        with self._db.read() as conn:
            dim = self._declared_dim(conn, table)
            if dim is None:
                return []
            if len(query_vector) != dim:
                raise VectorDimensionMismatch(
                    f"查询向量 {len(query_vector)} 维，与知识库 {kb_id} 的 {dim} 维分区不符"
                )
            rows = conn.execute(
                f"SELECT chunk_id, distance FROM {table} "  # noqa: S608
                "WHERE embedding MATCH ? AND k = ? ORDER BY distance",
                (_pack(query_vector), top_k),
            ).fetchall()
        return [VectorMatch(chunk_id=row["chunk_id"], distance=row["distance"]) for row in rows]

    # ------------------------------------------------------------------ 内部

    @staticmethod
    def _table(kb_id: str) -> str:
        if not _SAFE_ID.match(kb_id):
            raise ValueError(f"非法知识库 ID：{kb_id!r}（仅允许字母数字下划线连字符）")
        return f"{_TABLE_PREFIX}{kb_id}"

    @staticmethod
    def _declared_dim(conn, table: str) -> int | None:
        """从 sqlite_master 读分区声明的维度。

        比另建一张"分区登记表"更好：只有一处事实来源，不会与真实建表语句漂移。
        """
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
        ).fetchone()
        if row is None or not row["sql"]:
            return None
        match = _DECLARED_DIM.search(row["sql"])
        return int(match.group(1)) if match else None
