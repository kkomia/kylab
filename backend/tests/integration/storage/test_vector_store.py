"""``SqliteVectorStore`` 的行为测试（集成）。

覆盖 D4 的落地方式：维度随知识库分区、不同库各自独立、维度不符**硬失败**。
"""

import pytest

from app.storage.base import VectorDimensionMismatch
from app.storage.sqlite_impl.vector_store import SqliteVectorStore

DIM = 4


def _v(*values: float) -> list[float]:
    return list(values)


def test_partition_is_created_lazily_and_idempotently(vector_store: SqliteVectorStore) -> None:
    assert vector_store.declared_dim("kb_1") is None
    vector_store.ensure_partition("kb_1", dim=DIM)
    vector_store.ensure_partition("kb_1", dim=DIM)  # 重复调用不应报错
    assert vector_store.declared_dim("kb_1") == DIM


def test_search_returns_exact_match_first(vector_store: SqliteVectorStore) -> None:
    vector_store.ensure_partition("kb_1", dim=DIM)
    vector_store.upsert_vectors("kb_1", items=[
            ("c_near", _v(1.0, 0.0, 0.0, 0.0)),
            ("c_mid", _v(0.7, 0.7, 0.0, 0.0)),
            ("c_far", _v(0.0, 0.0, 0.0, 1.0)),
        ],
    )

    matches = vector_store.search("kb_1", query_vector=_v(1.0, 0.0, 0.0, 0.0), top_k=3)
    assert [match.chunk_id for match in matches] == ["c_near", "c_mid", "c_far"]
    assert matches[0].distance == pytest.approx(0.0, abs=1e-6)
    assert matches[0].distance <= matches[-1].distance


def test_top_k_limits_results(vector_store: SqliteVectorStore) -> None:
    vector_store.ensure_partition("kb_1", dim=DIM)
    vector_store.upsert_vectors(
        "kb_1", items=[(f"c{i}", _v(float(i), 0.0, 0.0, 0.0)) for i in range(5)]
    )
    assert len(vector_store.search("kb_1", query_vector=_v(4.0, 0, 0, 0), top_k=2)) == 2
    assert vector_store.search("kb_1", query_vector=_v(4.0, 0, 0, 0), top_k=0) == []


def test_upsert_overwrites_without_duplicating(vector_store: SqliteVectorStore) -> None:
    """vec0 不支持 INSERT OR REPLACE，实现里走的是"先删后插"。"""
    vector_store.ensure_partition("kb_1", dim=DIM)
    vector_store.upsert_vectors("kb_1", items=[("c1", _v(1, 0, 0, 0))])
    vector_store.upsert_vectors("kb_1", items=[("c1", _v(0, 1, 0, 0))])

    matches = vector_store.search("kb_1", query_vector=_v(0, 1, 0, 0), top_k=10)
    assert [match.chunk_id for match in matches] == ["c1"]  # 没有重复行


def test_delete_vectors_removes_only_given_ids(vector_store: SqliteVectorStore) -> None:
    vector_store.ensure_partition("kb_1", dim=DIM)
    vector_store.upsert_vectors("kb_1", items=[("c1", _v(1, 0, 0, 0)), ("c2", _v(0, 1, 0, 0))])

    vector_store.delete_vectors("kb_1", chunk_ids=["c1"])
    remaining = vector_store.search("kb_1", query_vector=_v(0, 1, 0, 0), top_k=10)
    assert [match.chunk_id for match in remaining] == ["c2"]
    assert vector_store.delete_vectors("kb_1", chunk_ids=[]) == 0


def test_partitions_are_isolated_per_knowledge_base(vector_store: SqliteVectorStore) -> None:
    """架构 §8.3：检索先按 kb_id 收敛范围，不同库互不串味。"""
    vector_store.ensure_partition("kb_1", dim=DIM)
    vector_store.ensure_partition("kb_2", dim=DIM)
    vector_store.upsert_vectors("kb_1", items=[("c_kb1", _v(1, 0, 0, 0))])
    vector_store.upsert_vectors("kb_2", items=[("c_kb2", _v(1, 0, 0, 0))])

    hits = vector_store.search("kb_1", query_vector=_v(1, 0, 0, 0), top_k=10)
    assert [match.chunk_id for match in hits] == ["c_kb1"]


def test_partitions_can_have_different_dimensions(vector_store: SqliteVectorStore) -> None:
    """维度随库记录的意义：换模型新建库即可，不必推倒整个 schema。"""
    vector_store.ensure_partition("kb_small", dim=4)
    vector_store.ensure_partition("kb_large", dim=1024)
    assert vector_store.declared_dim("kb_small") == 4
    assert vector_store.declared_dim("kb_large") == 1024


def test_searching_unbuilt_partition_returns_empty(vector_store: SqliteVectorStore) -> None:
    assert vector_store.search("kb_none", query_vector=_v(1, 0, 0, 0), top_k=5) == []
    assert vector_store.delete_vectors("kb_none", chunk_ids=["c1"]) == 0


def test_drop_partition_removes_vectors(vector_store: SqliteVectorStore) -> None:
    vector_store.ensure_partition("kb_1", dim=DIM)
    vector_store.upsert_vectors("kb_1", items=[("c1", _v(1, 0, 0, 0))])

    vector_store.drop_partition("kb_1")
    assert vector_store.declared_dim("kb_1") is None
    assert vector_store.search("kb_1", query_vector=_v(1, 0, 0, 0), top_k=5) == []


# --------------------------------------------------------------------- 硬失败路径


def test_ensure_partition_with_conflicting_dimension_raises(
    vector_store: SqliteVectorStore,
) -> None:
    """架构 §6.4：维度不同绝对不能混写，必须报错而不是静默截断。"""
    vector_store.ensure_partition("kb_1", dim=DIM)
    with pytest.raises(VectorDimensionMismatch, match="8 维"):
        vector_store.ensure_partition("kb_1", dim=8)


def test_upsert_with_wrong_vector_length_raises(vector_store: SqliteVectorStore) -> None:
    vector_store.ensure_partition("kb_1", dim=DIM)
    with pytest.raises(VectorDimensionMismatch):
        vector_store.upsert_vectors("kb_1", items=[("c1", _v(1, 0))])


def test_query_vector_length_must_match(vector_store: SqliteVectorStore) -> None:
    vector_store.ensure_partition("kb_1", dim=DIM)
    with pytest.raises(VectorDimensionMismatch):
        vector_store.search("kb_1", query_vector=_v(1, 0, 0), top_k=5)


def test_upsert_before_partition_creation_raises(vector_store: SqliteVectorStore) -> None:
    with pytest.raises(VectorDimensionMismatch, match="尚未建立向量分区"):
        vector_store.upsert_vectors("kb_1", items=[("c1", _v(1, 0, 0, 0))])


def test_zero_dimension_is_rejected(vector_store: SqliteVectorStore) -> None:
    with pytest.raises(ValueError):
        vector_store.ensure_partition("kb_1", dim=0)


@pytest.mark.parametrize("evil", ["kb 1", "kb;DROP TABLE chunks", "../kb", "", "kb'--"])
def test_unsafe_kb_id_is_rejected(vector_store: SqliteVectorStore, evil: str) -> None:
    """知识库 ID 会拼进表名（SQL 无法参数化表名），必须白名单校验。"""
    with pytest.raises(ValueError):
        vector_store.ensure_partition(evil, dim=DIM)
