"""工具循环：一轮对话的**主流程**（P0）。

这是把"知识库检索框架"换成"个人 Agent 框架"的那一处改动。两条链路的分野：

- **旧链路**（`ChatService.answer_agent_stream` 的检索分支）：先判定意图 → 改写检索词 →
  检索若干轮 → 把资料塞进提示词 → 作答。资料是**预设进提示词**的，模型只能"读"；
  它能做的唯一动作就是"再检索一次"。
- **这条链路**：给模型一批工具（原生 tool calling），它自己决定查什么、做什么、
  要不要查第二次；**资料是它取回来的工具结果**，不是我们塞给它的上下文。

四个设计取舍：

1. **工具集与内置 MCP 服务共用一份实现**（`app/mcp_server/tools.py`）。13 个内置工具
   对外走 MCP、对内由这里调用——一处实现两个门。所以"知识库降级成工具"几乎是免费的：
   `search` 早就是其中一个工具了，只是以前对话循环没走它。
2. **工具那几步不走流式**：它们产出的是"调哪个工具、参数是什么"这种结构化片段，
   流式拼装只会引入"半截 JSON"这一类错误。**最后那段正文仍然流式**——代价是收尾多一次
   请求，换来的是正文与思考照旧逐字出来，而这两块正是用户真正在看的东西。
3. **事件形状与旧链路一致**（StepEvent / SourcesEvent / ThinkingEvent / DeltaEvent /
   DoneEvent）：协议层与界面不用为这次换框架改动，出处（SourcesEvent）也照旧发——
   用了资料就该给出处，这一点不因框架变化而丢。
4. **工具报错如实回到循环**：不吞、不伪造结果。模型看到错误才能改路子；
   把失败包装成"空结果"会让它以为查过了没有，然后基于错误前提继续推理。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # 只为标注：chat.py 反过来要用这个模块（工具循环是它的主流程）
    from app.services.chat import SourceRef

from app.services.agent import (
    DeltaEvent,
    DoneEvent,
    SourcesEvent,
    StepEvent,
    ThinkingEvent,
)
from app.services.llm import ChatError, ChatMessage, LLMReply, ToolCall, ToolSpec

__all__ = ["DEFAULT_MAX_STEPS", "ToolLoop", "tool_label"]

logger = logging.getLogger(__name__)

#: 一轮里最多几步工具调用。
#:
#: 为什么是 6：常见的一轮是"查库 → 补查一次 → 作答"（2–3 步）。给到 6 是留出
#: 写笔记、看技能、派子 Agent 的组合空间，同时挡住"模型反复调同一个工具"那种死循环
#: ——每一步都是一次真实请求，没有上限就会一直烧下去。
DEFAULT_MAX_STEPS = 6

#: 单个工具结果的字符上限。超了截断并**明确告诉模型被截了**：
#: 悄悄截断会让它以为"这就是全部"，而截断常常正好丢在它要的那一段之后。
MAX_RESULT_CHARS = 12000

#: 工具名 → 中文步骤名（过程面板显示的就是它）。
#:
#: 不做成"从工具定义里取 description"：那是**写给模型看的**（说清何时该用），
#: 比给用户看的标签长得多。这两个受众要的东西不一样。
_LABELS = {
    "search": "检索知识库",
    "list_knowledge_bases": "查看知识库",
    "create_knowledge_base": "新建知识库",
    "upload_document": "上传文档",
    "add_data_source": "添加数据源",
    "list_documents": "查看文档列表",
    "get_document_status": "查询文档状态",
    "delete_document": "删除文档",
    "create_note": "写笔记",
    "attach_note_to_kb": "把笔记加入知识库",
    "list_notes": "查看笔记",
    "recall": "回忆",
    "remember": "记住",
    "list_skills": "查看技能目录",
    "read_skill": "读技能",
    "spawn_subagent": "派子 Agent",
}


def tool_label(name: str) -> str:
    """工具名 → 界面上的中文步骤名。

    两类回退：

    - **外部 MCP 工具**（``mcp__<服务>__<工具>``）→ ``外部工具：服务 · 工具``。
      不显示成 ``mcp__tavily__search``：过程面板是给用户看的，限定名是协议层的东西，
      而"哪个服务的哪个工具"才是他想知道的；
    - 其余未知工具**回退到原名**（不隐藏它）：看得见一个陌生名字，
      也比看不见它强——那意味着"有件事发生了但界面没说"。
    """
    known = _LABELS.get(name)
    if known:
        return known
    parts = (name or "").split("__", 2)
    if len(parts) == 3 and parts[0] == "mcp" and parts[1] and parts[2]:
        return f"外部工具：{parts[1]} · {parts[2]}"
    return name


@dataclass(frozen=True, slots=True)
class ToolOutcome:
    """一次工具调用的结果。"""

    content: str
    """回给模型的文本（已经是字符串：工具返回结构体时由这里序列化）。"""

    sources: list[SourceRef] = field(default_factory=list)
    """检索类工具带回的出处。只有它会让界面多出一排引用。"""

    summary: str = ""
    """过程面板上的那一行说明（人话）。

    **与 `content` 分开**：`content` 是给模型的结构化结果（常常是 JSON），
    直接显示会把界面变成一屏转义字符。工具自己最清楚"这次拿到了什么"，
    所以摘要由它给（如「23 篇文档」「命中 8 段」）。
    """

    def step_detail(self, limit: int = 120) -> str:
        """过程面板的那一行：优先用工具给的摘要，没有才回退到结果开头。"""
        text = self.summary or " ".join(self.content.split())
        text = " ".join(text.split())
        return text[:limit] + ("…" if len(text) > limit else "")


#: 执行一个工具：``(工具名, 参数字典) -> ToolOutcome``。
#: 由组合根绑定（见 ``api``/``core.services``），循环自己不认识 Services。
ToolRunner = Callable[[str, dict[str, Any]], ToolOutcome]


class ToolLoop:
    """把"模型 → 工具 → 模型"跑到出正文为止。"""

    def __init__(
        self,
        *,
        client_factory: Callable[[], Any],
        tools: Sequence[ToolSpec],
        runner: ToolRunner,
        max_steps: int = DEFAULT_MAX_STEPS,
    ) -> None:
        self._client_factory = client_factory
        self._tools = list(tools)
        self._runner = runner
        self._max_steps = max(1, max_steps)

    @property
    def tools(self) -> list[ToolSpec]:
        return list(self._tools)

    def run(
        self,
        *,
        messages: list[ChatMessage],
        emit_prefix: Iterator[object] | None = None,
    ) -> Iterator[object]:
        """跑完一轮，产出事件流。

        ``messages`` 是**已经拼好的**（system + 历史 + 本轮问题）；
        循环只往它后面追加助手与工具消息。
        """
        if emit_prefix is not None:
            yield from emit_prefix

        if not self._tools:
            # 一个工具都没有（例如没绑 runner 的单测环境）：直接作答，
            # 不要装作"考虑过用工具"
            yield from self._answer(messages)
            return

        for step in range(self._max_steps):
            try:
                reply: LLMReply = self._client_factory().complete_with_tools(
                    messages, self._tools
                )
            except ChatError:
                # 模型不可用**必须如实抛**：静默收尾会变成一条空回答
                raise
            if not reply.wants_tools:
                # 它决定直接答了。**这一步的正文不直接用**——正文那段要流式出来
                # （见模块头第 2 条），所以再走一次流式调用
                yield from self._answer(messages)
                return

            messages.append(
                ChatMessage(role="assistant", content=reply.text, tool_calls=reply.tool_calls)
            )
            last = step == self._max_steps - 1
            for call in reply.tool_calls:
                yield StepEvent(
                    phase="tool", label=tool_label(call.name), status="running"
                )
                outcome = self._execute(call, last=last)
                if outcome.sources:
                    yield SourcesEvent(sources=outcome.sources)
                messages.append(
                    ChatMessage(
                        role="tool", content=outcome.content, tool_call_id=call.id
                    )
                )
                yield StepEvent(
                    phase="tool",
                    label=tool_label(call.name),
                    detail=outcome.step_detail(),
                )

        # 步数用完还没收口：**如实说**，让模型基于已有信息作答，
        # 而不是把"没跑完"包装成"跑完了"
        yield StepEvent(
            phase="tool",
            label="工具步数已达上限",
            detail=f"本轮最多 {self._max_steps} 步，按现有信息作答",
        )
        yield from self._answer(messages)

    # ------------------------------------------------------------------ 内部

    def _execute(self, call: ToolCall, *, last: bool) -> ToolOutcome:
        """执行一次调用。**所有失败都变成回给模型的文本**，不往上抛。

        抛出去会让整轮失败；而工具失败（参数不对、库里没有、服务连不上）
        通常是**模型能自己纠正**的——把它当结果回给它，它下一轮换个法子。
        """
        if last:
            # 最后一步还调工具：不执行了，直接告诉它没机会了，
            # 省下一次真实调用（它通常只是想再确认一遍）
            return ToolOutcome(content="（本轮工具步数已用完，请直接给出回答）")
        try:
            args = _parse_arguments(call.arguments)
        except ValueError as exc:
            return ToolOutcome(content=f"工具参数不是合法 JSON：{exc}")
        try:
            outcome = self._runner(call.name, args)
        except Exception as exc:  # 工具是外部世界，什么都能抛
            logger.info("工具 %s 执行失败：%s", call.name, exc)
            return ToolOutcome(content=f"工具执行失败：{exc}")
        return _truncate(outcome)

    def _answer(self, messages: list[ChatMessage]) -> Iterator[object]:
        """流式产出正文与思考（与旧链路的收尾完全一致）。

        **"组织回答"这一步必须发出来**：它是真实发生的动作；少了它，一轮
        "没调工具、直接回答"的消息在界面上会变成**零步骤**——而界面在零步骤时会
        退回一条兜底（历史上那套"检索 + 生成"两步），于是凭空画出一条"检索知识库"，
        用户看到的现象就是"我明明没开知识库，它为什么去检索了"（实测报过来的就是这个）。
        """
        yield StepEvent(phase="answer", label="组织回答", status="running")
        parts: list[str] = []
        for delta in self._client_factory().stream_events(messages):
            if delta.reasoning:
                yield ThinkingEvent(text=delta.reasoning)
            if delta.text:
                parts.append(delta.text)
                yield DeltaEvent(text=delta.text)
        yield DoneEvent(answer="".join(parts))


def _parse_arguments(raw: str) -> dict[str, Any]:
    """把模型给的参数解析成 dict。

    容忍三种现实里常见的偏差：空串（无参工具）、``null``、以及被包了一层的
    字符串化 JSON——其余一律当错误回给模型，让它自己改。
    """
    text = (raw or "").strip()
    if not text or text == "null":
        return {}
    try:
        parsed = json.loads(text)
    except ValueError as exc:
        raise ValueError(str(exc)) from exc
    if isinstance(parsed, dict):
        return parsed
    if isinstance(parsed, str):
        # 有些模型会把参数对象再序列化一层
        try:
            inner = json.loads(parsed)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        if isinstance(inner, dict):
            return inner
    raise ValueError(f"参数应当是对象，收到 {type(parsed).__name__}")


def _truncate(outcome: ToolOutcome) -> ToolOutcome:
    """超长结果截断，并**明确标注**截断（见 ``MAX_RESULT_CHARS``）。"""
    if len(outcome.content) <= MAX_RESULT_CHARS:
        return outcome
    keep = outcome.content[:MAX_RESULT_CHARS]
    return ToolOutcome(
        content=f"{keep}\n\n（结果过长已截断，以上是前 {MAX_RESULT_CHARS} 字）",
        sources=outcome.sources,
    )
