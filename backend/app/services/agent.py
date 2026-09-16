"""智能问答的 Agent 工作流（v20）。

链路：**意图识别 → 检索词优化 → 多轮检索工具 → 组织回答**。

为什么需要它：原来的链路是"拿用户原话去向量检索一次，然后作答"。用户的原话常常
不适合检索——带指代（"它的上限呢"）、带口语（"帮我看看…"）、一词多义；检索没命中时
也没有第二次机会，模型只能回"资料中没有找到"。这里参考主流知识库的做法补上三步：
先理解意图、再把问题改写成检索友好的短查询、命中不够时让模型**再调用检索工具**换角度找。

**工具调用为什么用提示词 + JSON，而不是原生 function calling**（重要）：
本项目的对话端点来自"模型注册表"，用户填什么地址都可能——有的支持 ``tools``，
有的只支持老式 ``functions``，有的两者都不支持但能听懂自然语言。原生工具调用的
方言差异会让"换一家模型就不能用"。所以把检索工具**描述成一段提示词**，让模型
用固定 JSON 表态（``{"action":"search",...}``），再由我们解析执行。代价是模型
可能输出不合格式的 JSON——因此每条规划调用都**失败即降级**：解析不了就退回
"原问题单轮检索"，绝不让整轮问答失败。

本模块只放**纯逻辑**：提示词、数据结构、解析函数、事件类型。检索与模型调用留在
``services/chat.py``（那里才拿得到检索服务与配置），这样本模块不依赖任何服务，
也就不会与 chat.py 形成循环导入。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # 只为类型标注；运行时不需要，避免与 chat.py 循环导入
    from app.services.chat import SourceRef

__all__ = [
    "AgentDecision",
    "AgentPlan",
    "DeltaEvent",
    "DoneEvent",
    "SourcesEvent",
    "StepEvent",
    "ThinkingEvent",
    "intent_label",
    "parse_decision",
    "parse_plan",
]

#: 单次改写最多接受几条查询：多了会把检索成本乘上去，收益却很小。
MAX_PLAN_QUERIES = 3
#: 单条查询的长度上限（字）。检索是短查询的游戏，太长反而稀释语义。
MAX_QUERY_CHARS = 60

#: 意图取值 → 中文标签。未知取值一律按 factual 处理，不报错。
_INTENT_LABELS = {
    "factual": "查事实",
    "comparison": "对比",
    "summary": "总结",
    "howto": "方法步骤",
    "chat": "寒暄",
}

#: 规划提示词。要求**只输出一个 JSON 对象**：没有原生工具调用兜底时，
#: 这是我们能拿到结构化结果的唯一可靠办法。语气上强调"不要解释、不要代码块围栏"，
#: 因为模型很爱把 JSON 包在 ```json 里。
PLAN_PROMPT = (
    "你在为一个知识库问答系统做检索前的处理。给你用户的问题与最近的对话，完成两件事。\n"
    "1. 判断意图 intent，只能取以下之一：factual（查具体事实）、comparison（对比多个对象）、"
    "summary（总结归纳）、howto（方法/步骤）、chat（寒暄或与资料无关）。\n"
    f"2. 把问题改写成 1~{MAX_PLAN_QUERIES} 条**适合向量检索**的短查询："
    "补全省略与指代、去掉口语和客套、必要时做同义扩展；"
    f"每条不超过 {MAX_QUERY_CHARS} 字，不要出现「请问」「帮我」这类词。\n"
    "只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。格式：\n"
    '{"intent":"factual","queries":["查询一","查询二"],"need_retrieval":true,"reason":"一句话"}'
)

#: 多轮决策提示词。把"检索"描述成模型可以主动调用的工具——
#: 这是 §"工具调用为什么用提示词" 的做法。``{findings}`` 与 ``{tried}`` 由调用方填充。
DECIDE_PROMPT = (
    "你是一个检索 Agent。你可以调用的工具只有一个：\n"
    "  search_knowledge_base(query: string) —— 在知识库中做一次向量检索，返回若干资料片段。\n"
    "已知信息：\n"
    "【知识库概况】\n{library}\n\n"
    "【已检索到的资料摘要】\n{findings}\n\n"
    "【已经用过的检索词】{tried}\n\n"
    "判断这些资料是否足以回答用户的问题。如果不足，给出**下一条**检索查询：换一个角度、"
    "换关键词或补充限定，**不要重复已用过的词**。如果已经够了，就直接进入作答。\n"
    "**看清知识库概况**：如果命中的文档与问题方向明显无关，说明这个库本来就可能没有"
    "相关资料——那种情况直接作答并说明，不要靠换词反复试探（那只会在无关内容里越挖越远）。\n"
    "只输出一个 JSON 对象，不要解释，不要 Markdown 代码块：\n"
    '{"action":"search","query":"..."} 或 {"action":"skill","name":"..."}'
    ' 或 {"action":"answer","reason":"一句话"}'
)


@dataclass(frozen=True, slots=True)
class AgentPlan:
    """检索前的规划结果。"""

    intent: str
    queries: list[str] = field(default_factory=list)
    need_retrieval: bool = True
    reason: str = ""


@dataclass(frozen=True, slots=True)
class AgentDecision:
    """一轮"要不要再检索"的决策。"""

    action: str  # "search" | "skill" | "answer"
    query: str = ""
    """``search`` 时是检索词；``skill`` 时是技能名（复用一个字段是有意的：
    两者都是"这一步要操作的对象"，各开一个字段会让每个消费点都得判两遍）。"""
    reason: str = ""


# --------------------------------------------------------------------- 事件
# 服务层内部的进度事件，由 api/v1/chat.py 翻成 SSE 的 type 字段。
# 用 dataclass 而不是裸 dict：事件形状是这条链路的对外契约，写死类型才能在改动时被
# 类型检查与测试拦住（协议层负责序列化，服务层不碰 wire format）。


@dataclass(frozen=True, slots=True)
class StepEvent:
    """工作流里的一个步骤（意图、改写、第 N 轮检索、组织回答）。"""

    phase: str
    label: str
    detail: str = ""
    status: str = "done"  # "running" | "done"
    degraded: bool = False
    """这一步**没按设计跑成**，走了降级路径（目前只有"规划不可用"一种）。

    用独立字段而不是把话写进 ``detail``：界面要据此给一个**重试入口**——
    多轮检索是加分项，规划失败时用户应当能自己再要一次，
    而不是只能接受这次退化的结果、还得自己猜"为什么这次答得不一样"。
    """
    added: int | None = None
    """本步带来的**新增**资料条数（只有检索步骤有）。

    多轮检索最常见的一种浪费是"又搜了一轮，什么新东西都没找到"——
    这个数让界面能如实说出来，也让循环能在下一轮之前停下来
    （见 ``ChatService.answer_agent_stream``）。
    """


@dataclass(frozen=True, slots=True)
class SourcesEvent:
    """当前累计的资料出处（多轮检索会多次发出，始终是累计列表）。"""

    sources: list[SourceRef] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class ThinkingEvent:
    """思考过程增量（推理模型的 reasoning_content）。"""

    text: str


@dataclass(frozen=True, slots=True)
class DeltaEvent:
    """正文增量。"""

    text: str


@dataclass(frozen=True, slots=True)
class DoneEvent:
    """回答结束，带后端拼装好的全文。"""

    answer: str


def intent_label(intent: str) -> str:
    """把意图代号翻成界面上的中文；未知取值按 factual 兜底。"""
    return _INTENT_LABELS.get(intent, _INTENT_LABELS["factual"])


def _extract_json(text: str) -> dict | None:
    """从模型输出里抠出第一个 JSON 对象。

    模型常常在 JSON 外面包一层解释或 ``` 围栏，严格的 ``json.loads(text)`` 会失败。
    这里用括号配对扫描而不是正则：正则很难正确处理字符串里的花括号
    （比如查询词里就有一个 "{"）。
    """
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    body = json.loads(text[start : index + 1])
                except ValueError:
                    return None
                return body if isinstance(body, dict) else None
    return None


def _clean_queries(raw: object) -> list[str]:
    """清洗模型给出的查询列表：只留非空字符串、去重、截断、限条数。"""
    if not isinstance(raw, list):
        return []
    seen: set[str] = set()
    result: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        query = " ".join(item.split())[:MAX_QUERY_CHARS].strip()
        if not query or query in seen:
            continue
        seen.add(query)
        result.append(query)
        if len(result) >= MAX_PLAN_QUERIES:
            break
    return result


def parse_plan(text: str) -> AgentPlan | None:
    """解析规划输出；格式不对返回 ``None``（调用方据此降级，而不是抛错）。"""
    body = _extract_json(text)
    if body is None:
        return None
    intent = body.get("intent")
    intent = intent if isinstance(intent, str) and intent in _INTENT_LABELS else "factual"
    queries = _clean_queries(body.get("queries"))
    # need_retrieval 缺省视为 True；只有模型明确说 false，或意图是寒暄时才不检索
    need = body.get("need_retrieval")
    need_retrieval = True if need is None else bool(need)
    if intent == "chat":
        need_retrieval = False
    reason = body.get("reason")
    return AgentPlan(
        intent=intent,
        queries=queries,
        need_retrieval=need_retrieval,
        reason=reason if isinstance(reason, str) else "",
    )


def parse_decision(text: str) -> AgentDecision | None:
    """解析多轮决策；格式不对或动作非法返回 ``None``。"""
    body = _extract_json(text)
    if body is None:
        return None
    action = body.get("action")
    if action == "answer":
        reason = body.get("reason")
        return AgentDecision(action="answer", reason=reason if isinstance(reason, str) else "")
    if action == "search":
        query = body.get("query")
        if not isinstance(query, str):
            return None
        query = " ".join(query.split())[:MAX_QUERY_CHARS].strip()
        if not query:
            return None
        return AgentDecision(action="search", query=query)
    if action == "skill":
        name = body.get("name")
        if not isinstance(name, str) or not name.strip():
            return None
        # 名字只做**长度与字符**的清洗；能不能找到由服务层说了算——
        # 那里才知道有哪些技能，也才能给出"没有这个技能"的可读报错。
        return AgentDecision(action="skill", query=" ".join(name.split())[:80].strip())
    return None
