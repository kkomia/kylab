"""工具循环：一轮对话的**主流程**（P0）。

这是把"知识库检索框架"换成"个人 Agent 框架"的那一处改动。与它对照的旧链路
（`ChatService.answer_agent_stream`：先判定意图 → 改写检索词 → 检索若干轮 →
把资料塞进提示词 → 作答，资料是**预设进提示词**的，模型唯一能做的动作是"再检索一次"）
在 v0.2 已整体删除，那次对照留在 git 历史与《开发计划》§12.172 里。

- **这条链路**：给模型一批工具（原生 tool calling），它自己决定查什么、做什么、
  要不要查第二次；**资料是它取回来的工具结果**，不是我们塞给它的上下文。

四个设计取舍：

1. **工具集与内置 MCP 服务共用一份实现**（`app/services/tools.py`）。13 个内置工具
   对外走 MCP、对内由这里调用——一处实现两个门。所以"知识库降级成工具"几乎是免费的：
   `search` 早就是其中一个工具了，只是以前对话循环没走它。
2. **工具那几步不走流式**：它们产出的是"调哪个工具、参数是什么"这种结构化片段，
   流式拼装只会引入"半截 JSON"这一类错误。**最后那段正文仍然流式**——代价是收尾多一次
   请求，换来的是正文与思考照旧逐字出来，而这两块正是用户真正在看的东西。
3. **事件形状与旧链路一致**（StepEvent / SourcesEvent / ThinkingEvent / DeltaEvent /
   DoneEvent）：协议层与界面不用为这次换框架改动，出处（SourcesEvent）也照旧发——
   用了资料就该给出处，这一点不因框架变化而丢。**旧链路删除后，"一致"的对象没有了，
   但这五个事件类型本身是现行契约**（`services/agent.py`），由本模块产出、
   由 `api/v1/chat.py` 翻成 SSE。
4. **工具报错如实回到循环**：不吞、不伪造结果。模型看到错误才能改路子；
   把失败包装成"空结果"会让它以为查过了没有，然后基于错误前提继续推理。
5. **一批里的几件事并发跑**（v0.27）：模型会把互不依赖的调用放在同一条消息里
   （见 ``services/chat.py`` 的系统提示词第 2 条），等它们的常常是同一个网络。
   串行执行时一批三页网页就是三页之和。事件与消息的顺序仍然确定：
   **running 全发 → 并发执行 → 结果按调用顺序回灌**（见 ``_execute_batch``）。
6. **思考一路开着**（v0.27 试过关掉，撤了）：选工具那一步是这条链路上次数最多的模型
   调用，实测关掉能让单次往返从 1.18s 降到 0.68s——但多步循环里真正决定快慢与好坏的是
   "下一步做什么、能不能几件事一起发、这条路走不通换哪条"，那些判断都出在思考里。
   厂商的协议也是这个意思：思考模式下带工具调用的助手消息要带着推理往后传
   （见 ``llm.ChatMessage.reasoning``），关掉等于每轮把它的计划擦一次。
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # 只为标注：chat.py 反过来要用这个模块（工具循环是它的主流程）
    from app.services.chat import SourceRef

from app.core.logging import sanitize_log_value
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
#: **v0.25 从 6 提到 30**。原注释的理由是"常见的一轮是 2–3 步，给 6 足够"——
#: 那是在只有检索一个工具的时候估的。现在一轮里可能有联网搜索、抓网页、读笔记、
#: 查文档状态、派子 Agent 的组合，实测**正常提问就会撞到 6**，
#: 撞上之后界面会说"工具步数用尽，按现有资料作答"——用户看到的是一个突然变差的回答。
#:
#: 30 是"实际用不到、但也不会失控"的量级：真正的一轮长这样也不会超过十几步，
#: 而它仍然挡得住"模型反复调同一个工具"那种死循环（每一步都是一次真实请求，
#: 没有上限就会一直烧下去）。**上限本身不能取消**，这是钱的问题，不是洁癖。
#: 需要更高就把 `ToolLoop(max_steps=...)` 传大——组合根在 `services/chat.py`。
DEFAULT_MAX_STEPS = 30

#: 一轮的**墙钟上限**（秒）。与步数上限是两道独立的闸（子 Agent 里那两道同源，见
#: `services/subagent.py` 的 `MAX_SECONDS`）：
#:
#: - **步数**挡的是"来回很多次"——每一次都真实花钱；
#: - **时间**挡的是"某一步卡很久"——一次工具调用慢下来（抓一个不响应的网页、
#:   外部 MCP 卡在网络上、模型端排队），步数一动不动地耗着，而用户那边只能看着转圈。
#:   没有这道闸时，最坏情况是 `步数 × 单次超时`：30 步 × 120 秒不是理论值，
#:   而是"每次调用都接近超时"时真会发生的事。
#:
#: 300 秒是"认真查一轮够用、不正常的一轮会被拦住"的量级：正常一轮（联网搜几次 +
#: 抓两三个网页 + 派一个子 Agent）实测在 1~2 分钟内；子 Agent 自己有 90 秒的上限，
#: 所以这道闸主要是兜"主循环一步一步慢慢挪"和"工具卡住"。
#: **它不替代工具的自身超时**（那是每个工具自己的事，见 `llm.DEFAULT_TIMEOUT_SECONDS`）。
DEFAULT_MAX_SECONDS = 300.0

#: 单个工具结果的字符上限。超了截断并**明确告诉模型被截了**：
#: 悄悄截断会让它以为"这就是全部"，而截断常常正好丢在它要的那一段之后。
MAX_RESULT_CHARS = 12000

#: 一次工具调用**发给界面的**原文上限（入参与结果各一份）。
#:
#: 远小于 `MAX_RESULT_CHARS`（给模型的 12000）：那个是模型的上下文预算，
#: 而这个只是"用户点开看一眼这一步调了什么"。12000 字塞进 SSE 会让长会话的
#: 事件流大出一个量级，而没人会读完它——截断处如实标注。
MAX_STEP_PREVIEW_CHARS = 2000

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
    "export_document": "导出文档",
    "export_table": "导出表格",
    "export_deck": "导出幻灯",
    "ingest_artifact": "存进知识库",
    "web_search": "联网搜索",
    "web_fetch": "抓取网页",
    "list_skills": "查看技能目录",
    "read_skill": "读技能",
    "spawn_subagent": "派子 Agent",
    # 这台机器上的能力（v0.33）：文件、执行、表格、定时任务。
    # 名字要说清**它替我做了什么**（"读文件"而不是 "read_file"）：过程面板是给用户看的，
    # 而他对这几个动作的第一反应是"它在我电脑上干什么了"
    "list_files": "查看文件",
    "read_file": "读文件",
    "search_files": "在文件里搜",
    "run_command": "执行命令",
    "list_tables": "查看表格",
    "query_table": "查表格",
    "schedule_task": "挂定时任务",
    "list_scheduled_tasks": "查看定时任务",
}


#: 同一批里最多同时跑几个工具。
#:
#: 与 ``services/tools.py`` 里"``web_fetch`` 一次最多 5 个网址"同一个量级——
#: 那个数是提示词里写给模型看的，批次也就这么大。**不是无限**：抓网页那个工具
#: 自己还会并发（最多 5），两层乘起来就是 25 个同时飞的请求，而它们背后是同一台
#: 机器、同一个出口。超过这个数的批次分两波跑，慢一点，但不会把网络打满。
MAX_PARALLEL_TOOLS = 5


def _clip(text: str, limit: int) -> str:
    """按字符截断并**如实标注**——不说的话，用户会以为工具只返回了这么多。"""
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…（共 {len(text)} 字，已截断）"


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

    artifacts: list[dict[str, object]] = field(default_factory=list)
    """这一步**产出的文件**（导出类工具）。空 = 这一步没产出文件。

    与 ``sources`` 对称：一个是读到了什么，一个是产出了什么。
    界面拿它挂文件卡片（可点、可下载），而不是只在步骤说明里写一句
    "已存进知识库"——那句话没有落点，用户还得自己去列表里找。
    """

    summary: str = ""
    """过程面板上的那一行说明（人话）。

    **与 `content` 分开**：`content` 是给模型的结构化结果（常常是 JSON），
    直接显示会把界面变成一屏转义字符。工具自己最清楚"这次拿到了什么"，
    所以摘要由它给（如「23 篇文档」「命中 8 段」）。
    """

    added: int | None = None
    """这一步带回的**新增**资料条数（``None`` = 这不是检索类调用）。

    **"新增"是相对这一轮已经给过的那些算的**，所以"又查了一次但什么都没多出来"
    是 ``0`` 而不是别的数——界面靠它把那一步显示成"这轮没找到新资料"。
    由执行器算而不是循环自己比：只有它知道这一批里哪些是刚去重过的
    （见 ``app/services/agent_tools.py::_absorb``）。
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
        max_seconds: float = DEFAULT_MAX_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client_factory = client_factory
        self._tools = list(tools)
        self._runner = runner
        self._max_steps = max(1, max_steps)
        # 至少给 1 秒：0 或负数会让每一轮一进来就"时间已用尽"，
        # 那不是"关掉这道闸"，而是"把工具整个关掉"——想关就传一个大数
        self._max_seconds = max(1.0, max_seconds)
        # 时钟可注入：用例不必真的 sleep 到超时（也就能测"跨过上限的那一步")
        self._clock = clock

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

        # 墙钟从**这一轮开始**算，不从对象构造算：`ToolLoop` 可能被复用，
        # 而"这一轮用了多久"才是用户能感知的那个量
        started_at = self._clock()

        for step in range(self._max_steps):
            if self._expired(started_at):
                # 时间到：不再开新的一轮 LLM 调用（它自己也要时间），
                # 直接收尾作答。**与步数用尽走同一条降级路径**——用户看到的东西一样，
                # 只是原因不同（见下面那条 StepEvent 的措辞）。
                yield self._timeout_step(started_at)
                yield from self._answer(messages)
                return
            try:
                # 选工具这一轮**与作答用同一个客户端、同一档思考**：多步循环里
                # "下一步做什么、能不能几件事一起发、失败了换哪条路"都出在这几次调用上，
                # 关掉思考省下的那点往返会在这里加倍还回去（§12.199 试过、撤了）。
                reply: LLMReply = self._client_factory().complete_with_tools(messages, self._tools)
            except ChatError:
                # 模型不可用**必须如实抛**：静默收尾会变成一条空回答
                raise
            if not reply.wants_tools:
                # 它决定直接答了。**这一步的正文不直接用**——正文那段要流式出来
                # （见模块头第 2 条），所以再走一次流式调用
                yield from self._answer(messages)
                return

            messages.append(
                ChatMessage(
                    role="assistant",
                    content=reply.text,
                    tool_calls=reply.tool_calls,
                    # **思考要跟着这条消息回去**：端点（DeepSeek 实测）在思考模式下
                    # 要求带工具调用的助手消息把 reasoning_content 传回来，
                    # 缺这个字段的那一轮请求直接 400——那时工具都调完了，
                    # 用户只看到一句失败（见 llm.ChatMessage.reasoning）
                    reasoning=reply.reasoning,
                )
            )
            last = step == self._max_steps - 1
            # 两道闸共用"这一批不执行"这条路，但**理由要分开告诉模型**：
            # 它下一轮得知道是"步数没了"还是"时间没了"（两者的应对不一样）
            stop: str | None = None
            if last:
                stop = "本轮工具步数已用完"
            elif self._expired(started_at):
                stop = "本轮时间已用尽"
            calls = list(reply.tool_calls)
            # 先把这一批的 `running` **全发出去**，再执行。
            #
            # 并发之后"一条 running 紧跟一条 done"不再成立（谁先跑完谁先回），
            # 而界面把 `done` 合进"同名的第一条 running"（见前端 `mergeStep`）——
            # 事件顺序乱了就会出现错位的步骤行。所以顺序在这里定死：
            # **running 按调用顺序发全 → 执行 → done 也按调用顺序发**。
            # 用户看到的是"这几件事同时在跑"，而不是几行闪来闪去的占位。
            for call in calls:
                # `tool` 是**原始工具名**（不是人话标签）：界面按它选图标、把同类调用并成
                # 一组。放在这里而不是让界面猜 label——label 是给人看的，会被改写
                yield StepEvent(
                    phase="tool", label=tool_label(call.name), tool=call.name, status="running"
                )
            outcomes = self._execute_batch(calls, stop=stop)
            merged = _merge_sources(outcomes)
            if merged:
                # **一批只发一条累计的出处**，而不是每条调用各发一条。
                # 发多条时"最后发的那条"未必是最全的那条（并发下先跑完的可能先发），
                # 界面只认最后一次，于是后发的那条会把先查到的资料盖掉——
                # 正是账本当初要解决的问题（见 agent_tools.build_runner）。
                yield SourcesEvent(sources=merged)
            for call, outcome in zip(calls, outcomes, strict=True):
                # 顺序必须与 `tool_calls` 一致：OpenAI 兼容端点要求每条调用都有结果，
                # 而"结果与调用怎么配对"靠的是 tool_call_id，不是顺序——但保持同序
                # 仍然是对端最容易处理的那种形状（也便于人读日志）。
                messages.append(
                    ChatMessage(role="tool", content=outcome.content, tool_call_id=call.id)
                )
                yield StepEvent(
                    phase="tool",
                    label=tool_label(call.name),
                    tool=call.name,
                    detail=outcome.step_detail(),
                    added=outcome.added,
                    # 入参与原文：界面默认只看 `detail` 那一行结论，
                    # 点开才看这两个（v0.25，照 Kimi 的"可以看每个工具调用的内容"）
                    args=_clip(call.arguments, MAX_STEP_PREVIEW_CHARS),
                    result=_clip(outcome.content, MAX_STEP_PREVIEW_CHARS),
                    artifacts=tuple(outcome.artifacts),
                )

        # 步数用完还没收口：**如实说**，让模型基于已有信息作答，
        # 而不是把"没跑完"包装成"跑完了"。
        #
        # `degraded=True` 就是这件事：这一轮**没按设计走完**（它还想继续查，
        # 但没机会了）。界面据此给出重试入口——"这次答得浅"与"链路退化了，
        # 你可以再要一次"对用户是两件事，不说清楚他只会觉得模型不行。
        yield StepEvent(
            phase="tool",
            label="工具步数已达上限",
            detail=f"本轮最多 {self._max_steps} 步，按现有信息作答",
            degraded=True,
        )
        yield from self._answer(messages)

    # ------------------------------------------------------------------ 内部

    def _expired(self, started_at: float) -> bool:
        """这一轮是否已经用满墙钟（见 `DEFAULT_MAX_SECONDS`）。"""
        return self._clock() - started_at >= self._max_seconds

    def _timeout_step(self, started_at: float) -> StepEvent:
        """时间到的那一步。措辞与步数用尽**分开**：用户看到"慢"和"多"要能区分——
        前者是这次的网络/服务慢，后者是这题要查的东西太多，下一步该做的事不一样。"""
        used = round(self._clock() - started_at)
        return StepEvent(
            phase="tool",
            label="本轮时间已用尽",
            detail=f"本轮最多 {int(self._max_seconds)} 秒，已用 {used} 秒，按现有信息作答",
            degraded=True,
        )

    def _execute(self, call: ToolCall, *, stop: str | None) -> ToolOutcome:
        """执行一次调用。**所有失败都变成回给模型的文本**，不往上抛。

        抛出去会让整轮失败；而工具失败（参数不对、库里没有、服务连不上）
        通常是**模型能自己纠正**的——把它当结果回给它，它下一轮换个法子。
        """
        if stop is not None:
            # 最后一步还调工具（或时间已经用完）：不执行了，直接告诉它没机会了，
            # 省下一次真实调用（它通常只是想再确认一遍）
            return ToolOutcome(content=f"（{stop}，请直接给出回答）")
        try:
            args = _parse_arguments(call.arguments)
        except ValueError as exc:
            return ToolOutcome(content=f"工具参数不是合法 JSON：{exc}")
        try:
            outcome = self._runner(call.name, args)
        except Exception as exc:  # 工具是外部世界，什么都能抛
            # 异常文本里可能带着模型给的参数（多行 JSON）：不转义的话，一条日志会被
            # 伪装成好几条，而多出来的那几行看起来像我们自己打的
            logger.info("工具 %s 执行失败：%s", call.name, sanitize_log_value(exc))
            return ToolOutcome(content=f"工具执行失败：{exc}")
        return _truncate(outcome)

    def _execute_batch(self, calls: Sequence[ToolCall], *, stop: str | None) -> list[ToolOutcome]:
        """执行**同一批**调用：互不依赖的几件事**并发**跑，返回顺序与传入一致。

        为什么并发（v0.27 实测的账）：模型现在会在一批里同时要三页网页、两个方向的
        检索——它自己说了这几件事互不依赖。串行执行时，一批三页网页的墙钟时间
        就是三页之和（实测抓页 0.4–1.2s/页），而它们之间**没有任何共享状态**，
        等的是同一个网络。一轮里 27 次调用、平均每批 2 个，省下来的是这个量级。

        三件事同时成立才敢这么做：

        1. **顺序在 ``run`` 里定死**（running 全发 → 执行 → done 按调用顺序发），
           并发只发生在"执行"这一段，事件流与消息顺序都还是确定的；
        2. **共享状态各自加锁**：来源账本（``agent_tools.build_runner`` 的 ``book``）
           与表格副本的 DuckDB 连接。没有这两处，两个检索线程会抢同一个编号、
           两条 SQL 会同时用同一个连接；
        3. **每条调用各自开 session**：外部 MCP 工具走 ``asyncio.run``（每次新建事件
           循环）、检索与抓网页走线程安全的连接池/共享 HTTP 客户端。
           **反过来说**：往这条路上加工具时要问一句"它在两个线程里同时跑会怎样"。

        单条调用不走线程池：那是常态，为它建池是白付一层开销（也少一处可出错的地方）。
        """
        if stop is not None or len(calls) <= 1:
            return [self._execute(call, stop=stop) for call in calls]
        with ThreadPoolExecutor(max_workers=min(len(calls), MAX_PARALLEL_TOOLS)) as pool:
            # `map` **保序返回**：谁先跑完不影响结果顺序，也就影响不到事件与消息的顺序
            return list(pool.map(lambda call: self._execute(call, stop=None), calls))

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


def _merge_sources(outcomes: Sequence[ToolOutcome]) -> list[SourceRef]:
    """把一批调用各自的出处快照并成**一份**（按 ``chunk_id`` 去重，按编号排序）。

    每一条快照都是"那一刻的账本"（``agent_tools.build_runner`` 的 ``book``，
    它是累计的），所以并集就是"这批跑完之后账本里的全部"。为什么不直接用最后
    一条快照：并发下"最后一条"是按**调用顺序**排的，而它对应的那次执行未必是最晚
    跑完的——按调用顺序取最后一条，会把最晚跑完那次带回来的资料丢掉。

    编号（``index``）在账本里是唯一的（去重 + 顺延编号都在锁里做），
    所以排序就是"编号升序"，与渲染给模型的 [n] 一一对应。
    """
    merged: dict[str, SourceRef] = {}
    for outcome in outcomes:
        for ref in outcome.sources:
            merged.setdefault(ref.chunk_id, ref)
    return sorted(merged.values(), key=lambda ref: ref.index)


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
        added=outcome.added,
    )
