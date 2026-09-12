"""``FullTextStore`` 的 SQLite FTS5 + jieba 实现（M1 T1.5）。

中文分词不依赖 FTS5 分词器扩展：**写入前用 jieba 切好、空格连接**存进 ``tokens`` 列，
查询时对 query 做同样处理。这样只用标准 FTS5 就能拿到可用的中文召回，不引入 C 扩展编译。

两处刻意的取舍：

- 查询词之间用 ``OR`` 连接而不是 ``AND``：召回优先，精度交给 RRF 融合与可选 rerank（架构 §5）；
- ``score`` 统一取 ``-bm25``，即**分数越大越相关**，与向量侧的"距离越小越近"在融合层拉齐。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Sequence

import jieba

from app.storage.base import ChunkRecord, FullTextStore, SearchHit
from app.storage.sqlite_impl.connection import Database

logger = logging.getLogger(__name__)

_SPACE = " "
DEFAULT_SLOW_QUERY_MS = 500
"""超过该耗时的查询留一条 WARNING（架构 §12 可观测性）。构造时可覆盖，便于测试。"""


def tokenize(text: str) -> str:
    """切词并空格连接；过滤纯空白，避免产生无意义的 FTS 词元。"""
    return _SPACE.join(word for word in jieba.cut_for_search(text) if word.strip())


def _to_match_query(text: str) -> str:
    """把用户输入转成 FTS5 MATCH 表达式：词元加引号防止语法字符（如 ``*``、``:``）报错。"""
    tokens = [word for word in jieba.cut_for_search(text) if word.strip()]
    if not tokens:
        return ""
    return " OR ".join(f'"{token}"' for token in tokens)


class SqliteFullTextStore(FullTextStore):
    """全文检索的 SQLite 实现。"""

    def __init__(self, database: Database, *, slow_query_ms: int = DEFAULT_SLOW_QUERY_MS) -> None:
        self._db = database
        self._slow_query_ms = slow_query_ms
        self._jieba_ready = False

    def _ensure_jieba(self) -> None:
        """jieba 首次调用要加载词典（约 1 秒），预热一次后续都快。"""
        if not self._jieba_ready:
            jieba.initialize()
            self._jieba_ready = True

    # ------------------------------------------------------------------ 写入

    def index_chunks(self, chunks: Sequence[ChunkRecord]) -> None:
        if not chunks:
            return
        self._ensure_jieba()
        with self._db.session() as conn:
            # FTS5 无 ON CONFLICT，重建索引=先删后插（同一事务）
            conn.executemany(
                "DELETE FROM chunks_fts WHERE chunk_id = ?",
                [(chunk.chunk_id,) for chunk in chunks],
            )
            conn.executemany(
                "INSERT INTO chunks_fts (chunk_id, tokens) VALUES (?, ?)",
                [(chunk.chunk_id, tokenize(chunk.text)) for chunk in chunks],
            )

    def delete_chunks(self, chunk_ids: Sequence[str]) -> int:
        if not chunk_ids:
            return 0
        with self._db.session() as conn:
            cursor = conn.executemany(
                "DELETE FROM chunks_fts WHERE chunk_id = ?",
                [(chunk_id,) for chunk_id in chunk_ids],
            )
        return max(cursor.rowcount, 0)

    # ------------------------------------------------------------------ 检索

    def search(self, *, query: str, top_k: int, kb_id: str | None = None) -> list[SearchHit]:
        """全文检索。

        **JOIN documents 并要求 ``disabled = 0``**：文档级停用（v14）在 SQL 里就裁掉，
        不浪费 top_k 名额——KNN 那边做不到这一点，靠下游过滤 + 超采弥补（见
        ``retrieval/service.py`` 的向量通道），两边必须一起改才不会出现
        "全文搜不到、向量搜得到"的静默不一致。
        """
        if top_k <= 0:
            return []
        self._ensure_jieba()
        match_query = _to_match_query(query)
        if not match_query:
            return []

        started = time.perf_counter()
        sql = [
            "SELECT f.chunk_id, c.document_id, c.knowledge_base_id, c.text, c.heading_path,",
            "       c.page, bm25(chunks_fts) AS rank",
            "  FROM chunks_fts AS f",
            "  JOIN chunks AS c ON c.chunk_id = f.chunk_id",
            "  JOIN documents AS d ON d.id = c.document_id AND d.disabled = 0",
            " WHERE chunks_fts MATCH ?",
        ]
        params: list[object] = [match_query]
        if kb_id is not None:
            sql.append("   AND c.knowledge_base_id = ?")
            params.append(kb_id)
        sql.append(" ORDER BY rank LIMIT ?")
        params.append(top_k)

        with self._db.read() as conn:
            rows = conn.execute("\n".join(sql), params).fetchall()
            images = self._images_by_chunk(conn, [row["chunk_id"] for row in rows])
        elapsed_ms = (time.perf_counter() - started) * 1000
        if elapsed_ms > self._slow_query_ms:
            logger.warning("全文检索慢查询 %.0fms：%r", elapsed_ms, query)

        return [
            SearchHit(
                chunk_id=row["chunk_id"],
                document_id=row["document_id"],
                knowledge_base_id=row["knowledge_base_id"],
                text=row["text"],
                score=-float(row["rank"]),  # bm25 越小越相关，取负让"分越高越相关"
                source="fulltext",
                page=row["page"],
                heading_path=row["heading_path"],
                image_ids=tuple(images.get(row["chunk_id"], ())),
            )
            for row in rows
        ]

    @staticmethod
    def _images_by_chunk(conn, chunk_ids: Sequence[str]) -> dict[str, list[str]]:
        if not chunk_ids:
            return {}
        placeholders = ",".join("?" * len(chunk_ids))

        rows = conn.execute(
            "SELECT chunk_id, image_id FROM chunk_images "  # noqa: S608
            f"WHERE chunk_id IN ({placeholders})",
            list(chunk_ids),
        ).fetchall()
        grouped: dict[str, list[str]] = {}
        for row in rows:
            grouped.setdefault(row["chunk_id"], []).append(row["image_id"])
        return grouped
