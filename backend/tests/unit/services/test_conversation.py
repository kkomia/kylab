"""对话留存：会话与消息的读写（§11.2）。

镜像同构：``app/services/conversation.py`` → ``tests/unit/services/test_conversation.py``。

要紧的几条：标题只由首轮提问生成（改过名的不该被覆盖）、历史取最近的若干条、
引用是快照而不是重查、删除要连消息一起删（外键级联在本项目不生效）。
"""

from __future__ import annotations

import pytest

from app.core.exceptions import NotFoundError
from app.services.conversation import TITLE_MAX_CHARS, ConversationService


@pytest.fixture
def service(bundle) -> ConversationService:  # type: ignore[no-untyped-def]
    return ConversationService(bundle)


def test_create_and_get_roundtrip(service: ConversationService) -> None:
    created = service.create(kb_ids=["kb_1", "kb_2"])

    fetched = service.get(created.id)
    assert fetched.id == created.id
    assert list(fetched.kb_ids) == ["kb_1", "kb_2"]
    assert fetched.title == ""
    assert fetched.created_at is not None


def test_get_missing_conversation_raises(service: ConversationService) -> None:
    with pytest.raises(NotFoundError):
        service.get("conv_不存在")


def test_messages_are_returned_in_order(service: ConversationService) -> None:
    conv = service.create()
    service.append(conv.id, role="user", content="第一个问题")
    service.append(conv.id, role="assistant", content="第一个回答")
    service.append(conv.id, role="user", content="第二个问题")

    contents = [item.content for item in service.messages(conv.id)]
    assert contents == ["第一个问题", "第一个回答", "第二个问题"]


def test_message_count(service: ConversationService) -> None:
    conv = service.create()
    assert service.message_count(conv.id) == 0
    service.append(conv.id, role="user", content="q")
    assert service.message_count(conv.id) == 1


def test_sources_are_stored_as_a_snapshot(service: ConversationService) -> None:
    """引用存快照：事后重查会得到不同结果，引用编号就对不上了。"""
    conv = service.create()
    snapshot = [{"index": 1, "chunk_id": "c1", "document_id": "d1", "preview": "原文"}]

    service.append(conv.id, role="assistant", content="回答", sources=snapshot)

    stored = service.messages(conv.id)[0]
    assert [dict(item) for item in stored.sources] == snapshot


# --------------------------------------------------------------------- 标题


def test_title_comes_from_the_first_question(service: ConversationService) -> None:
    conv = service.create()
    service.append(conv.id, role="user", content="近视怎么监测眼轴")

    service.ensure_title(conv.id, "近视怎么监测眼轴")

    assert service.get(conv.id).title == "近视怎么监测眼轴"


def test_long_question_is_truncated(service: ConversationService) -> None:
    conv = service.create()
    service.ensure_title(conv.id, "问" * 100)

    assert len(service.get(conv.id).title) == TITLE_MAX_CHARS


def test_title_flattens_newlines(service: ConversationService) -> None:
    """用户可能粘一整段带换行的文本进来，标题里带换行会撑坏左栏。"""
    conv = service.create()
    service.ensure_title(conv.id, "第一行\n\n第二行")

    title = service.get(conv.id).title
    assert "\n" not in title
    assert title == "第一行 第二行"


def test_ensure_title_does_not_overwrite_a_manual_name(service: ConversationService) -> None:
    """**改过名字的会话不该被后续提问覆盖。**

    否则用户整理好的标题会在下一轮对话里被冲掉——而标题正是他用来找回这次对话的东西。
    """
    conv = service.create()
    service.rename(conv.id, "我自己的名字")

    service.ensure_title(conv.id, "新的提问内容")

    assert service.get(conv.id).title == "我自己的名字"


def test_rename_rejects_blank(service: ConversationService) -> None:
    conv = service.create()
    with pytest.raises(ValueError):
        service.rename(conv.id, "   ")


# --------------------------------------------------------------------- 历史


def test_history_returns_recent_messages(service: ConversationService) -> None:
    conv = service.create()
    for index in range(10):
        service.append(conv.id, role="user", content=f"q{index}")

    history = service.history(conv.id, turns=3)

    assert [item.content for item in history] == ["q7", "q8", "q9"]


def test_history_skips_empty_messages(service: ConversationService) -> None:
    """空的助手消息不进历史——模型看到空的上一轮会更离谱。"""
    conv = service.create()
    service.append(conv.id, role="user", content="问题")
    service.append(conv.id, role="assistant", content="   ")

    history = service.history(conv.id)

    assert [item.content for item in history] == ["问题"]


def test_history_of_empty_conversation_is_empty(service: ConversationService) -> None:
    conv = service.create()
    assert service.history(conv.id) == []


# --------------------------------------------------------------------- 删除


def test_delete_removes_messages_too(service: ConversationService) -> None:
    """**外键级联在本项目不生效**（连接没开 PRAGMA foreign_keys），
    所以删除必须显式清消息，否则会留下一堆孤儿行。
    """
    conv = service.create()
    service.append(conv.id, role="user", content="q")
    service.append(conv.id, role="assistant", content="a")

    service.delete(conv.id)

    with pytest.raises(NotFoundError):
        service.get(conv.id)
    # 直接从存储层查：消息应当一条不剩
    assert service._stores.meta.list_messages(conv.id) == []


# --------------------------------------------------------------------- 列表


def test_list_orders_by_recent_activity(service: ConversationService) -> None:
    first = service.create()
    second = service.create()
    # 让第一个成为"最近聊过"的
    service.append(first.id, role="user", content="q")

    ids = [item.id for item in service.list()]
    assert ids.index(first.id) < ids.index(second.id)


def test_rename_does_not_reorder_the_list(service: ConversationService) -> None:
    """改名不推 updated_at。

    否则用户整理一遍标题，排序就按"改标题的时间"而不是"对话发生的时间"——
    而他想按后者找。
    """
    first = service.create()
    second = service.create()
    service.append(second.id, role="user", content="q")  # second 更新

    service.rename(first.id, "改个名字")

    ids = [item.id for item in service.list()]
    assert ids.index(second.id) < ids.index(first.id)


def test_list_limit(service: ConversationService) -> None:
    for _ in range(5):
        service.create()
    assert len(service.list(limit=2)) == 2


# --------------------------------------------------------------------- 会话级对话模型（v12）


def test_conversation_remembers_the_chosen_model(service: ConversationService) -> None:
    conv = service.create(kb_ids=["kb_1"], model_pk="mdl_a")
    assert service.get(conv.id).model_pk == "mdl_a"


def test_conversation_model_defaults_to_none(service: ConversationService) -> None:
    """没显式选就是 None（跟随全局默认），不是某个被猜出来的模型。"""
    conv = service.create()
    assert service.get(conv.id).model_pk is None


def test_set_model_switches_and_clears(service: ConversationService) -> None:
    conv = service.create(model_pk="mdl_a")

    service.set_model(conv.id, "mdl_b")
    assert service.get(conv.id).model_pk == "mdl_b"

    service.set_model(conv.id, None)
    assert service.get(conv.id).model_pk is None


def test_set_model_does_not_touch_updated_at(service: ConversationService) -> None:
    """切模型不算"发生了对话"：不该把会话顶到"最近活动"最前面。"""
    conv = service.create()
    before = service.get(conv.id).updated_at

    service.set_model(conv.id, "mdl_a")

    assert service.get(conv.id).updated_at == before
