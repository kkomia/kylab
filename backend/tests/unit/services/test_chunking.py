"""切分器的单元测试。

镜像同构：``app/services/chunking.py`` → ``tests/unit/services/test_chunking.py``。
"""

import pytest

from app.services.chunking import ChunkingConfig, chunk_markdown, content_hash_of

DOC = "doc_1"
KB = "kb_1"


def _chunk(markdown: str, **kwargs):
    return chunk_markdown(markdown, document_id=DOC, knowledge_base_id=KB, **kwargs)


# --------------------------------------------------------------------- 配置校验


def test_default_config_matches_architecture() -> None:
    config = ChunkingConfig()
    assert (config.size, config.overlap) == (512, 64)


@pytest.mark.parametrize(
    "kwargs", [{"size": 0}, {"size": -1}, {"overlap": -1}, {"size": 100, "overlap": 100}]
)
def test_invalid_config_is_rejected(kwargs: dict) -> None:
    with pytest.raises(ValueError):
        ChunkingConfig(**kwargs)


# --------------------------------------------------------------------- 基本切分


def test_empty_markdown_produces_no_chunks() -> None:
    assert _chunk("") == []
    assert _chunk("   \n\n  ") == []


def test_single_short_paragraph_is_one_chunk() -> None:
    chunks = _chunk("只有一段话。")
    assert len(chunks) == 1
    assert chunks[0].text == "只有一段话。"
    assert chunks[0].ordinal == 0


def test_ordinals_are_continuous_and_ordered() -> None:
    markdown = "\n\n".join(f"第{i}段内容。" * 20 for i in range(6))
    chunks = _chunk(markdown, config=ChunkingConfig(size=120, overlap=20))

    assert len(chunks) > 1
    assert [chunk.ordinal for chunk in chunks] == list(range(len(chunks)))
    assert all(len(chunk.text) <= 120 for chunk in chunks)


def test_chunks_respect_size_limit() -> None:
    """一个超长段落必须被硬切成不超过块长的片段。"""
    long_text = "甲" * 1000
    chunks = _chunk(long_text, config=ChunkingConfig(size=100, overlap=10))
    assert all(len(chunk.text) <= 100 for chunk in chunks)
    assert len(chunks) > 5


def test_overlap_carries_context_across_chunks() -> None:
    """重叠的意义：跨块语义不被切断，所以相邻块应有重复内容。"""
    long_text = "".join(f"{i:04d}" for i in range(200))  # 800 字符
    chunks = _chunk(long_text, config=ChunkingConfig(size=100, overlap=20))

    first, second = chunks[0].text, chunks[1].text
    assert first[-20:] in second


def test_all_whitespace_slice_is_skipped() -> None:
    """硬切时可能出现整片空白，不能产出只有空白的 chunk。"""
    text = "甲" * 10 + " " * 100 + "乙" * 10
    chunks = _chunk(text, config=ChunkingConfig(size=50, overlap=0))

    assert chunks
    assert all(chunk.text.strip() for chunk in chunks)


def test_zero_overlap_produces_disjoint_chunks() -> None:
    long_text = "".join(f"{i:04d}" for i in range(100))
    chunks = _chunk(long_text, config=ChunkingConfig(size=100, overlap=0))
    assert chunks[0].text[-4:] not in chunks[1].text


def test_whitespace_between_blocks_is_normalized() -> None:
    chunks = _chunk("第一段\n\n\n\n第二段")
    assert "\n\n\n\n" not in chunks[0].text


# --------------------------------------------------------------------- 标题路径


def test_heading_path_is_injected() -> None:
    """架构 §5.1：chunk 要带标题路径，检索结果里能看出命中的是哪一节。

    两节各自 20 字、块长 30，装不进同一块，因此每节各自成块。
    """
    markdown = f"# 第1章\n\n{'引' * 20}\n\n## 1.1 背景\n\n{'背' * 20}\n"
    chunks = _chunk(markdown, config=ChunkingConfig(size=30, overlap=0))

    paths = [chunk.heading_path for chunk in chunks]
    assert "第1章" in paths
    assert "第1章 > 1.1 背景" in paths


def test_heading_path_is_taken_from_first_block_of_a_chunk() -> None:
    """合并成一块时，路径取该块首个内容所属的标题。"""
    chunks = _chunk("# 第1章\n\n引言内容。\n\n## 1.1 背景\n\n背景内容。\n")
    assert len(chunks) == 1
    assert chunks[0].heading_path == "第1章"


def test_heading_path_resets_after_higher_level_heading() -> None:
    markdown = f"# 第一章\n\n## 小节\n\n{'甲' * 20}\n\n# 第二章\n\n{'乙' * 20}\n"
    chunks = _chunk(markdown, config=ChunkingConfig(size=30, overlap=0))

    by_text = {chunk.text: chunk.heading_path for chunk in chunks}
    assert by_text["甲" * 20] == "第一章 > 小节"
    assert by_text["乙" * 20] == "第二章"


def test_content_without_headings_has_no_path() -> None:
    chunks = _chunk("没有标题的正文。")
    assert chunks[0].heading_path is None


def test_seven_hashes_is_not_a_heading() -> None:
    """Markdown 的 ATX 标题最多 6 级；7 个 # 属于段落，不该被当成标题。"""
    chunks = _chunk("####### 不是标题\n\n内容。\n", config=ChunkingConfig(size=20, overlap=0))
    assert chunks[0].heading_path is None
    assert "#######" in chunks[0].text


# --------------------------------------------------------------------- 稳定 ID 与 hash


def test_chunk_ids_are_stable_across_runs() -> None:
    """重跑解析后 ID 不变，增量更新才能按位置对齐（架构 §6.1）。"""
    markdown = "# 标题\n\n段落一。\n\n段落二。\n"
    first = _chunk(markdown)
    second = _chunk(markdown)

    assert [chunk.chunk_id for chunk in first] == [chunk.chunk_id for chunk in second]


def test_chunk_id_encodes_document_and_ordinal() -> None:
    chunks = _chunk("段落。" * 400, config=ChunkingConfig(size=100, overlap=0))
    assert chunks[0].chunk_id == f"{DOC}#00000"
    assert chunks[1].chunk_id == f"{DOC}#00001"


def test_part_id_joins_the_chunk_id_scope() -> None:
    chunks = _chunk("内容。", part_id="part_1")
    assert chunks[0].chunk_id == f"{DOC}/part_1#00000"
    assert chunks[0].part_id == "part_1"


def test_content_hash_changes_with_content() -> None:
    assert content_hash_of("甲") != content_hash_of("乙")
    assert content_hash_of("甲") == content_hash_of("甲")


def test_content_hash_is_recorded_on_each_chunk() -> None:
    chunks = _chunk("# 标题\n\n正文。\n")
    assert all(chunk.content_hash == content_hash_of(chunk.text) for chunk in chunks)


def test_metadata_is_filled_for_every_chunk() -> None:
    chunks = _chunk("# 标题\n\n正文。\n")
    for chunk in chunks:
        assert chunk.document_id == DOC
        assert chunk.knowledge_base_id == KB
        assert tuple(chunk.image_ids) == ()
