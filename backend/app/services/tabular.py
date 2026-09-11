"""表格数据：结构化副本与检索用文本（M2 / T2.11）。

**为什么表格要单独处理**：CSV/Excel 走纯文本直通时会被当成一坨文本切块，
于是"张三的年龄是多少"这类问题只能靠关键词撞运气——**表的结构信息（哪一列是什么）
在切块时就丢了**。

T2.11 的做法是**双写**：

- **行文本进向量库**：每行渲染成可读文本，成为可检索的块；
- **结构化副本进 DuckDB**：原始行列原样保留，供精确查询与导出。

**关于 D5（SQL 旁路是否进 MVP）**——计划里记的是"架构说缓做，但 T2.11 要写结构化副本"，
两者其实不矛盾，本模块按这个区分落地：

- **结构化副本进 MVP**（T2.11 明文要求）：它是入库时的顺手产物，几乎零成本；
- **完整的 SQL 旁路不进 MVP**（架构 §5.2 的"缓做"）：不提供用户自定义 SQL 的开放入口；
- 但**提供一条受控的只读查询**（`query_rows`）——因为"写进 DuckDB 却查不到"
  等于没写；而受控查询的代价仅是白名单校验，不是一整套 SQL 服务。

于是 D5 消解为：**副本写、查询受控、开放 SQL 旁路仍缓做**。

**格式解析已搬到 `app/parsers/tabular_format.py`**（v0.12 review 的分层修正）：
那几个纯函数（解码 / 解析行列 / 渲染检索文本）同时被 `parsers/tabular.py` 与
`parsers/plain_text.py` 需要，留在这里会让解析器反向 import 业务层。
本模块保留 `TabularService`（编排：解析 + 写结构化副本），
并从新位置**重新导出**那些名字，既有调用点无需改动。
"""

from __future__ import annotations

import logging

from app.core.exceptions import InvalidRequestError
from app.parsers.tabular_format import (
    MAX_COLUMNS,
    MAX_ROWS,
    TABULAR_EXTENSIONS,
    TabularParse,
    parse_tabular,
    rows_to_text,
)
from app.storage.base import StoreBundle

__all__ = [
    "MAX_COLUMNS",
    "MAX_ROWS",
    "TABULAR_EXTENSIONS",
    "TabularParse",
    "TabularService",
    "parse_tabular",
    "rows_to_text",
]

logger = logging.getLogger(__name__)


class TabularService:
    """读表格、渲染检索文本、写结构化副本。"""

    def __init__(self, stores: StoreBundle) -> None:
        self._stores = stores

    # ------------------------------------------------------------------ 读

    def parse(self, *, filename: str, content: bytes) -> TabularParse:
        """把上传的表格文件读成行列（转发到解析器层的纯函数，见其说明）。"""
        return parse_tabular(filename=filename, content=content)

    # ------------------------------------------------------------------ 写

    def store(self, *, document_id: str, parsed: TabularParse) -> int:
        """把结构化副本写进 DuckDB，返回写入行数。

        表名用 ``document_id``：一份文档一张表，互不干扰，删文档时也容易连带清理。
        """
        if not parsed.rows:
            return 0
        return self._stores.tabular.write_table(
            table=document_id, columns=parsed.columns, rows=parsed.rows
        )

    def drop(self, *, document_id: str) -> None:
        """删掉一份文档的结构化副本（删文档时调用）。"""
        self._stores.tabular.drop_table(document_id)

    # ------------------------------------------------------------------ 查询

    def query_rows(
        self, *, document_id: str, limit: int = 50, offset: int = 0
    ) -> dict[str, object]:
        """读一份文档的结构化副本。

        **这是"受控查询"，不是 SQL 旁路**：调用方给的是文档 id + 分页参数，
        不是 SQL。架构 §5.2 把开放 SQL 列为缓做，这里遵守；
        但"写进 DuckDB 却查不到"等于没写，所以留这一条只读通路。
        """
        table = document_id
        if not self._stores.tabular.table_exists(table):
            raise InvalidRequestError(
                "这份文档没有结构化副本（只有 CSV/Excel 才会生成）。"
                "它可能是 PDF、Markdown 等非表格文档"
            )
        safe_limit = max(1, min(500, limit))
        return {
            "document_id": document_id,
            "columns": self._stores.tabular.columns(table),
            "rows": self._stores.tabular.read_rows(table, limit=safe_limit, offset=max(0, offset)),
            "total": self._stores.tabular.row_count(table),
        }
