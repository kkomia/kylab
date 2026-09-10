"""RRF 融合与相似度换算的单元测试。

镜像同构：``app/services/retrieval/{fusion,service}.py``
→ ``tests/unit/services/retrieval/test_fusion.py``。
"""

import pytest

from app.services.retrieval.fusion import DEFAULT_RRF_K, rrf_fuse, take_top
from app.services.retrieval.service import similarity_from_distance


def test_default_k_matches_rrf_paper() -> None:
    assert DEFAULT_RRF_K == 60


def test_single_channel_preserves_order() -> None:
    fused = rrf_fuse([("vector", ["a", "b", "c"])])
    assert [chunk_id for chunk_id, _, _, _ in fused] == ["a", "b", "c"]


def test_document_in_both_channels_outranks_single_channel_hits() -> None:
    """RRF 的核心价值：两路都认可的条目应当排到前面。"""
    fused = rrf_fuse(
        [
            ("vector", ["a", "b", "c"]),
            ("fulltext", ["c", "d"]),
        ]
    )
    assert fused[0][0] == "c"  # 向量第 3 + 全文第 1，胜过只在一路出现的 a


def test_scores_follow_the_formula() -> None:
    fused = rrf_fuse([("vector", ["a"])], k=60)
    assert fused[0][1] == pytest.approx(1 / 61)


def test_ranks_and_channels_are_recorded() -> None:
    """调试台要显示"这条是怎么被捞上来的"。"""
    fused = rrf_fuse([("vector", ["a", "b"]), ("fulltext", ["b"])])
    entry = next(item for item in fused if item[0] == "b")

    _, _, channels, ranks = entry
    assert set(channels) == {"vector", "fulltext"}
    assert ranks == {"vector": 2, "fulltext": 1}


def test_ties_are_broken_deterministically() -> None:
    """同分时按 chunk_id 升序，保证结果可复现（否则测试会间歇性失败）。"""
    fused = rrf_fuse([("vector", ["b", "a"])])
    assert [chunk_id for chunk_id, _, _, _ in fused] == ["b", "a"]

    tied = rrf_fuse([("vector", ["z"]), ("fulltext", ["a"])])
    assert [chunk_id for chunk_id, _, _, _ in tied] == ["a", "z"]


def test_larger_k_flattens_head_differences() -> None:
    """k 越大，头部名次之间的分差越小——这是"民主化"程度的旋钮。"""
    sharp = rrf_fuse([("vector", ["a", "b"])], k=0)
    flat = rrf_fuse([("vector", ["a", "b"])], k=1000)

    sharp_gap = sharp[0][1] - sharp[1][1]
    flat_gap = flat[0][1] - flat[1][1]
    assert sharp_gap > flat_gap


def test_empty_channels_yield_nothing() -> None:
    assert rrf_fuse([]) == []
    assert rrf_fuse([("vector", [])]) == []


def test_negative_k_is_rejected() -> None:
    with pytest.raises(ValueError):
        rrf_fuse([("vector", ["a"])], k=-1)


def test_take_top_truncates() -> None:
    fused = rrf_fuse([("vector", ["a", "b", "c"])])
    assert len(take_top(fused, 2)) == 2
    assert take_top(fused, 0) == []
    assert len(take_top(fused, -1)) == 0


# --------------------------------------------------------------------- 相似度换算


def test_zero_distance_means_full_similarity() -> None:
    assert similarity_from_distance(0.0) == pytest.approx(1.0)


def test_similarity_decreases_with_distance() -> None:
    assert similarity_from_distance(0.5) > similarity_from_distance(1.0)


def test_orthogonal_vectors_give_zero_similarity() -> None:
    """归一化向量的 L2 距离为 √2 时夹角 90°，余弦相似度应为 0。"""
    assert similarity_from_distance(2**0.5) == pytest.approx(0.0, abs=1e-9)


def test_similarity_is_clamped_to_valid_range() -> None:
    assert similarity_from_distance(10.0) == -1.0
