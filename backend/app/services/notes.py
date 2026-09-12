"""笔记（v20，对标腾讯 ima「笔记」的最小可用版）。

定位：**轻编辑器 + AI 写作 + 知识库联动**三件事，不是一个独立的笔记软件。
kylab 已有知识库、对话（SSE 流式）、摄入流水线三大底座，这里补上缺的那一小块：

1. **笔记 CRUD**：Markdown 是唯一事实源（``content_md``），编辑器只负责渲染与编辑；
2. **加入知识库**：把笔记当成一份 ``text/markdown`` 文档走**现有摄入流水线**——
   切块、嵌入、检索全部复用，入库后回填 ``kb_id``/``doc_id``，检索命中可跳回笔记；
3. **问答存为笔记**：前端把一轮问答写成 ``source_kind='chat'`` 的笔记，本层不特殊处理。

**刻意不做**（与本产品"单机零依赖"的定位冲突，调研报告 §1 已明确）：
协作编辑（CRDT/Yjs）、云端多端同步、模板市场、语音听记。

搜索用 ``LIKE`` 子串匹配而不是 FTS5：笔记是个人规模的数据，子串对中文天然可用，
也没有"改了正文忘了同步索引"这类只在几周后才暴露的静默故障（见 meta_store 的说明）。
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from app.core.exceptions import InvalidRequestError, NotFoundError
from app.storage.base import NoteRecord, StoreBundle

__all__ = ["MAX_TAGS", "MAX_TAG_CHARS", "NotesService", "normalize_tags"]

logger = logging.getLogger(__name__)

#: 标题上限：与"自动标题"同一个量级，够认出是哪一条即可。
NOTE_TITLE_MAX_CHARS = 80
#: 每条笔记最多几个标签、单个标签多长。标签是"顺手贴的分类"，不是分类体系。
MAX_TAGS = 8
MAX_TAG_CHARS = 24
#: 允许的来源类型。``manual`` 手记 / ``chat`` 问答存为 / ``clip`` 剪藏。
SOURCE_KINDS = frozenset({"manual", "chat", "clip"})


def normalize_tags(tags: list[str] | None) -> list[str]:
    """清洗标签：去空白、去重、限长限量，保持用户给的顺序。"""
    out: list[str] = []
    for raw in tags or []:
        tag = (raw or "").strip()[:MAX_TAG_CHARS]
        if tag and tag not in out:
            out.append(tag)
        if len(out) >= MAX_TAGS:
            break
    return out


def derive_title(content_md: str) -> str:
    """没有标题时从正文首行提取：取第一个非空行，去掉 Markdown 记号。

    比"未命名笔记"好认——列表里满屏"未命名"等于没有标题。
    """
    for line in content_md.splitlines():
        text = line.strip().lstrip("#").strip().strip("*_> ").strip()
        if text:
            return text[:NOTE_TITLE_MAX_CHARS]
    return ""


class NotesService:
    """笔记的读写与入库。"""

    def __init__(self, stores: StoreBundle, *, ingest=None, documents=None) -> None:  # type: ignore[no-untyped-def]
        self._stores = stores
        # 入库是可选能力：不接摄入流水线时笔记功能照常（列表、编辑、删除）。
        # 这样单测与不配模型的部署也能用。
        self._ingest = ingest
        self._documents = documents

    # ------------------------------------------------------------------ 写

    def create(
        self,
        *,
        user_id: str | None,
        title: str = "",
        content_md: str = "",
        source_kind: str = "manual",
        source_ref: str | None = None,
        tags: list[str] | None = None,
    ) -> NoteRecord:
        kind = source_kind if source_kind in SOURCE_KINDS else "manual"
        body = content_md or ""
        clean_title = title.strip()[:NOTE_TITLE_MAX_CHARS] or derive_title(body)
        return self._stores.meta.create_note(
            NoteRecord(
                id=f"note_{uuid.uuid4().hex[:12]}",
                user_id=user_id,
                title=clean_title,
                content_md=body,
                source_kind=kind,
                source_ref=source_ref,
                tags=normalize_tags(tags),
            )
        )

    def update(
        self,
        note_id: str,
        *,
        user_id: str | None,
        title: str | None = None,
        content_md: str | None = None,
        pinned: bool | None = None,
        tags: list[str] | None = None,
    ) -> NoteRecord:
        record = self.get_for_owner(note_id, user_id)
        body = record.content_md if content_md is None else content_md
        raw_title = record.title if title is None else title
        clean_title = raw_title.strip()[:NOTE_TITLE_MAX_CHARS]
        if title is None and content_md is not None and not clean_title:
            # 正文被清空后标题不必跟着清掉；但原标题为空时要重新推导
            clean_title = derive_title(body)
        self._stores.meta.update_note(
            note_id,
            title=clean_title,
            content_md=body,
            pinned=record.pinned if pinned is None else pinned,
            updated_at=datetime.now(UTC),
            tags=None if tags is None else normalize_tags(tags),
        )
        return self.get(note_id)

    def delete(self, note_id: str, *, user_id: str | None) -> None:
        self.get_for_owner(note_id, user_id)
        self._stores.meta.delete_note(note_id)

    def attach_to_kb(self, note_id: str, *, user_id: str | None, kb_id: str) -> NoteRecord:
        """把笔记作为一份 Markdown 文档加入知识库（走现有摄入流水线）。

        **内容哈希去重会生效**：同一份内容重复入库时 ``submit`` 返回已有文档，
        这里仍把 ``doc_id`` 回填到笔记上——用户要的是"这条笔记能在库里被检索到"，
        而不是"库里再多一份副本"。
        """
        if self._ingest is None or self._documents is None:
            raise InvalidRequestError("当前部署未接入摄入流水线，无法把笔记加入知识库")
        record = self.get_for_owner(note_id, user_id)
        body = record.content_md.strip()
        if not body:
            raise InvalidRequestError("笔记内容为空，无法加入知识库")
        filename = f"{record.title or '未命名笔记'}.md"
        outcome = self._ingest.submit(
            knowledge_base_id=kb_id,
            filename=filename,
            content=body.encode("utf-8"),
            mime_type="text/markdown",
            uploaded_by=user_id,
        )
        if not outcome.is_duplicate:
            self._documents.enqueue_ingest(outcome.document.id)
        self._stores.meta.attach_note_document(
            note_id, kb_id=kb_id, doc_id=outcome.document.id
        )
        return self.get(note_id)

    # ------------------------------------------------------------------ 读

    def get(self, note_id: str) -> NoteRecord:
        record = self._stores.meta.get_note(note_id)
        if record is None:
            raise NotFoundError(f"笔记不存在：{note_id}")
        return record

    def get_for_owner(self, note_id: str, user_id: str | None) -> NoteRecord:
        """成员视角取笔记：**越主即 404**，不泄露"这条笔记存在但不是你的"。

        与对话同一口径（``ConversationService.get_for_owner``）：笔记是私有数据，
        用 403 会把别人的笔记 id 变成可探测的存在性 oracle。

        ``user_id=None`` 表示**不校验归属**（管理员/API Key 通道）——与 ``list`` 的
        过滤口径一致：列表能看到就必须点得开，否则会出现"列表里有、点进去 404"
        这种自相矛盾的状态（实测踩到）。
        """
        record = self.get(note_id)
        if user_id is not None and record.user_id != user_id:
            raise NotFoundError(f"笔记不存在：{note_id}")
        return record

    def list(
        self,
        *,
        user_id: str | None,
        query: str | None = None,
        tag: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[NoteRecord], int]:
        """返回（当页笔记，过滤后的总数）。总数一次带回，省一次往返。"""
        items = self._stores.meta.list_notes(
            user_id=user_id, query=query, tag=tag, limit=limit, offset=offset
        )
        total = self._stores.meta.count_notes(user_id=user_id, query=query, tag=tag)
        return items, total

    def tags(self, *, user_id: str | None) -> list[tuple[str, int]]:
        return self._stores.meta.list_note_tags(user_id=user_id)
