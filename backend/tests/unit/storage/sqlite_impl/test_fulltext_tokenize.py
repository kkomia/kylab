"""中文分词与 MATCH 表达式构造的单元测试。

镜像同构：``app/storage/sqlite_impl/fulltext_store.py``
→ ``tests/unit/storage/sqlite_impl/test_fulltext_tokenize.py``。
"""

from app.storage.sqlite_impl.fulltext_store import _to_match_query, tokenize


def test_tokenize_splits_chinese_into_words() -> None:
    tokens = tokenize("知识库检索服务").split()
    assert "检索" in tokens
    assert all(token.strip() for token in tokens)


def test_tokenize_keeps_latin_words() -> None:
    tokens = tokenize("使用 sqlite-vec 做向量检索").split()
    assert any("sqlite" in token.lower() for token in tokens)


def test_tokenize_drops_blank_tokens() -> None:
    assert tokenize("   \n\t  ") == ""


def test_match_query_quotes_each_token() -> None:
    """原文里的 FTS5 语法字符（* : " 括号）必须被引号包住，否则 MATCH 会直接报错。"""
    query = _to_match_query('C++ 与 "向量" (检索)*')
    assert query
    assert all(part.startswith('"') and part.endswith('"') for part in query.split(" OR "))
    assert "*" not in query.replace('"*"', "")


def test_match_query_uses_or_for_recall() -> None:
    """召回优先：任一词命中即返回，精度交给 RRF 融合与 rerank。"""
    assert " OR " in _to_match_query("向量 检索 服务")


def test_match_query_on_blank_input_returns_empty() -> None:
    assert _to_match_query("   ") == ""
