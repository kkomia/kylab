"""Agent 工作流的纯逻辑测试：提示词输出解析与多路结果合并。

这些函数有一个共同点：**输入是模型生成的自由文本，输出必须永远可用**。
它们错了不会抛异常，只会"悄悄退化成单轮检索"或"引用编号对不上"，
所以把边界逐个钉住。
"""

from app.models.enums import DataSourceKind, DocumentStage
from app.services.agent import (
    MAX_PLAN_QUERIES,
    MAX_QUERY_CHARS,
    intent_label,
    parse_decision,
    parse_plan,
)
from app.services.chat import (
    SourceRef,
    _findings_summary,
    _history_snippet,
    _merge_sources,
)
from app.services.llm import ChatMessage


def source(
    chunk_id: str,
    *,
    index: int = 1,
    score: float = 0.5,
    name: str = "a.pdf",
    document_summary: str = "",
) -> SourceRef:
    return SourceRef(
        index=index,
        chunk_id=chunk_id,
        document_id=f"doc_{chunk_id}",
        document_name=name,
        score=score,
        preview="预览",
        document_summary=document_summary,
    )


# ------------------------------------------------------------------ 规划解析


def test_parse_plan_reads_a_plain_json_object() -> None:
    plan = parse_plan(
        '{"intent":"comparison","queries":["A 与 B 的区别"],"need_retrieval":true,"reason":"对比"}'
    )

    assert plan is not None
    assert plan.intent == "comparison"
    assert plan.queries == ["A 与 B 的区别"]
    assert plan.need_retrieval is True
    assert plan.reason == "对比"


def test_parse_plan_survives_markdown_fences_and_prose() -> None:
    """模型很爱把 JSON 包在围栏里、前面再加一句解释——不能因此判为失败。"""
    text = (
        "好的，这是我的判断：\n```json\n"
        '{"intent":"summary","queries":["季度总结"],"need_retrieval":true}\n```\n以上。'
    )

    plan = parse_plan(text)

    assert plan is not None
    assert plan.intent == "summary"
    assert plan.queries == ["季度总结"]


def test_parse_plan_handles_braces_inside_strings() -> None:
    """查询词里出现花括号时，括号配对扫描不能被带偏（正则方案就会）。"""
    text = '前言 {"intent":"factual","queries":["格式 {a} 的含义"],"need_retrieval":true}'
    plan = parse_plan(text)

    assert plan is not None
    assert plan.queries == ["格式 {a} 的含义"]


def test_parse_plan_cleans_and_limits_queries() -> None:
    plan = parse_plan(
        '{"intent":"factual","queries":["  spaced  out ","", "dup","dup","four","five"],'
        '"need_retrieval":true}'
    )

    assert plan is not None
    assert plan.queries == ["spaced out", "dup", "four"]  # 去空、去重、最多 3 条
    assert len(plan.queries) == MAX_PLAN_QUERIES


def test_parse_plan_truncates_overlong_queries() -> None:
    plan = parse_plan('{"intent":"factual","queries":["' + "字" * 200 + '"]}')

    assert plan is not None
    assert len(plan.queries[0]) == MAX_QUERY_CHARS


def test_parse_plan_forces_no_retrieval_for_chitchat() -> None:
    """意图是寒暄时，即便模型说 need_retrieval=true 也不该去检索。"""
    plan = parse_plan('{"intent":"chat","queries":["你好"],"need_retrieval":true}')

    assert plan is not None
    assert plan.need_retrieval is False


def test_parse_plan_unknown_intent_falls_back_to_factual() -> None:
    plan = parse_plan('{"intent":"算命","queries":["x"]}')

    assert plan is not None
    assert plan.intent == "factual"


def test_parse_plan_returns_none_on_garbage() -> None:
    """拿不到合法 JSON 就交给调用方降级——不能抛错，更不能瞎猜。"""
    assert parse_plan("我不知道该怎么回答。") is None
    assert parse_plan("{不是 JSON}") is None
    assert parse_plan("") is None


def test_parse_plan_defaults_need_retrieval_to_true() -> None:
    """字段缺失时默认检索：少答不如多找一次。"""
    plan = parse_plan('{"intent":"factual","queries":["x"]}')

    assert plan is not None
    assert plan.need_retrieval is True


# ------------------------------------------------------------------ 决策解析


def test_parse_decision_reads_search_and_answer() -> None:
    search = parse_decision('{"action":"search","query":"换个说法"}')
    answer = parse_decision('{"action":"answer","reason":"够了"}')

    assert search is not None and search.action == "search" and search.query == "换个说法"
    assert answer is not None and answer.action == "answer"


def test_parse_decision_rejects_invalid_shapes() -> None:
    assert parse_decision('{"action":"search"}') is None  # 缺 query
    assert parse_decision('{"action":"search","query":"   "}') is None
    assert parse_decision('{"action":"fly"}') is None
    assert parse_decision("随便说说") is None


def test_intent_label_unknown_is_readable() -> None:
    assert intent_label("comparison") == "对比"
    assert intent_label("不存在") == "查事实"


# ------------------------------------------------------------------ 多路合并


def test_merge_sources_dedupes_keeps_best_and_reindexes() -> None:
    """同一 chunk 被两条查询命中只留一次，且留分更高的那条。"""
    merged = _merge_sources(
        [
            [source("c1", index=1, score=0.4), source("c2", index=2, score=0.8)],
            [source("c2", index=1, score=0.9), source("c3", index=2, score=0.5)],
        ],
        limit=10,
    )

    assert [item.chunk_id for item in merged] == ["c2", "c3", "c1"]  # 按分数降序
    assert [item.index for item in merged] == [1, 2, 3]  # 重新连续编号
    assert merged[0].score == 0.9  # 保留了分更高的那条


def test_merge_sources_respects_the_limit() -> None:
    merged = _merge_sources([[source(f"c{i}", score=1.0 - i / 10) for i in range(10)]], limit=3)

    assert len(merged) == 3
    assert [item.index for item in merged] == [1, 2, 3]


# ------------------------------------------------------------------ 提示词材料


def test_findings_summary_includes_title_and_preview() -> None:
    summary = _findings_summary(
        [SourceRef(index=1, chunk_id="c", document_id="d", document_name="指南.pdf",
                   heading_path="3 监测", preview="眼轴每三个月测一次")]
    )

    assert "[1]" in summary and "指南.pdf" in summary and "3 监测" in summary
    assert "眼轴每三个月测一次" in summary


def test_findings_summary_for_empty_sources() -> None:
    assert _findings_summary([]) == "（暂无）"


def test_history_snippet_only_takes_the_tail() -> None:
    """规划调用是固定开销，历史只取最近的几轮，不能随对话无限变长。"""
    history = [ChatMessage(role="user", content=f"第{i}问") for i in range(10)]

    snippet = _history_snippet(history)

    assert "第9问" in snippet and "第5问" not in snippet
    assert snippet.startswith("最近对话：")


# ------------------------------------------------- 决策器拿到的"库概况"（v25）


def test_decide_prompt_asks_for_the_library_context() -> None:
    """决策提示词里必须有「知识库概况」这一格。

    只看命中片段时，决策器分不清"是这个库本来没有"和"这一轮词没找好"，
    于是会一直换词试探，在无关内容里越挖越远。
    """
    from app.services.agent import DECIDE_PROMPT

    assert "{library}" in DECIDE_PROMPT
    assert "知识库概况" in DECIDE_PROMPT
    # 明确交代"无关就直接作答"，否则那句概况给了也没人用
    assert "直接作答" in DECIDE_PROMPT


class _FakeMeta:
    """只实现 ``_library_summary`` 用到的两个方法（鸭子类型，避免装配整条链路）。"""

    def __init__(self, total: int, documents: dict) -> None:
        self._total = total
        self._documents = documents

    def count_documents(self, kb_id: str) -> int:
        return self._total

    def get_documents_by_ids(self, ids):  # type: ignore[no-untyped-def]
        return self._documents


def _summary_service(total: int = 0, documents: dict | None = None):  # type: ignore[no-untyped-def]
    from app.services.chat import ChatService

    service = ChatService.__new__(ChatService)  # 只测这一个纯拼装方法
    service._stores = type("S", (), {"meta": _FakeMeta(total, documents or {})})()  # type: ignore[assignment]
    return service


def test_library_summary_states_the_size_and_the_hit_documents() -> None:
    """库概况 = **库有多大** + 命中文档的摘要（一行一篇、去重）。"""
    from app.storage.base import DocumentRecord

    summary = "一篇关于绿地与近视的系统综述。"
    # 同一篇文档的两段命中：摘要只该出现一次（SourceRef 是 frozen，摘要构造时就给）
    hits = [
        source("c1", name="绿地与近视.pdf", document_summary=summary),
        source("c2", name="绿地与近视.pdf", document_summary=summary),
    ]
    documents = {
        "doc_c1": DocumentRecord(
            id="doc_c1",
            knowledge_base_id="kb_1",
            name="绿地与近视.pdf",
            source_kind=DataSourceKind.UPLOAD,
            content_hash="h1",
            stage=DocumentStage.INDEXED,
            summary=summary,
        )
    }

    text = _summary_service(total=23, documents=documents)._library_summary(["kb_1"], hits)

    assert "共 23 篇文档" in text
    assert text.count(summary) == 1
    assert "绿地与近视.pdf" in text


def test_library_summary_says_so_when_no_summary_is_available() -> None:
    """摘要还没补上时不留空标题，明说"没有背景"。"""
    text = _summary_service(total=3)._library_summary(["kb_1"], [source("c1")])

    assert "还没有摘要" in text
