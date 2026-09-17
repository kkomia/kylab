"""按文档摘要生成**库级提示词**（v0.19）。

用户在知识库设置里点「按文档摘要生成」，这里负责把这件事做成一次有边界的模型调用。

## 为什么喂摘要而不是全文

`documents.summary`（v25）本来就是"这篇讲什么"的紧凑表达，而生成一段库级提示词
需要的正是这个层次的信息。送全文有三个坏处：贵（一个库几十篇）、慢、
而且会把提示词带跑偏成"对某一段的复述"。摘要还有个额外的好处：
它是**已经生成好、能被人读到**的东西——于是"这段提示词依据了什么"
对用户是可核对的，不是黑箱。

## 用户点名的四条，落在这里

1. **专业**：输出按固定五节写（角色 / 资料范围 / 专业口径 / 回答要求 / 拒答规则），
   而不是让模型自由发挥成一段散文。
2. **可靠**：只用给出的摘要，摘要里没有的**具体事实一个字都不许写**——
   数字、阈值、比例、年份、机构名、药物与产品名、标准编号都点名列出，
   因为这正是模型最容易"顺手补一个像样的"的地方。
3. **不捏造**：宁可少写，也不许用"通常""一般来说"把不知道的东西说圆。
4. **可溯源**：写了具体事实的句子必须标 `[来源: 文件名]`。这段话生成之后，
   这里会**把标记解析出来**，告诉界面哪几篇被引用了、有没有引用到不存在的文件
   （后者是"编造"的直接证据，见 `unknown_citations`）。

第 4 条是这套设计里唯一不是"告诉模型要诚实"的部分：**它是可验证的**。
模型说它依据了哪几篇，我们就去核对那几篇在不在给定的清单里。

## 边界

- **不落库**：只产出草稿。写不写、怎么写，由用户在设置里看着改完再保存
  （一次模型调用不该顺手改掉库的配置）。
- **一次调用**：不分批、不重试。摘要有上限（`MAX_DOCS` / `MAX_SUMMARY_CHARS`）。
- **失败要说清是哪一种**：库里没有摘要（该先生成摘要）与模型不可用，
  是两件需要用户做不同动作的事。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

from app.core.exceptions import InvalidRequestError
from app.services.chat import ChatService
from app.services.llm import ChatMessage
from app.storage.base import StoreBundle

__all__ = [
    "MAX_DOCS",
    "MAX_SUMMARY_CHARS",
    "KBPromptDraft",
    "KBPromptService",
    "KBPromptSource",
]

logger = logging.getLogger(__name__)

#: 一次最多带几篇文档的摘要。再多的边际收益很低（第 30 篇不会改变"这个库讲什么"），
#: 却会线性推高提示词长度与费用。
MAX_DOCS = 24

#: 每篇摘要截到多少字。摘要本身通常就一两百字，这里只是防某篇异常长把预算吃光。
MAX_SUMMARY_CHARS = 600

#: 生成结果短于这个长度就当作没生成出来（模型有时会回一句"好的"或空串）。
MIN_PROMPT_CHARS = 30

#: `[来源: 文件名]` 的解析。中英文冒号都收——模型两种都会写。
_CITATION = re.compile(r"\[来源[:：]\s*([^\]]+?)\s*\]")

#: 这几个是**格式占位符**，不算引用。
#:
#: 实测（拿 20 篇真实摘要跑出来的那份）踩到的：生成的提示词里有一句
#: "每处具体事实后以 `[来源: 文件名]` 标注出处"——模型在**说明标注格式**，
#: 而解析器把「文件名」当成了一个来源，于是它进了 `unknown_citations`，
#: 界面就会对一次完全正常的生成报"引用了清单里没有的文件，那是编造的迹象"。
#: **假警报比不报警更糟**：它会让用户学会忽略这个提示，于是真出现编造时也没人看。
#:
#: 之所以敢用白名单，是因为这个格式是**我们在元提示词里定死的**
#: （见 `_META_PROMPT` 第 3 条要求它照抄 `[来源: 文件名]`），不是要猜的量。
_PLACEHOLDER_CITATIONS = frozenset({"文件名", "文档名", "filename", "文档"})


@dataclass(frozen=True)
class KBPromptSource:
    """生成时用到的某一篇文档的摘要，以及**它有没有被引用**。"""

    document_id: str
    name: str
    summary: str
    #: 生成的提示词里有没有 `[来源: 这篇]`。`False` 不代表它没用上
    #: ——摘要可能只是提供了背景，而没有贡献具体事实。
    cited: bool = False


@dataclass(frozen=True)
class KBPromptDraft:
    """生成的草稿。**不落库**，由用户在设置里确认后再存。"""

    prompt: str
    sources: list[KBPromptSource] = field(default_factory=list)
    #: 模型标了来源、但那个文件名**不在我们给的清单里**。这是"编造"的直接证据，
    #: 界面据此提示"这次生成有可疑引用，请核对后再保存"。
    unknown_citations: list[str] = field(default_factory=list)

    @property
    def cited_documents(self) -> int:
        return sum(1 for item in self.sources if item.cited)


class KBPromptService:
    """读文档摘要 → 调模型 → 返回草稿与溯源。"""

    def __init__(self, stores: StoreBundle, chat: ChatService) -> None:
        self._stores = stores
        self._chat = chat

    def generate(self, kb_id: str, *, model_pk: str | None = None) -> KBPromptDraft:
        docs = self._summaries(kb_id)
        if not docs:
            raise InvalidRequestError(
                "这个库还没有可用的文档摘要：先上传并解析文档，摘要生成之后再来，"
                "或者直接手写提示词"
            )
        raw = self._chat.ask_raw(
            [
                ChatMessage(role="system", content=_META_PROMPT),
                ChatMessage(role="user", content=_build_user_prompt(docs)),
            ],
            model_pk=model_pk,
        )
        prompt = _clean(raw)
        if len(prompt) < MIN_PROMPT_CHARS:
            raise InvalidRequestError("模型没有给出可用的提示词，请重试或直接手写")
        return _draft(prompt, docs)

    def _summaries(self, kb_id: str) -> list[tuple[str, str, str]]:
        """``[(document_id, name, summary)]``，只含**已经有摘要**的文档。

        没摘要的文档跳过而不是报错：一个库里新旧文档混着是常态，
        让先有摘要的那批先生成一版是完全合理的使用方式。
        """
        records = self._stores.meta.list_documents(kb_id, limit=MAX_DOCS)
        found: list[tuple[str, str, str]] = []
        for record in records:
            summary = (record.summary or "").strip()
            if not summary:
                continue
            found.append((record.id, record.name, summary[:MAX_SUMMARY_CHARS]))
        return found


_META_PROMPT = """你是知识库的提示词工程师。
下面是一个知识库**已有文档的摘要清单**，你要据此写出这个库的「回答要求」
——它会被放进助手每次回答这个库的问题时的系统提示词里。

必须遵守，一条都不能破：

1. **这些摘要是你唯一的依据**。你没有读过原文，也**不许**利用你自己的领域知识
   补充任何内容——哪怕你知道某个标准、某个结论"应该"是什么样。
2. **摘要里没有的具体事实，一个字都不许写**。特别点名这几类，它们最容易
   被"顺手补一个像样的"：数字、阈值、比例、剂量、年份、机构名、期刊名、
   药物名、产品名、标准或法规编号。宁可少写一句，也不要写一个编出来的。
3. 凡是写了具体事实的句子，**句尾标出它出自哪一篇**，格式为 `[来源: 文件名]`
   （文件名照抄清单里的写法）。标不出来的事实，就删掉它。
   如果你需要在正文里**说明这个标注格式**，请照抄 `[来源: 文件名]` 这七个字
   （用「文件名」代表任意一篇），不要写成别的样子——这一串是约定的占位符。
4. 摘要里不足以判断的方面，**直接不提**。不许用「通常」「一般来说」「一般建议」
   这类措辞把不知道的东西说圆——那是把不确定性伪装成了结论。
5. 语气专业、克制。这段文字是写给系统看的，不是写给最终用户看的。

按下面五节写，每节一到两句，**除了这五节不要再写别的**：

- 角色：你是……领域的助手（依据摘要能看出的领域，写不准就写宽一点）
- 资料范围：这个库收录的是……
- 专业口径：术语、单位、表述按……（有依据才写这一节，没有就写「按原文表述」）
- 回答要求：回答时……（结构、详略、是否要给出处）
- 拒答规则：资料里没有的内容……

**直接输出这段提示词本身**：不要前言、不要说明你做了什么、不要用代码块包裹、
不要重复我这套要求。"""


def _build_user_prompt(docs: list[tuple[str, str, str]]) -> str:
    blocks = []
    for index, (_doc_id, name, summary) in enumerate(docs, start=1):
        blocks.append(f"【{index}】文件名：{name}\n摘要：{summary}")
    body = "\n\n".join(blocks)
    return (
        f"这个知识库有 {len(docs)} 篇文档，摘要如下"
        f"（最多列出 {MAX_DOCS} 篇，每篇摘要截断到 {MAX_SUMMARY_CHARS} 字）：\n\n{body}"
    )


def _clean(raw: str) -> str:
    """去掉模型习惯性加的外壳：整段代码块、开场的"好的，以下是为……"。

    只处理这两种**确定的**包装。不做"猜哪句是废话"这类启发式删除——
    那会把用户真正要的内容删掉，而删错比留一句客套话严重得多。
    """
    text = (raw or "").strip()
    fence = re.fullmatch(r"```[a-zA-Z]*\s*(.*?)\s*```", text, flags=re.S)
    if fence:
        text = fence.group(1).strip()
    return text


def _draft(prompt: str, docs: list[tuple[str, str, str]]) -> KBPromptDraft:
    """把 `[来源: 文件名]` 解析回文档，并揪出**指向不存在文件的引用**。"""
    cited_raw = [match.strip() for match in _CITATION.findall(prompt)]
    by_name = {name: name for _doc_id, name, _summary in docs}
    # 文件名可能被模型稍作改动（补了扩展名、去了后缀），所以做一次宽松匹配：
    # 完全相同 > 一份是另一份的前缀。都匹配不上才算"指向不存在文件"。
    unknown: list[str] = []
    resolved: set[str] = set()
    for cited in cited_raw:
        # 格式占位符跳过：那是模型在**说明标注格式**，不是引了某篇
        if cited in _PLACEHOLDER_CITATIONS:
            continue
        hit = by_name.get(cited)
        if hit is None:
            hit = next(
                (name for name in by_name if name.startswith(cited) or cited.startswith(name)),
                None,
            )
        if hit is None:
            unknown.append(cited)
        else:
            resolved.add(hit)
    sources = [
        KBPromptSource(document_id=doc_id, name=name, summary=summary, cited=name in resolved)
        for doc_id, name, summary in docs
    ]
    return KBPromptDraft(prompt=prompt, sources=sources, unknown_citations=unknown)
