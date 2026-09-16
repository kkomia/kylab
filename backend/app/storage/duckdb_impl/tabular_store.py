"""``TabularStore`` 的 DuckDB 实现（M2 / T2.11）。

**为什么是列式库而不是又一张 SQLite 表**：见 ``storage/base.py`` 里
``TabularStore`` 的说明——按行列定位的查询、与主库物理分离。

**关于 SQL 拼接（flake8-bandit S608）**：表名与列名**不能参数化**——
SQL 的参数占位符只用于值，标识符必须拼进语句文本。所以这里的做法是
**白名单校验（``_require_safe``）+ 标识符引号转义（``_quote``）**，
并对这三条语句显式豁免 S608。把标识符也当成"拼接就是不安全"来回避，
只会逼出更绕、更容易出错的写法。

**一切列都是 VARCHAR。** 这是刻意的：推断类型会把 ``007`` 变成 ``7``、
把长数字转成科学计数法、把日期格式改掉，而这些都是**数据本身的损失**，
且用户很难发现。表格进知识库是为了能被检索和核对，不是做统计计算——
保真比类型重要。（需要类型时在查询层转，那时用户自己知道该转成什么。）
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from pathlib import Path

import duckdb

from app.storage.base import SAFE_KEY_CHARS, TabularStore

__all__ = ["DuckDbTabularStore"]

logger = logging.getLogger(__name__)

#: 行号列名。**带前缀且不可能与用户列重名**：用户的表里也可能有一列叫"行号"，
#: 撞上会让写入直接失败（或更糟——静默覆盖掉用户的数据）。
_ORDINAL = "__kylab_row"


class DuckDbTabularStore(TabularStore):
    """用一个独立的 DuckDB 文件存所有表格副本。"""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        #: 连接**延迟到第一次真正用时**才建。
        #
        # 为什么必须延迟（实测踩到）：DuckDB 一个文件只允许一个写进程，
        # 而 `build_stores()` 是"启动就建全部仓储"。于是**只要后端在跑**，
        # 任何另一个进程（`kylab-mcp` 的 stdio 模式、脚本、测试）一启动就炸在
        # `Cannot open file ... File is already open in ... python.exe`。
        # 而 stdio MCP 服务的**标准用法就是被客户端当子进程拉起**——
        # 也就是说：不延迟的话，这个功能在"后端也在跑"这个最常见的前提下根本用不了。
        #
        # 单连接仍然够用：表格副本是写入少、读取少的旁路数据，
        # 而 DuckDB 的多连接要走同样的文件锁，收益不抵复杂度。
        self._conn: duckdb.DuckDBPyConnection | None = None

    def _connection(self) -> duckdb.DuckDBPyConnection:
        """取连接，第一次调用时才真正打开文件。"""
        if self._conn is None:
            self._conn = duckdb.connect(str(self._path))
            logger.info("表格副本库就位：%s", self._path)
        return self._conn

    # ------------------------------------------------------------------ 写

    def write_table(
        self, *, table: str, columns: Sequence[str], rows: Sequence[Sequence[str]]
    ) -> int:
        _require_safe(table)
        if not columns:
            return 0

        # DROP + CREATE 而不是 CREATE OR REPLACE：后者在列数变化时报错，
        # 而"重跑时列变了"是正常情况（用户改了源文件）
        self._connection().execute(f'DROP TABLE IF EXISTS "{table}"')
        # 先建表再 INSERT，并显式声明 VARCHAR——避免 DuckDB 自己推断类型
        column_defs = ", ".join(f'{_quote(name)} VARCHAR' for name in columns)
        self._connection().execute(
            f'CREATE TABLE "{table}" ({_ORDINAL} BIGINT, {column_defs})'
        )

        if rows:
            placeholders = ", ".join("?" for _ in range(len(columns) + 1))
            payload = [
                [index, *[_text(cell) for cell in row[: len(columns)]]]
                for index, row in enumerate(rows)
            ]
            self._connection().executemany(
                f'INSERT INTO "{table}" VALUES ({placeholders})',  # noqa: S608
                payload,
            )

        return len(rows)

    def drop_table(self, table: str) -> None:
        _require_safe(table)
        self._connection().execute(f'DROP TABLE IF EXISTS "{table}"')

    # ------------------------------------------------------------------ 读

    def table_exists(self, table: str) -> bool:
        _require_safe(table)
        row = self._connection().execute(
            "SELECT 1 FROM information_schema.tables WHERE table_name = ?", [table]
        ).fetchone()
        return row is not None

    def columns(self, table: str) -> list[str]:
        _require_safe(table)
        if not self.table_exists(table):
            return []
        described = self._connection().execute(f'DESCRIBE "{table}"').fetchall()
        # 第一列是内部行号，不属于用户看到的数据
        return [row[0] for row in described if row[0] != _ORDINAL]

    def row_count(self, table: str) -> int:
        _require_safe(table)
        if not self.table_exists(table):
            return 0
        row = self._connection().execute(
            f'SELECT COUNT(*) FROM "{table}"'  # noqa: S608
        ).fetchone()
        return int(row[0]) if row else 0

    def read_rows(self, table: str, *, limit: int = 50, offset: int = 0) -> list[list[str]]:
        _require_safe(table)
        names = self.columns(table)
        if not names:
            return []
        selected = ", ".join(_quote(name) for name in names)
        # **按内部行号排序**：DuckDB 不保证无 ORDER BY 的行序，
        # 而用户说的"第 3 行"必须与源文件一致
        rows = self._connection().execute(
            f'SELECT {selected} FROM "{table}" ORDER BY {_ORDINAL} LIMIT ? OFFSET ?',  # noqa: S608
            [limit, offset],
        ).fetchall()
        return [[_text(cell) for cell in row] for row in rows]

    # ------------------------------------------------------------------ 生命周期

    def close(self) -> None:
        # 没打开过就不用关（延迟打开之后这是常态：多数进程从没碰过表格副本）
        if self._conn is not None:
            self._conn.close()
            self._conn = None


def _quote(name: str) -> str:
    """包住列名。

    列名来自用户的表头，可能含空格、中文、甚至引号。双引号里把 ``"`` 转义成 ``""``
    是 SQL 标准做法——不转义的话，一个列名叫 ``a"b`` 的表会让整条 DDL 语法出错。
    """
    return '"' + name.replace('"', '""') + '"'


def _text(value: object) -> str:
    if value is None:
        return ""
    return str(value)


def _require_safe(table: str) -> None:
    """表名白名单校验。

    表名就是 ``document_id``，而它来自上游（用户上传时生成的）。
    即便目前它只可能是 ``doc_xxx``，这里仍然显式校验：
    **表名会进 SQL 文本，不能只依赖上游的格式**——那是把安全性
    押在"别处不会变"上。``SAFE_KEY_CHARS`` 与对象存储同一套字符集。
    """
    if not table or any(char not in SAFE_KEY_CHARS for char in table):
        raise ValueError(f"非法表名：{table!r}")
