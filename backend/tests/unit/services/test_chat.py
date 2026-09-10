"""对话链路的单元测试（LLM 用假客户端，不打网络）。

镜像同构：``app/services/chat.py`` → ``tests/unit/services/test_chat.py``。

这条链路上有几个"错了也不报错、只是答得不对"的地方（提示词顺序、引用编号、
检索没命中时的行为），所以逐个钉住。
"""

import pytest

from app.services.chat import (
    DEFAULT_SYSTEM_PROMPT,
    MAX_CHUNK_CHARS,
    ChatService,
    SourceRef,
    build_messages,
)
from app.services.chat import _preview as preview_of
from app.services.llm import ChatError, ChatMessage


def source(index: int, name: str = "指南.pdf", **extra) -> SourceRef:
    return SourceRef(
        index=index,
        chunk_id=f"chunk_{index}",
        document_id=f"doc_{index}",
        document_name=name,
        preview=extra.pop("preview", "这段是原文内容。"),
        **extra,
    )


class FakeChat:
    """假的对话模型：记录收到的 messages，返回固定回答。"""

    def __init__(self, answer: str = "这是回答。[1]") -> None:
        self.answer = answer
        self.received: list[list[ChatMessage]] = []

    def complete(self, messages):  # type: ignore[no-untyped-def]
        self.received.append(list(messages))
        return self.answer

    def stream(self, messages):  # type: ignore[no-untyped-def]
        self.received.append(list(messages))
        yield from self.answer


# --------------------------------------------------------------------- 提示词


def test_messages_use_a_single_system_message() -> None:
    """system 只能有一条且必须在开头。

    OpenAI 兼容端点普遍这么要求，发两条连续的 system 会被 400 拒掉
    （实测 SiliconFlow 返回 `20015 System message must be at the beginning`）。
    资料因此必须并进第一条 system，而不是另起一条。
    """
    messages = build_messages(
        query="近视怎么监测",
        sources=[source(1, "眼轴共识.pdf", heading_path="3 监测", page=4)],
        history=[
            ChatMessage(role="user", content="上一个问题"),
            ChatMessage(role="assistant", content="上一个回答"),
        ],
        system_prompt="",
    )

    assert [m.role for m in messages] == ["system", "user", "assistant", "user"]
    assert messages[0].role == "system"


def test_messages_put_material_before_history() -> None:
    """资料要紧挨着问题：写在第一条 system 里，历史里就不会出现两条 system 夹着资料。"""
    messages = build_messages(
        query="近视怎么监测",
        sources=[source(1, "眼轴共识.pdf", heading_path="3 监测", page=4)],
        history=[ChatMessage(role="user", content="上一个问题")],
        system_prompt="",
    )

    system = messages[0].content
    assert DEFAULT_SYSTEM_PROMPT in system
    assert "眼轴共识.pdf" in system
    assert "3 监测" in system  # 章节路径要带上，否则引用到哪一节看不出来
    assert "第 4 页" in system
    assert "[1]" in system
    assert messages[-1].content == "近视怎么监测"
    assert messages[-1].role == "user"


def test_messages_tell_model_when_nothing_retrieved() -> None:
    """检索没命中时要**明说**，否则模型会拿常识硬答，看起来像知识库有内容。"""
    messages = build_messages(query="问点什么", sources=[], history=None, system_prompt="")

    assert len(messages) == 2
    assert "没有命中" in messages[0].content


def test_custom_system_prompt_wins_but_blank_falls_back() -> None:
    """自定义提示词要生效；留空则回落内置的——空字符串不能当提示词发给模型。"""
    custom = build_messages(query="q", sources=[], history=None, system_prompt="你是眼科专家。")
    assert custom[0].content.startswith("你是眼科专家。")

    blank = build_messages(query="q", sources=[], history=None, system_prompt="   ")
    assert blank[0].content.startswith(DEFAULT_SYSTEM_PROMPT)


# --------------------------------------------------------------------- 服务


def test_answer_returns_sources_and_passes_prompt_to_model(runtime, bundle) -> None:
    fake = FakeChat("眼轴长度是主要监测指标。[1]")
    captured: dict = {}

    class RecordingRetrieval:
        def search(self, query):  # type: ignore[no-untyped-def]
            captured["query"] = query
            return type(
                "Response",
                (),
                {
                    "hits": [
                        type(
                            "Hit",
                            (),
                            {
                                "chunk_id": "c1",
                                "document_id": "d1",
                                "document_name": "眼轴共识.pdf",
                                "heading_path": "3 监测",
                                "page": 4,
                                "score": 0.9,
                                "text": "眼轴长度是主要参数之一。",
                            },
                        )()
                    ]
                },
            )()

    service = ChatService(RecordingRetrieval(), runtime, chat_factory=lambda config: fake)  # type: ignore[arg-type]
    runtime.set({"llm.api_key": "sk-test", "llm.model_id": "Qwen/Qwen3.5-4B"})

    turn = service.answer(query="近视怎么监测", sources=service.retrieve_sources(
        query="近视怎么监测", kb_ids=["kb_1"]
    ))

    assert turn.answer == "眼轴长度是主要监测指标。[1]"
    assert [s.index for s in turn.sources] == [1]
    assert turn.sources[0].document_name == "眼轴共识.pdf"
    assert captured["query"].query == "近视怎么监测"
    # 资料确实进了第一条 system
    assert "眼轴长度是主要参数之一" in fake.received[0][0].content


def test_preview_is_truncated_and_whitespace_collapsed() -> None:
    """资料原文要先压平空白再截断：chunk 里有换行与缩进，直接拼进提示词会把结构搞乱。"""
    long_text = "第一行\n\n第二行   " + "内容" * 800

    preview = preview_of(long_text)

    assert "\n" not in preview
    assert preview.endswith("…")
    assert len(preview) <= MAX_CHUNK_CHARS + 1


def test_preview_strips_table_html_from_parsers() -> None:
    """云端解析器把表格输出成 HTML，标签必须剥掉。

    实测一份专家共识里 40/136 个 chunk 是 ``<table><tr><td>`` 片段。
    原样送进模型会淹没表格数据，原样显示在引用列表里，用户看到的第一眼是
    ``</td><td>``。这一层同时供提示词与界面使用，所以在这里剥。
    """
    table = (
        '<table><tr><td rowspan="2">年龄</td><td>21.19</td><td>21.38</td></tr>'
        "<tr><td>6</td><td>21.74</td></tr></table>"
    )

    preview = preview_of(table)

    assert "<" not in preview and ">" not in preview
    assert "rowspan" not in preview
    # 数据本身要留着——剥的是标记，不是内容
    assert "21.19" in preview and "21.74" in preview
    assert "年龄" in preview
    assert "  " not in preview


def test_preview_keeps_plain_angle_brackets() -> None:
    """正文里的 ``a < b`` 不是标签，不能被连内容一起吃掉。"""
    preview = preview_of("约束条件：当 a < b 且 b <= c 时成立。")

    assert "a < b" in preview
    assert "b <= c" in preview


def test_stream_yields_pieces_in_order(runtime) -> None:
    fake = FakeChat("一二三")
    service = ChatService(_EmptyRetrieval(), runtime, chat_factory=lambda config: fake)
    runtime.set({"llm.api_key": "sk-test", "llm.model_id": "m"})

    pieces = list(service.answer_stream(query="q", sources=[]))

    assert pieces == ["一", "二", "三"]


def test_unconfigured_llm_raises_actionable_error(runtime) -> None:
    """没配模型时必须报"去哪配"，而不是返回空答案让用户以为知识库里没有。"""
    service = ChatService(_EmptyRetrieval(), runtime, chat_factory=lambda config: FakeChat())
    runtime.set({"llm.api_key": ""})

    with pytest.raises(ChatError) as excinfo:
        service.answer(query="q", sources=[])

    assert "设置" in str(excinfo.value)


def test_probe_reports_empty_content_as_error(runtime) -> None:
    """推理模型只回思考、content 为空时，探针必须报错而不是返回空串。"""

    class EmptyMessage:
        def complete(self, messages):  # type: ignore[no-untyped-def]
            raise ChatError("模型只返回了思考过程、没有正文")

    service = ChatService(_EmptyRetrieval(), runtime, chat_factory=lambda c: EmptyMessage())
    runtime.set({"llm.api_key": "sk-test", "llm.model_id": "m"})

    with pytest.raises(ChatError):
        service.probe()


class _EmptyRetrieval:
    def search(self, query):  # type: ignore[no-untyped-def]
        return type("Response", (), {"hits": []})()
