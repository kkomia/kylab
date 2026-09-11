"""示例问题生成（对话页空状态）。

镜像同构：``app/services/suggested_questions.py`` → 本文件。

要紧的三条：拿不到语料/生成失败都**不报错**（回退静态样例）、模型输出被保守清洗、
同一组知识库在缓存期内不重复调用（切一次库就重新生成一次太费 token）。
"""

from __future__ import annotations

from app.services.suggested_questions import (
    SuggestedQuestionsService,
    _parse_questions,
)
from app.storage.base import ChunkRecord


class FakeChat:
    """假的对话模型：只实现 ``ask_raw``，记录被调用了几次。"""

    def __init__(self, reply: str = "1. 第一个问题？\n2. 第二个问题？") -> None:
        self.reply = reply
        self.calls = 0

    def ask_raw(self, messages, *, model_pk=None):  # type: ignore[no-untyped-def]
        self.calls += 1
        return self.reply


class BoomChat:
    def ask_raw(self, messages, *, model_pk=None):  # type: ignore[no-untyped-def]
        raise RuntimeError("上游挂了")


def _seed_chunks(bundle, kb_id: str, document_id: str, count: int = 2) -> None:  # type: ignore[no-untyped-def]
    bundle.meta.replace_chunks(
        document_id,
        [
            ChunkRecord(
                chunk_id=f"c{index}",
                document_id=document_id,
                knowledge_base_id=kb_id,
                part_id=None,
                ordinal=index,
                text=f"第 {index} 段原文，讲的是眼轴测量与近视防控。",
                content_hash=f"h{index}",
            )
            for index in range(count)
        ],
    )


# --------------------------------------------------------------------- 清洗


def test_parse_strips_numbering_quotes_and_dedupes() -> None:
    raw = '1. 第一个问题？\n- 第一个问题？\n"第二个问题？"\n\n第三个问题？\n2) 第四个问题？'

    assert _parse_questions(raw, limit=5) == [
        "第一个问题？",
        "第二个问题？",
        "第三个问题？",
        "第四个问题？",
    ]


def test_parse_keeps_a_question_that_starts_with_a_number() -> None:
    """只吃行首的编号前缀，不能把"2024 年…"这类以数字开头的问题削掉。"""
    assert _parse_questions("2024 年的指南怎么说？", limit=3) == ["2024 年的指南怎么说？"]


def test_parse_respects_the_limit_and_drops_overlong_lines() -> None:
    raw = "问题一？\n问题二？\n问题三？\n" + "很长" * 80 + "？"
    assert _parse_questions(raw, limit=2) == ["问题一？", "问题二？"]


# --------------------------------------------------------------------- 生成


def test_suggest_returns_questions_from_the_model(bundle, kb, document) -> None:  # type: ignore[no-untyped-def]
    _seed_chunks(bundle, kb.id, document.id)
    service = SuggestedQuestionsService(bundle, FakeChat())

    assert service.suggest(kb_ids=[kb.id], limit=5) == ["第一个问题？", "第二个问题？"]


def test_suggest_without_chunks_is_empty(bundle, kb, document) -> None:  # type: ignore[no-untyped-def]
    """库里没有可采样的块（空库）→ 空列表，而不是抛错。"""
    service = SuggestedQuestionsService(bundle, FakeChat())

    assert service.suggest(kb_ids=[kb.id]) == []


def test_suggest_without_kb_ids_is_empty(bundle) -> None:  # type: ignore[no-untyped-def]
    service = SuggestedQuestionsService(bundle, FakeChat())
    assert service.suggest(kb_ids=[]) == []


def test_suggest_swallows_model_failures(bundle, kb, document) -> None:  # type: ignore[no-untyped-def]
    """模型调用失败不该把对话页变成一个错误页——返回空列表，界面回退静态样例。"""
    _seed_chunks(bundle, kb.id, document.id)
    service = SuggestedQuestionsService(bundle, BoomChat())

    assert service.suggest(kb_ids=[kb.id]) == []


def test_suggest_caches_until_refresh(bundle, kb, document) -> None:  # type: ignore[no-untyped-def]
    _seed_chunks(bundle, kb.id, document.id)
    chat = FakeChat()
    service = SuggestedQuestionsService(bundle, chat)

    service.suggest(kb_ids=[kb.id])
    service.suggest(kb_ids=[kb.id])
    assert chat.calls == 1

    service.suggest(kb_ids=[kb.id], refresh=True)
    assert chat.calls == 2


def test_suggest_caps_the_limit(bundle, kb, document) -> None:  # type: ignore[no-untyped-def]
    """一次要 100 条也只给上限内——这是成本闸门。"""
    _seed_chunks(bundle, kb.id, document.id)
    service = SuggestedQuestionsService(bundle, FakeChat())

    # 假模型只回 2 条，但 limit 会被夹到上限；用超长 limit 不报错即可
    assert service.suggest(kb_ids=[kb.id], limit=100) == ["第一个问题？", "第二个问题？"]


def test_suggest_does_not_cache_an_empty_result(bundle, kb, document) -> None:  # type: ignore[no-untyped-def]
    """生成不出来不写缓存：下次进来还要再试，否则一次失败会粘住五分钟。"""
    _seed_chunks(bundle, kb.id, document.id)
    chat = FakeChat(reply="")
    service = SuggestedQuestionsService(bundle, chat)

    assert service.suggest(kb_ids=[kb.id]) == []
    assert service.suggest(kb_ids=[kb.id]) == []
    assert chat.calls == 2
