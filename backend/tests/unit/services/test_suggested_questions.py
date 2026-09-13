"""示例问题生成（对话页空状态）。

镜像同构：``app/services/suggested_questions.py`` → 本文件。

要紧的三条：拿不到语料/生成失败都**不报错**（回退静态样例）、模型输出被保守清洗、
同一组知识库在缓存期内不重复调用（切一次库就重新生成一次太费 token）。
"""

from __future__ import annotations

from app.models.enums import DataSourceKind, DocumentStage
from app.services.suggested_questions import (
    SuggestedQuestionsService,
    _parse_questions,
)
from app.storage.base import ChunkRecord, DocumentRecord, KnowledgeBaseRecord


class FakeChat:
    """假的对话模型：只实现 ``ask_raw``，记录调用次数、收到的提示词与 model_pk。"""

    def __init__(self, reply: str = "1. 第一个问题？\n2. 第二个问题？") -> None:
        self.reply = reply
        self.calls = 0
        self.last_prompt = ""
        self.last_model: str | None = None

    def ask_raw(self, messages, *, model_pk=None):  # type: ignore[no-untyped-def]
        self.calls += 1
        self.last_prompt = messages[-1].content
        self.last_model = model_pk
        return self.reply


class BoomChat:
    def ask_raw(self, messages, *, model_pk=None):  # type: ignore[no-untyped-def]
        raise RuntimeError("上游挂了")


def _seed_chunks(
    bundle,  # type: ignore[no-untyped-def]
    kb_id: str,
    document_id: str,
    count: int = 2,
    prefix: str = "c",
) -> None:
    bundle.meta.replace_chunks(
        document_id,
        [
            ChunkRecord(
                chunk_id=f"{prefix}{index}",
                document_id=document_id,
                knowledge_base_id=kb_id,
                part_id=None,
                ordinal=index,
                text=f"第 {index} 段原文，讲的是眼轴测量与近视防控。",
                content_hash=f"h{prefix}{index}",
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


# --------------------------------------------------------------------- 每库设置（v19）


def _set(bundle, kb_id: str, **values) -> None:  # type: ignore[no-untyped-def]
    """直接写库上的推荐问题设置（绕过服务层的校验，测的是读取侧）。"""
    base = {
        "enabled": True,
        "count": 6,
        "model_pk": None,
        "prompt": "",
    }
    base.update(values)
    bundle.meta.set_knowledge_base_suggested(kb_id, **base)


def test_suggest_uses_kb_count_and_prompt(bundle, kb, document) -> None:  # type: ignore[no-untyped-def]
    """条数与提示词以**库上的设置**为准——这正是"设置没体现"要修的地方。"""
    _seed_chunks(bundle, kb.id, document.id)
    _set(bundle, kb.id, count=3, prompt="请从诊断标准的角度出题，每行一个问题。{n}")
    chat = FakeChat()
    service = SuggestedQuestionsService(bundle, chat)

    service.suggest(kb_ids=[kb.id])

    # 自定义提示词替换了内置那句，资料片段照旧附在前面；{n} 换成了条数
    assert "请从诊断标准的角度出题，每行一个问题。3" in chat.last_prompt
    assert "资料片段：" in chat.last_prompt


def test_suggest_keeps_builtin_prompt_when_kb_has_none(bundle, kb, document) -> None:  # type: ignore[no-untyped-def]
    _seed_chunks(bundle, kb.id, document.id)
    chat = FakeChat()
    service = SuggestedQuestionsService(bundle, chat)

    service.suggest(kb_ids=[kb.id])

    assert "写出 6 个用户可能想追问的中文问题" in chat.last_prompt


def test_suggest_uses_kb_model_over_the_request(bundle, kb, document) -> None:  # type: ignore[no-untyped-def]
    """"出题用哪个模型"是库上的设置，显式设了就该盖过请求里的对话模型。"""
    _seed_chunks(bundle, kb.id, document.id)
    _set(bundle, kb.id, model_pk="mdl_cheap")
    chat = FakeChat()
    service = SuggestedQuestionsService(bundle, chat)

    service.suggest(kb_ids=[kb.id], model_pk="mdl_chat")

    assert chat.last_model == "mdl_cheap"


def test_suggest_falls_back_to_the_request_model(bundle, kb, document) -> None:  # type: ignore[no-untyped-def]
    _seed_chunks(bundle, kb.id, document.id)
    chat = FakeChat()
    service = SuggestedQuestionsService(bundle, chat)

    service.suggest(kb_ids=[kb.id], model_pk="mdl_chat")

    assert chat.last_model == "mdl_chat"


def test_suggest_request_limit_overrides_kb_count(bundle, kb, document) -> None:  # type: ignore[no-untyped-def]
    """脚本/API 显式给了条数就以它为准（界面不再传，让库设置说话）。"""
    _seed_chunks(bundle, kb.id, document.id)
    _set(bundle, kb.id, count=6)
    chat = FakeChat()
    service = SuggestedQuestionsService(bundle, chat)

    service.suggest(kb_ids=[kb.id], limit=2)

    assert "写出 2 个用户可能想追问的中文问题" in chat.last_prompt


def test_suggest_skips_a_kb_that_turned_questions_off(bundle, kb, document) -> None:  # type: ignore[no-untyped-def]
    """关掉推荐问题的库既不取样也不出题——连一次模型调用都不该花。"""
    _seed_chunks(bundle, kb.id, document.id)
    _set(bundle, kb.id, enabled=False)
    chat = FakeChat()
    service = SuggestedQuestionsService(bundle, chat)

    assert service.suggest(kb_ids=[kb.id]) == []
    assert chat.calls == 0


def test_suggest_multi_kb_takes_settings_from_the_first_enabled(bundle, kb, document) -> None:  # type: ignore[no-untyped-def]
    """多库被同时选中：取样含全部启用的库，参数取第一个启用的库。"""
    second = bundle.meta.create_knowledge_base(
        KnowledgeBaseRecord(id="kb_2", name="乙库", embedding_model_id="m", embedding_dim=8)
    )
    bundle.meta.create_document(
        DocumentRecord(
            id="doc_2",
            knowledge_base_id=second.id,
            name="乙.md",
            source_kind=DataSourceKind.UPLOAD,
            content_hash="hash-2",
            stage=DocumentStage.UPLOADED,
            size_bytes=64,
        )
    )
    _seed_chunks(bundle, kb.id, document.id)
    # chunk_id 是全库主键，第二个库要换个前缀，否则撞键
    _seed_chunks(bundle, second.id, "doc_2", prefix="d")
    _set(bundle, kb.id, enabled=False, count=8)
    _set(bundle, second.id, count=2, model_pk="mdl_b")
    chat = FakeChat()
    service = SuggestedQuestionsService(bundle, chat)

    service.suggest(kb_ids=[kb.id, second.id], limit=None)

    assert chat.last_model == "mdl_b"
    assert "写出 2 个用户可能想追问的中文问题" in chat.last_prompt


def test_suggest_ignores_unknown_kb_ids(bundle, kb, document) -> None:  # type: ignore[no-untyped-def]
    """会话里存着、但库已经被删掉了的 id 不该让出题整个失败。"""
    _seed_chunks(bundle, kb.id, document.id)
    service = SuggestedQuestionsService(bundle, FakeChat())

    assert service.suggest(kb_ids=["kb_gone", kb.id]) == ["第一个问题？", "第二个问题？"]
