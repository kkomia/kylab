"""检索用的中文切词（存储层共享）。

**为什么单独一个模块**：全文检索的写入与查询必须用**同一个**分词器，否则
"写入时切成 A、查询时切成 B"就是必然的召回缺失。现在有两个全文实现
（sqlite FTS5 与 pgvector 那套 tsvector），把分词放在实现里就会出现第二份副本，
迟早漂成两种切法。

**与 ``services/embedding/deterministic.py::tokenize`` 不是一回事，别合并**：
那个是哈希嵌入用的，会补中文单字并截断到 512，返回 ``list[str]``；
这里返回的是"空格连接的词元串"，直接喂给索引。用途不同，判定标准也不同。

中文分词不依赖数据库扩展：**写入前用 jieba 切好**，查询时对 query 做同样处理。
这样只用标准 FTS5 / PG 内建 tsvector 就能拿到可用的中文召回，不引入 C 扩展编译。
"""

from __future__ import annotations

import jieba

_SPACE = " "


def cut(text: str) -> list[str]:
    """切词并过滤纯空白，返回词元列表。

    ``cut_for_search`` 会额外给出长词的子词（如"向量检索"→ 向量/检索/向量检索），
    检索场景要的正是这种"宽召回"，精度交给 RRF 融合与可选 rerank。
    """
    return [word for word in jieba.cut_for_search(text) if word.strip()]


def tokenize(text: str) -> str:
    """切词并空格连接，供写入索引使用。

    大小写不归一是有意的：FTS5 的 unicode61 与 PG 的文本解析器都会对 ASCII
    做大小写折叠，两边在这一层自动一致，多写一次 lower 反而不一致（中文不受影响）。
    """
    return _SPACE.join(cut(text))
