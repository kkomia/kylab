"""切分器（M2 T2.8）。

三种模式（架构 §5.1）：**固定长度 / 语义切块 / 父子切块**。本模块实现固定长度，
另外两种按计划在 M2 后段补齐。

两个与架构承诺直接相关的细节：

- **标题路径注入**：chunk 记录 ``第3章 > 3.2节`` 形式的 ``heading_path``，检索结果里能看出
  命中的是哪一节；
- **稳定 ID + 内容 hash**：``chunk_id`` 由文档与序号推出（可复现），``content_hash`` 用于
  增量更新时对齐新旧序列（架构 §6.1）。
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from app.storage.base import ChunkRecord

__all__ = ["ChunkingConfig", "chunk_markdown", "content_hash_of"]


#: 大文件切分器插入的页标记（`splitting.PAGE_MARKER_TEMPLATE` 的读取侧）。
#:
#: 与 `splitting.py` 是**一对**：那边写、这边读。改格式要同时改两处，
#: 而且 `test_splitting.py` / `test_chunking.py` 各有一条断言钉住这对格式，
#: 所以只改一边会被测试挡下来。
_PAGE_MARKER = re.compile(r"^<!--\s*page:(\d+)\s*-->$")

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
"""ATX 标题最多 6 级：7 个 ``#`` 在 Markdown 里就不是标题，而是普通段落。"""
DEFAULT_CHUNK_SIZE = 512
DEFAULT_OVERLAP = 64


@dataclass(frozen=True, slots=True)
class ChunkingConfig:
    """切分参数。默认值来自架构 §5.1 的"固定长度"模式。"""

    size: int = DEFAULT_CHUNK_SIZE
    overlap: int = DEFAULT_OVERLAP

    def __post_init__(self) -> None:
        if self.size <= 0:
            raise ValueError("块长必须为正整数")
        if self.overlap < 0:
            raise ValueError("重叠长度不能为负")
        if self.overlap >= self.size:
            raise ValueError("重叠长度必须小于块长，否则切分会原地打转")


def content_hash_of(text: str) -> str:
    """内容 hash：增量更新时用它判断某个位置的 chunk 是否变化（架构 §6.1）。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


def chunk_markdown(
    markdown: str,
    *,
    document_id: str,
    knowledge_base_id: str,
    config: ChunkingConfig | None = None,
    part_id: str | None = None,
) -> list[ChunkRecord]:
    """把 Markdown 切成 chunk 序列。

    先按标题与空行切成"块"，再把块贪心装进不超过 ``size`` 的桶；单块超长时按
    ``size`` 硬切并保留 ``overlap`` 字符重叠。块的标题路径取所属标题栈。

    ``size`` 是**硬上限**，重叠也算在里面：新块开头若加上重叠尾巴就放不下当前块，
    宁可放弃这一段重叠也不让任何 chunk 超限（超限会破坏下游 embedding 的批量假设）。
    """
    settings = config or ChunkingConfig()
    blocks = _split_blocks(markdown)
    chunks: list[ChunkRecord] = []

    buffer = ""
    buffer_heading: str | None = None
    buffer_page: int | None = None
    last_text = ""

    def flush() -> str:
        """把当前缓冲落成一个 chunk，返回其文本（供下一块取重叠尾巴）。"""
        nonlocal buffer, buffer_heading, buffer_page
        text = buffer.strip()
        if text:
            ordinal = len(chunks)
            chunks.append(
                ChunkRecord(
                    chunk_id=_chunk_id(document_id, part_id, ordinal),
                    document_id=document_id,
                    knowledge_base_id=knowledge_base_id,
                    part_id=part_id,
                    ordinal=ordinal,
                    text=text,
                    content_hash=content_hash_of(text),
                    heading_path=buffer_heading,
                    page=buffer_page,
                )
            )
        buffer = ""
        buffer_heading = None
        buffer_page = None
        return text

    for text, heading, page in blocks:
        for piece in _split_oversized(text, settings):
            if buffer and len(buffer) + 1 + len(piece) > settings.size:
                last_text = flush()

            if not buffer:
                tail = _tail(last_text, settings.overlap)
                fits_with_tail = bool(tail) and len(tail) + 1 + len(piece) <= settings.size
                buffer = f"{tail}\n{piece}" if fits_with_tail else piece
                buffer_heading = heading
                buffer_page = page
            else:
                buffer = f"{buffer}\n{piece}"

    flush()
    return chunks


def _split_blocks(markdown: str) -> list[tuple[str, str | None, int | None]]:
    """按标题与空行切成块，并跟踪标题栈与**当前页码**。

    页码来自大文件切分器插入的页标记（``splitting.PAGE_MARKER_TEMPLATE``）。
    一份 1500 页的文档被切成 8 段分别解析，它们的产物是拼起来的，
    没有标记的话「这条命中在第几页」这个问题就永远答不出来——
    而引文页码是"答案可核查"的前提（架构 §5）。

    **为什么待用的页码要攒成一个列表，而不是只记"当前值"**：
    第一版把页码记在"当前值"上、遇到空行就落块，结果这样一份产物出错了：

    ```
    <!-- page:1 -->
    （空行）
    第一页正文
    （空行）          <- 落块，页码 1，正确
    <!-- page:2 -->
    （空行）          <- pending 是空的，那个待用的页码 2 被丢掉
    第二页正文        <- 拿到 None
    ```

    空行是**比页标记更强**的分块信号，而页标记与正文之间必然隔着空行
    （`merge_parts` 就是这么拼的），所以"当前值"一定会被空行冲掉。
    正确做法是让页码**等着被下一段正文用掉**，落块时取最后一个。

    **标记本身不进 chunk 正文**：它是给这里读的元数据，留在正文里会污染检索文本，
    也会让嵌入向量被一串 HTML 注释干扰。
    """
    blocks: list[tuple[str, str | None, int | None]] = []
    stack: list[tuple[int, str]] = []
    pending: list[str] = []
    # 还没被正文用掉的页标记。正常情况下最多一个；紧挨着几个标记
    # （例如空段）也不该让后面的正文彻底丢掉页码
    pages: list[int] = []

    def heading_path() -> str | None:
        return " > ".join(title for _, title in stack) if stack else None

    def flush_pending() -> None:
        text = "\n".join(pending).strip()
        pending.clear()
        if text:
            blocks.append((text, heading_path(), pages[-1] if pages else None))
            pages.clear()

    for line in markdown.splitlines():
        stripped = line.strip()
        marker = _PAGE_MARKER.match(stripped)
        if marker:
            # 页标记是**切块的硬边界**：先落掉前面积攒的内容，
            # 之后的内容属于新的一页。不在这里落的话，一块会横跨两页，
            # 而一块只能标一个页码——标错了比没有更糟
            flush_pending()
            pages.append(int(marker.group(1)))
            continue
        match = _HEADING.match(stripped)
        if match:
            flush_pending()
            level = len(match.group(1))
            title = match.group(2).strip()
            stack[:] = [(lvl, name) for lvl, name in stack if lvl < level]
            stack.append((level, title))
            continue
        if not stripped:
            flush_pending()
            continue
        pending.append(line)

    flush_pending()
    return blocks


def _split_oversized(text: str, config: ChunkingConfig) -> list[str]:
    """单块超过块长时硬切，保留重叠；否则原样返回。"""
    if len(text) <= config.size:
        return [text]

    pieces: list[str] = []
    step = config.size - config.overlap
    for start in range(0, len(text), step):
        piece = text[start : start + config.size]
        if not piece.strip():
            continue
        pieces.append(piece)
        if start + config.size >= len(text):
            break
    return pieces


def _tail(text: str, length: int) -> str:
    return text[-length:] if length > 0 else ""


def _chunk_id(document_id: str, part_id: str | None, ordinal: int) -> str:
    """稳定 ID：同一文档同一序号的 chunk 在重跑后 ID 不变，便于对齐与覆盖写。"""
    scope = f"{document_id}/{part_id}" if part_id else document_id
    return f"{scope}#{ordinal:05d}"
