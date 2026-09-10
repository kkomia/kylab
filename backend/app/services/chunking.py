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
    last_text = ""

    def flush() -> str:
        """把当前缓冲落成一个 chunk，返回其文本（供下一块取重叠尾巴）。"""
        nonlocal buffer, buffer_heading
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
                )
            )
        buffer = ""
        buffer_heading = None
        return text

    for text, heading in blocks:
        for piece in _split_oversized(text, settings):
            if buffer and len(buffer) + 1 + len(piece) > settings.size:
                last_text = flush()

            if not buffer:
                tail = _tail(last_text, settings.overlap)
                fits_with_tail = bool(tail) and len(tail) + 1 + len(piece) <= settings.size
                buffer = f"{tail}\n{piece}" if fits_with_tail else piece
                buffer_heading = heading
            else:
                buffer = f"{buffer}\n{piece}"

    flush()
    return chunks


def _split_blocks(markdown: str) -> list[tuple[str, str | None]]:
    """按标题与空行切成块，并跟踪标题栈。"""
    blocks: list[tuple[str, str | None]] = []
    stack: list[tuple[int, str]] = []
    pending: list[str] = []

    def heading_path() -> str | None:
        return " > ".join(title for _, title in stack) if stack else None

    def flush_pending() -> None:
        text = "\n".join(pending).strip()
        pending.clear()
        if text:
            blocks.append((text, heading_path()))

    for line in markdown.splitlines():
        match = _HEADING.match(line.strip())
        if match:
            flush_pending()
            level = len(match.group(1))
            title = match.group(2).strip()
            stack[:] = [(lvl, name) for lvl, name in stack if lvl < level]
            stack.append((level, title))
            continue
        if not line.strip():
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
