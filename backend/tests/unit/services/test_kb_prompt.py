"""库级提示词生成（v0.19）。

这一组的重点不是"调通了一次模型调用"，而是**用户点名的那四条**能不能被钉住：

- 喂进去的只有文档摘要（不送全文）；
- 提示词里**不许出现摘要里没有的具体事实**；
- 写了具体事实的句子必须标 `[来源: 文件名]`；
- 引用解析出来之后，**指向不存在文件的引用要被揪出来**（那是编造的直接证据）。

前三条落在 `_META_PROMPT` 的文本上，所以这里直接断言那段文本里有没有那几条约束
——它变了却没有相应调整，这条用例就该红。第四条是纯逻辑，用假数据钉。
"""

from __future__ import annotations

import pytest

from app.core.exceptions import InvalidRequestError
from app.services import kb_prompt as module
from app.services.kb_prompt import KBPromptService, _build_user_prompt, _clean, _draft
from app.services.llm import ChatMessage

# ------------------------------------------------------------------ 元提示词的约束


def test_meta_prompt_forbids_inventing_specific_facts() -> None:
    """**不捏造**：把最容易"顺手补一个"的几类事实点名列出来，并要求宁可少写。"""
    text = module._META_PROMPT

    assert "摘要里没有的具体事实，一个字都不许写" in text
    # 这几类是模型最容易凭"领域常识"补上的，必须点名
    for category in ("数字", "阈值", "年份", "机构名", "药物名", "标准或法规编号"):
        assert category in text, category
    # 也点名了"用自己的领域知识补充"这条
    assert "你自己的领域知识" in text


def test_meta_prompt_requires_citations_and_forbids_vagueness() -> None:
    """**可溯源 + 不许把不知道的说圆**：两条都要在提示词里，缺一条就守不住。"""
    text = module._META_PROMPT

    # 引用格式要写死，否则解析端拿不到东西可查
    assert "[来源: 文件名]" in text
    # 「通常」「一般来说」这类措辞是把不确定性伪装成结论，必须禁
    assert "「通常」" in text and "「一般来说」" in text
    # 五节结构：没有结构就没有"专业"可言
    for section in ("角色", "资料范围", "专业口径", "回答要求", "拒答规则"):
        assert section in text, section


def test_user_prompt_lists_names_and_summaries_only() -> None:
    """喂进去的是**文件名 + 摘要**，且带上数量与截断口径（让模型知道自己看到的是节选）。"""
    body = _build_user_prompt([("d1", "指南.pdf", "讲的是干眼的诊断与分级。")])

    assert "指南.pdf" in body
    assert "讲的是干眼的诊断与分级。" in body
    assert "1 篇文档" in body
    assert str(module.MAX_SUMMARY_CHARS) in body


# ------------------------------------------------------------------ 外壳清理


def test_clean_unwraps_a_code_fence() -> None:
    """模型习惯把整段包进代码块；不拆的话用户复制到设置里会带着三个反引号。"""
    assert _clean("```markdown\n你是助手。\n```") == "你是助手。"
    assert _clean("```\n你是助手。\n```") == "你是助手。"


def test_clean_keeps_content_that_merely_contains_a_fence() -> None:
    """只拆"整段就是一个代码块"那种。**不做启发式删除**——
    把正文里出现的反引号当包装切掉，是删掉用户要的东西（删错比留一句客套话严重）。"""
    raw = "你是助手。\n\n```\n示例\n```\n\n按原文回答。"
    assert _clean(raw) == raw


# ------------------------------------------------------------------ 引用解析（溯源）


def test_draft_marks_which_summaries_were_cited() -> None:
    prompt = "你是干眼领域的助手。干眼按严重程度分级 [来源: 共识.pdf]。"
    draft = _draft(prompt, [("d1", "共识.pdf", "摘要一"), ("d2", "另一篇.pdf", "摘要二")])

    assert draft.prompt == prompt
    assert [(item.name, item.cited) for item in draft.sources] == [
        ("共识.pdf", True),
        ("另一篇.pdf", False),
    ]
    assert draft.cited_documents == 1
    assert draft.unknown_citations == []


def test_draft_flags_citations_to_documents_that_do_not_exist() -> None:
    """**这是"不捏造"可验证的那一半**：模型引了一篇没给它的文件，必须被记下来。"""
    prompt = "按某标准执行 [来源: 我从没见过的指南.pdf]。"
    draft = _draft(prompt, [("d1", "共识.pdf", "摘要一")])

    assert draft.unknown_citations == ["我从没见过的指南.pdf"]
    assert draft.cited_documents == 0


def test_draft_matches_citations_loosely_on_the_name() -> None:
    """文件名被模型写长/写短一点（补了扩展名、丢了后缀）不该算成"不存在"。"""
    draft = _draft("见 [来源: 共识]。", [("d1", "共识.pdf", "摘要")])

    assert draft.unknown_citations == []
    assert draft.sources[0].cited is True


def test_draft_reads_both_colon_styles() -> None:
    """中英文冒号模型两种都会写，只认一种就会把真实引用误判成编造。"""
    draft = _draft("甲 [来源：共识.pdf]，乙 [来源: 共识.pdf]。", [("d1", "共识.pdf", "摘要")])

    assert draft.unknown_citations == []
    assert draft.sources[0].cited is True


# ------------------------------------------------------------------ 服务层


class _FakeChat:
    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.messages: list[list[ChatMessage]] = []

    def ask_raw(self, messages: list[ChatMessage], *, model_pk: str | None = None) -> str:
        self.messages.append(list(messages))
        return self.reply


def _doc(document_id: str, name: str, summary: str):  # type: ignore[no-untyped-def]
    return type("Doc", (), {"id": document_id, "name": name, "summary": summary})()


class _Meta:
    def __init__(self, docs: list) -> None:  # type: ignore[type-arg]
        self._docs = docs

    def list_documents(self, kb_id: str, *, limit: int | None = None):  # type: ignore[no-untyped-def]
        return self._docs[: limit or len(self._docs)]


class _Stores:
    def __init__(self, docs: list) -> None:  # type: ignore[type-arg]
        self.meta = _Meta(docs)


def _service(docs: list, reply: str) -> tuple[KBPromptService, _FakeChat]:  # type: ignore[type-arg]
    chat = _FakeChat(reply)
    return KBPromptService(_Stores(docs), chat), chat  # type: ignore[arg-type]


def test_generate_skips_documents_without_a_summary() -> None:
    """没摘要的文档跳过而不是报错：新旧混着是常态，先有摘要的那批先生成一版。"""
    service, chat = _service(
        [_doc("d1", "有摘要.pdf", "讲了 A。"), _doc("d2", "没摘要.pdf", "")],
        "你是资料助手。资料范围是本库收录的文档。回答要求：按原文表述，标出出处。拒答规则：资料里没有的内容直接说没有。",
    )

    draft = service.generate("kb_1")

    assert [item.name for item in draft.sources] == ["有摘要.pdf"]
    sent = chat.messages[0][1].content
    assert "有摘要.pdf" in sent
    assert "没摘要.pdf" not in sent


def test_generate_explains_that_there_is_nothing_to_work_from() -> None:
    """一条摘要都没有时，要说清**用户该做什么**，而不是抛一句通用错误。"""
    service, _ = _service([_doc("d1", "没摘要.pdf", "")], "无所谓")

    with pytest.raises(InvalidRequestError) as exc:
        service.generate("kb_1")

    assert "文档摘要" in str(exc.value)
    assert "手写" in str(exc.value)


def test_generate_rejects_an_empty_model_reply() -> None:
    """模型只回一句"好的"时不许当成草稿——那种文本存进设置里等于把提示词清空了。"""
    service, _ = _service([_doc("d1", "有摘要.pdf", "讲了 A。")], "好的")

    with pytest.raises(InvalidRequestError):
        service.generate("kb_1")


def test_generate_truncates_long_summaries() -> None:
    """单篇摘要异常长时截断：防一篇把整轮预算吃光。"""
    service, chat = _service(
        [_doc("d1", "长文.pdf", "字" * (module.MAX_SUMMARY_CHARS + 500))],
        "你是资料助手。资料范围是本库收录的文档。回答要求：按原文表述，标出出处。拒答规则：资料里没有的内容直接说没有。",
    )

    service.generate("kb_1")

    sent = chat.messages[0][1].content
    assert "字" * module.MAX_SUMMARY_CHARS in sent
    assert "字" * (module.MAX_SUMMARY_CHARS + 1) not in sent

def test_format_placeholder_is_not_reported_as_a_fabricated_citation() -> None:
    """**实测抓到的假警报**：模型在正文里说明标注格式时照抄了 `[来源: 文件名]`，
    原先会被当成"引了一篇不存在的文件"，界面据此提示"那是编造的迹象"。
    一次完全正常的生成不该被这样报警——假警报会让用户学会忽略这个提示。
    """
    prompt = "回答要求：每处具体事实后以 [来源: 文件名] 标注出处。依据是 [来源: 共识.pdf]。"
    draft = _draft(prompt, [("d1", "共识.pdf", "摘要")])

    assert draft.unknown_citations == []
    assert draft.sources[0].cited is True

def test_wrong_list_number_is_still_the_same_document() -> None:
    """**实测抓到的第二类假警报**：清单里的文件名带列表序号前缀（`8.Urban greenspace…`），
    模型引用时常把那个数字写错一位（写成 `2.Urban greenspace…`）。

    那**不是**编了另一篇，只是序号抄错了——只差序号不该算成"引用了不存在的文件"，
    否则界面会对一个真实引用报"编造的迹象"。比对时剥掉开头的序号。
    """
    draft = _draft(
        "见 [来源: 文献表格/2.Urban greenspace and visual acuity.pdf]。",
        [("d1", "文献表格/8.Urban greenspace and visual acuity.pdf", "摘要")],
    )

    assert draft.unknown_citations == []
    assert draft.sources[0].cited is True


def test_a_genuinely_invented_file_is_still_reported() -> None:
    """宽松匹配**不能宽到把编造也放过**：清单里压根没有这篇，就该报出来。"""
    draft = _draft(
        "按某标准执行 [来源: 我从没见过的指南.pdf]。",
        [("d1", "文献表格/8.Urban greenspace.pdf", "摘要")],
    )

    assert draft.unknown_citations == ["我从没见过的指南.pdf"]
