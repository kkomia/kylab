"""记忆的向量那一路（``app/services/memory_index.py`` → 本文件）。

这一组要钉住的东西分两类：

1. **索引的账要算对**：只在内容真的变了时才嵌入、模型换了就整份重建、消失的块要丢
   ——这三条错了的后果都是**静默的**（账单变多、或者拿旧向量算余弦）；
2. **两路怎么合**：RRF 的公式、只有一路时的"不融合"、以及余弦下限（它是这一路唯一
   的"不引入噪声"保证——词面那条路靠覆盖率判据，这条靠下限）。

向量用假的（按文本给固定向量）：这里测的是**索引与融合的算法**，不是嵌入模型的质量
——真实模型的分离度在真跑里量过（见 ``memory_index`` 的模块说明）。
"""

from __future__ import annotations

import json
from pathlib import Path

from app.services import memory_files, memory_index

A_PATH = "digest/甲.md"
B_PATH = "digest/乙.md"


class _FakeEmbed:
    """按文本查表给向量；查不到就给一个默认向量。

    记录每一次调用（``calls``），因为这一组最要紧的断言就是**"有没有白嵌入"**。
    """

    model_id = "fake-1"
    dim = 2
    max_batch = 2

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.vectors: dict[str, list[float]] = {}

    def embed(self, texts):  # type: ignore[no-untyped-def]
        self.calls.append(list(texts))
        return [list(self.vectors.get(text, [1.0, 0.0])) for text in texts]

    @property
    def embedded_texts(self) -> list[str]:
        return [text for call in self.calls for text in call]


def _workspace(tmp_path: Path) -> Path:
    root = tmp_path / "memory"
    (root / "digest").mkdir(parents=True)
    (root / "digest" / "甲.md").write_bytes("# 甲\n\n锂价下跌压低正极材料成本。\n".encode())
    (root / "digest" / "乙.md").write_bytes("# 乙\n\n合唱团的排练安排在周四。\n".encode())
    return root


def _chunk_of(root: Path, suffix: str) -> str:
    return next(
        text
        for path, _start, _end, text in memory_files.chunks_for_index(root)
        if path.endswith(suffix)
    )


# --------------------------------------------------------------- 索引：账要算对


def test_the_index_dir_stays_in_the_skip_list() -> None:
    """索引目录**必须**在 ``memory_files._SKIP_DIRS`` 里。

    不在的话，索引自己会被当成记忆文件扫进来（那两个文件就在工作区里）——
    一条肉眼查不出来的坏法，所以钉成一条用例。
    """
    assert memory_index.INDEX_DIR_NAME in memory_files._SKIP_DIRS


def test_chunk_digest_follows_the_content() -> None:
    """指纹看内容：**行号或正文任一变了就变**（路径也参与，见 QwenPaw 的 chunk id）。"""
    base = memory_index.chunk_digest(A_PATH, 3, 3, "锂价下跌")
    assert base == memory_index.chunk_digest(A_PATH, 3, 3, "锂价下跌")
    assert base != memory_index.chunk_digest(A_PATH, 3, 3, "锂价上涨")
    assert base != memory_index.chunk_digest(A_PATH, 4, 4, "锂价下跌")
    assert base != memory_index.chunk_digest(B_PATH, 3, 3, "锂价下跌")


def test_sync_embeds_only_what_changed(tmp_path: Path) -> None:
    """**内容没变的块不重新嵌入**——这条错了账单会悄悄涨。"""
    root = _workspace(tmp_path)
    source = _FakeEmbed()

    first = memory_index.sync(root, source)
    assert (first["kept"], first["embedded"], first["dropped"]) == (0, 2, 0)
    assert len(source.embedded_texts) == 2

    again = memory_index.sync(root, source)
    assert (again["kept"], again["embedded"]) == (2, 0)
    assert len(source.embedded_texts) == 2, "第二次一次嵌入都不该发"

    (root / "digest" / "甲.md").write_bytes("# 甲\n\n锂价下跌压低成本，且幅度更大。\n".encode())
    memory_files._BLOCK_CACHE.clear()  # 真实情形靠 mtime 失效，这里显式清掉让用例确定

    third = memory_index.sync(root, source)
    assert (third["kept"], third["embedded"]) == (1, 1), "只有改了的那一份要重嵌"


def test_sync_drops_chunks_that_left(tmp_path: Path) -> None:
    """文件删了，它那几行也要从索引里消失（否则索引会一直涨）。"""
    root = _workspace(tmp_path)
    source = _FakeEmbed()
    memory_index.sync(root, source)

    (root / "digest" / "乙.md").unlink()
    memory_files._BLOCK_CACHE.clear()

    result = memory_index.sync(root, source)

    assert result["dropped"] == 1
    assert [row.path for row in memory_index.load(root).rows] == [A_PATH]


def test_sync_rebuilds_everything_when_the_model_changes(tmp_path: Path) -> None:
    """**换了嵌入模型就整份重建**：维度相同不等于向量空间兼容（架构 §6.4）。

    不重建的后果是拿旧模型的向量和新查询算余弦——分数看着正常，语义全是错的。
    """
    root = _workspace(tmp_path)
    first = _FakeEmbed()
    memory_index.sync(root, first)

    class _Other(_FakeEmbed):
        model_id = "fake-2"

    other = _Other()
    result = memory_index.sync(root, other)

    assert result["embedded"] == 2 and result["kept"] == 0
    assert memory_index.load(root).model_id == "fake-2"


def test_a_broken_index_reads_as_empty(tmp_path: Path) -> None:
    """索引坏了就当空的：**下次对齐会重建它**，不该让召回失败。

    半写坏的二进制是常态（断电、被 kill），所以长度对不上要能识别出来。
    """
    root = _workspace(tmp_path)
    memory_index.sync(root, _FakeEmbed())
    (root / memory_index.INDEX_DIR_NAME / memory_index.MATRIX_NAME).write_bytes(b"\x00\x01")

    index = memory_index.load(root)

    assert index.rows == () and index.matrix is None


def test_a_missing_manifest_reads_as_empty(tmp_path: Path) -> None:
    root = _workspace(tmp_path)
    assert memory_index.load(root).rows == ()


# ------------------------------------------------------------------ 两路怎么合


def _hit(path: str, start: int, score: float, *, source: str = "text"):  # type: ignore[no-untyped-def]
    return memory_files.MemoryMatch(
        text=f"{path} 的正文",
        path=path,
        start_line=start,
        end_line=start,
        score=score,
        coverage=0.5,
        source=source,
    )


def test_rrf_follows_the_formula(tmp_path: Path) -> None:
    """``Σ 权重/(k + 名次)``，照 QwenPaw：``k=60``、向量权重 0.7。"""
    lexical = [_hit(A_PATH, 1, 9.0), _hit(B_PATH, 1, 8.0)]
    vector = [
        (_hit(B_PATH, 1, 0.9, source="vector"), 0.9),
        (_hit(A_PATH, 1, 0.8, source="vector"), 0.8),
    ]

    fused = memory_index.rrf_fuse(lexical, vector)

    by_path = {hit.path: hit for hit in fused}
    text_weight = 1.0 - memory_index.VECTOR_WEIGHT
    expected_a = (
        text_weight / (memory_index.RRF_K + 1)
        + memory_index.VECTOR_WEIGHT / (memory_index.RRF_K + 2)
    ) * memory_index.RRF_SCALE
    expected_b = (
        text_weight / (memory_index.RRF_K + 2)
        + memory_index.VECTOR_WEIGHT / (memory_index.RRF_K + 1)
    ) * memory_index.RRF_SCALE
    assert by_path[A_PATH].score == expected_a
    assert by_path[B_PATH].score == expected_b
    # 两路都命中的那条排第一（B 在两边都更靠前）
    assert [hit.path for hit in fused] == [B_PATH, A_PATH]
    assert {hit.source for hit in fused} == {"both"}


def test_rrf_keeps_both_rankings_visible() -> None:
    """只在词面那一路、或只在语义那一路的命中都要留着，并且标出来源。"""
    lexical = [_hit(A_PATH, 1, 9.0)]
    vector = [(_hit(B_PATH, 1, 0.9, source="vector"), 0.9)]

    fused = memory_index.rrf_fuse(lexical, vector)

    sources = {hit.path: hit.source for hit in fused}
    assert sources == {A_PATH: "text", B_PATH: "vector"}


def test_search_hybrid_marks_a_chunk_found_by_both_routes(tmp_path: Path) -> None:
    """两路都命中的那条标 ``both``——**只在两路都非空时才融合**。"""
    root = _workspace(tmp_path)
    source = _FakeEmbed()
    source.vectors[_chunk_of(root, "甲.md")] = [1.0, 0.0]
    source.vectors[_chunk_of(root, "乙.md")] = [0.0, 1.0]
    source.vectors["锂价下跌"] = [1.0, 0.0]
    memory_index.sync(root, source)

    hits = memory_index.search_hybrid(root, "锂价下跌", source=source, limit=5, min_score=0.45)

    assert hits, "词面那一路本来就该找到它"
    assert hits[0].path == A_PATH
    assert hits[0].source == "both", "两路都命中"


def test_a_hit_below_the_floor_is_not_returned(tmp_path: Path) -> None:
    """**余弦下限是这一路唯一的判据**：低于它的不召回。

    没有下限，任何查询都会返回"最像的几条"——包括噪声查询，而那会把
    "没召回任何东西 = 这几份记忆里确实没有相关的话"这条性质毁掉。
    """
    root = _workspace(tmp_path)
    source = _FakeEmbed()
    source.vectors[_chunk_of(root, "甲.md")] = [1.0, 0.0]
    source.vectors[_chunk_of(root, "乙.md")] = [0.0, 1.0]
    # 查询与甲 的余弦是 1.0、与乙 是 0.0；那条只跟乙沾边的查询用 [0.2, 1.0]
    memory_index.sync(root, source)

    rejected = memory_index.search_hybrid(
        root, "排练安排", source=source, limit=5, min_score=0.9
    )

    assert all(hit.path != B_PATH or hit.source != "vector" for hit in rejected), (
        "余弦 0.196 低于 0.9 时不该从语义那一路进来（词面那一路照样算它的）"
    )

    source.vectors["排练安排"] = [0.0, 1.0]
    accepted = memory_index.search_hybrid(
        root, "排练安排", source=source, limit=5, min_score=0.9
    )

    assert any(hit.path == B_PATH for hit in accepted)


def test_a_stale_row_is_never_returned(tmp_path: Path) -> None:
    """索引落后一轮时，**只少召回，不召回一个已经不存在的东西**。

    查询时按"当前确实存在的块"过滤：文件改短了/删了之后，索引里那行还在，
    但那块已经对不上了——它必须被丢掉。
    """
    root = _workspace(tmp_path)
    source = _FakeEmbed()
    source.vectors["锂价下跌"] = [1.0, 0.0]
    memory_index.sync(root, source)
    assert len(memory_index.load(root).rows) == 2

    # 把甲删掉（**不重新对齐索引**，模拟"索引落后一轮"）
    (root / "digest" / "甲.md").unlink()
    memory_files._BLOCK_CACHE.clear()

    hits = memory_index.search_hybrid(root, "锂价下跌", source=source, limit=5, min_score=0.45)

    assert all(hit.path != A_PATH for hit in hits), "那一块已经不存在了"


def test_the_index_manifest_is_readable_json(tmp_path: Path) -> None:
    """索引是**派生物**：写得出来、读得回去，人也能打开看一眼（排障要用）。"""
    root = _workspace(tmp_path)
    memory_index.sync(root, _FakeEmbed())

    manifest = json.loads(
        (root / memory_index.INDEX_DIR_NAME / memory_index.MANIFEST_NAME).read_text(
            encoding="utf-8"
        )
    )

    assert manifest["model_id"] == "fake-1"
    assert manifest["dim"] == 2
    # 顺序不是契约（扫目录的顺序不属于承诺），要断言的是"两份都在"
    assert sorted(row["path"] for row in manifest["rows"]) == sorted([A_PATH, B_PATH])
