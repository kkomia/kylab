"""笔记服务的单元测试（用真实 SQLite 夹具，不碰网络）。

镜像同构：``app/services/notes.py`` → ``tests/unit/services/test_notes.py``。
"""

import pytest

from app.core.exceptions import InvalidRequestError, NotFoundError
from app.services.notes import MAX_TAGS, NotesService, derive_title, normalize_tags


@pytest.fixture
def notes(bundle):  # type: ignore[no-untyped-def]
    return NotesService(bundle)


# ------------------------------------------------------------------ 纯函数


def test_derive_title_from_first_meaningful_line() -> None:
    assert derive_title("\n\n# 眼轴监测\n\n每三个月一次") == "眼轴监测"
    assert derive_title("**重点**\n后续") == "重点"
    assert derive_title("   ") == ""


def test_normalize_tags_dedupes_trims_and_limits() -> None:
    tags = normalize_tags([" 眼科 ", "", "眼科", "a" * 40, *[f"t{i}" for i in range(10)]])

    assert tags[0] == "眼科"
    assert len(tags) == MAX_TAGS
    assert len(set(tags)) == len(tags)  # 无重复
    assert all(len(tag) <= 24 for tag in tags)


# ------------------------------------------------------------------ CRUD


def test_create_fills_title_from_content_and_defaults(notes: NotesService) -> None:
    record = notes.create(
        user_id="u1", content_md="# 眼轴监测\n\n每三个月一次", tags=["眼科", "眼科"]
    )

    assert record.id.startswith("note_")
    assert record.title == "眼轴监测"
    assert record.tags == ["眼科"]
    assert record.source_kind == "manual"
    assert record.created_at is not None


def test_create_accepts_chat_source(notes: NotesService) -> None:
    record = notes.create(
        user_id="u1",
        title="问过的问题",
        content_md="回答正文",
        source_kind="chat",
        source_ref="conv_1",
    )

    assert record.source_kind == "chat"
    assert record.source_ref == "conv_1"


def test_unknown_source_kind_falls_back_to_manual(notes: NotesService) -> None:
    record = notes.create(user_id="u1", title="x", source_kind="drop")
    assert record.source_kind == "manual"


def test_get_for_owner_hides_other_peoples_notes(notes: NotesService) -> None:
    """越主即 404：403 会把别人的笔记 id 变成可探测的存在性 oracle。"""
    mine = notes.create(user_id="u1", title="我的")

    assert notes.get_for_owner(mine.id, "u1").id == mine.id
    with pytest.raises(NotFoundError):
        notes.get_for_owner(mine.id, "u2")


def test_get_for_owner_none_means_admin_see_all(notes: NotesService) -> None:
    """归属为 None（管理员/API Key 通道）不校验归属——否则"列表看得到、点进去 404"。"""
    mine = notes.create(user_id="u1", title="我的")

    assert notes.get_for_owner(mine.id, None).id == mine.id


def test_update_persists_and_replaces_tags(notes: NotesService) -> None:
    record = notes.create(user_id="u1", title="旧", content_md="旧正文", tags=["a"])
    before = record.updated_at

    updated = notes.update(
        record.id, user_id="u1", title="新", content_md="新正文", tags=["b", "c"], pinned=True
    )

    assert (updated.title, updated.content_md) == ("新", "新正文")
    assert updated.tags == ["b", "c"]
    assert updated.pinned is True
    assert updated.updated_at >= before  # type: ignore[operator]


def test_update_without_tags_keeps_existing(notes: NotesService) -> None:
    record = notes.create(user_id="u1", title="t", content_md="正文", tags=["保留"])

    updated = notes.update(record.id, user_id="u1", content_md="改了")

    assert updated.tags == ["保留"]
    assert updated.content_md == "改了"


def test_delete_removes_note_and_tags(notes: NotesService, bundle) -> None:  # type: ignore[no-untyped-def]
    record = notes.create(user_id="u1", title="t", tags=["x"])

    notes.delete(record.id, user_id="u1")

    with pytest.raises(NotFoundError):
        notes.get(record.id)
    assert bundle.meta.list_note_tags(user_id="u1") == []


def test_list_filters_sorts_and_counts(notes: NotesService) -> None:
    notes.create(user_id="u1", title="眼轴监测", content_md="每三个月一次")
    notes.create(user_id="u1", title="散瞳验光", content_md="用药后验光")
    pinned = notes.create(user_id="u1", title="置顶条目", content_md="无关内容", tags=["重点"])
    notes.update(pinned.id, user_id="u1", pinned=True)
    notes.create(user_id="u2", title="别人的", content_md="眼轴")

    items, total = notes.list(user_id="u1")

    assert total == 3
    assert items[0].id == pinned.id  # 置顶优先
    assert all(item.user_id == "u1" for item in items)

    searched, searched_total = notes.list(user_id="u1", query="眼轴")
    assert searched_total == 1 and searched[0].title == "眼轴监测"

    tagged, tagged_total = notes.list(user_id="u1", tag="重点")
    assert tagged_total == 1 and tagged[0].id == pinned.id

    # 不过滤归属（管理员通道）能看到所有人的
    _, all_total = notes.list(user_id=None)
    assert all_total == 4


def test_list_search_escapes_like_wildcards(notes: NotesService) -> None:
    """用户输入的 ``%`` 不该变成通配符——否则搜 "%" 会命中全部。"""
    notes.create(user_id="u1", title="百分之五十", content_md="占 50%")
    notes.create(user_id="u1", title="无关", content_md="什么都没有")

    items, total = notes.list(user_id="u1", query="50%")

    assert total == 1 and items[0].title == "百分之五十"


def test_tags_are_aggregated(notes: NotesService) -> None:
    notes.create(user_id="u1", title="a", tags=["眼科", "重点"])
    notes.create(user_id="u1", title="b", tags=["眼科"])

    tags = dict(notes.tags(user_id="u1"))

    assert tags == {"眼科": 2, "重点": 1}


# ------------------------------------------------------------------ 加入知识库


class _FakeIngest:
    def __init__(self, *, duplicate: bool = False) -> None:
        self.calls: list[dict] = []
        self._duplicate = duplicate

    def submit(self, **kwargs):  # type: ignore[no-untyped-def]
        self.calls.append(kwargs)
        document = type("Doc", (), {"id": "doc_1"})()
        return type("Outcome", (), {"document": document, "is_duplicate": self._duplicate})()


class _FakeDocuments:
    def __init__(self) -> None:
        self.enqueued: list[str] = []

    def enqueue_ingest(self, document_id: str, force: bool = False):  # type: ignore[no-untyped-def]
        self.enqueued.append(document_id)
        return object()


def test_attach_to_kb_submits_markdown_and_records_document(bundle) -> None:  # type: ignore[no-untyped-def]
    ingest = _FakeIngest()
    documents = _FakeDocuments()
    service = NotesService(bundle, ingest=ingest, documents=documents)
    record = service.create(user_id="u1", title="眼轴笔记", content_md="# 眼轴\n每三个月测一次")

    updated = service.attach_to_kb(record.id, user_id="u1", kb_id="kb_1")

    assert updated.kb_id == "kb_1"
    assert updated.doc_id == "doc_1"
    assert documents.enqueued == ["doc_1"]
    call = ingest.calls[0]
    assert call["knowledge_base_id"] == "kb_1"
    assert call["filename"] == "眼轴笔记.md"
    assert call["content"].decode("utf-8") == "# 眼轴\n每三个月测一次"
    assert call["mime_type"] == "text/markdown"


def test_attach_duplicate_does_not_enqueue_again_but_still_links(bundle) -> None:  # type: ignore[no-untyped-def]
    """同一份内容重复入库时返回已有文档：不重复排队，但笔记仍要指向它。"""
    ingest = _FakeIngest(duplicate=True)
    documents = _FakeDocuments()
    service = NotesService(bundle, ingest=ingest, documents=documents)
    record = service.create(user_id="u1", title="t", content_md="正文")

    updated = service.attach_to_kb(record.id, user_id="u1", kb_id="kb_1")

    assert updated.doc_id == "doc_1"
    assert documents.enqueued == []


def test_attach_rejects_empty_content(bundle) -> None:  # type: ignore[no-untyped-def]
    service = NotesService(bundle, ingest=_FakeIngest(), documents=_FakeDocuments())
    record = service.create(user_id="u1", title="空的")

    with pytest.raises(InvalidRequestError):
        service.attach_to_kb(record.id, user_id="u1", kb_id="kb_1")


def test_attach_without_pipeline_is_rejected(bundle) -> None:  # type: ignore[no-untyped-def]
    service = NotesService(bundle)
    record = service.create(user_id="u1", title="t", content_md="正文")

    with pytest.raises(InvalidRequestError):
        service.attach_to_kb(record.id, user_id="u1", kb_id="kb_1")


# ------------------------------------------------------------------ 配图


def _png() -> bytes:
    # 最小合法 PNG（1x1）；这里只关心字节进出，不关心它长什么样
    return bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
        "1f15c4890000000a49444154789c6360000002000100ffff0300000600"
        "05570a2e0000000049454e44ae426082"
    )


def test_upload_image_returns_content_addressed_name(notes: NotesService) -> None:
    record = notes.create(user_id="u1", title="带图")

    path, name = notes.upload_image(
        record.id, user_id="u1", filename="截图 2026.PNG", content=_png()
    )

    assert name.endswith(".png") and len(name) == 16 + 4  # 哈希前缀 + 后缀
    assert path.endswith(name)
    assert notes.image_bytes(record.id, name) == _png()  # 读得回来


def test_upload_image_rejects_svg_and_unknown_suffix(notes: NotesService) -> None:
    """不收 SVG：它能内嵌脚本，而图片 URL 是给 <img> 直接加载的。"""
    record = notes.create(user_id="u1", title="t")

    with pytest.raises(InvalidRequestError):
        notes.upload_image(record.id, user_id="u1", filename="x.svg", content=b"<svg/>")
    with pytest.raises(InvalidRequestError):
        notes.upload_image(record.id, user_id="u1", filename="x.exe", content=b"x")


def test_upload_image_rejects_empty_and_oversized(notes: NotesService) -> None:
    record = notes.create(user_id="u1", title="t")

    with pytest.raises(InvalidRequestError):
        notes.upload_image(record.id, user_id="u1", filename="a.png", content=b"")
    with pytest.raises(InvalidRequestError):
        notes.upload_image(
            record.id, user_id="u1", filename="a.png", content=b"x" * (11 * 1024 * 1024)
        )


def test_upload_image_hides_other_peoples_notes(notes: NotesService) -> None:
    record = notes.create(user_id="u1", title="t")

    with pytest.raises(NotFoundError):
        notes.upload_image(record.id, user_id="u2", filename="a.png", content=_png())


def test_image_bytes_rejects_path_traversal(notes: NotesService) -> None:
    record = notes.create(user_id="u1", title="t")

    for bad in ("../secret", "..", "a/b.png", ""):
        with pytest.raises(NotFoundError):
            notes.image_bytes(record.id, bad)
