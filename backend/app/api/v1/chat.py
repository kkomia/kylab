"""对话端点：最简快速检索问答（M6 验证版）。

协议选择上有一处刻意：**流式（SSE）是默认**。
快速验证场景里"看着它一个字一个字写"远比"等十秒然后整段出现"有用，
而且出问题时能立刻看出是模型在胡扯还是检索没命中。

事件形状（``text/event-stream``，每行一个 JSON）：

```
data: {"type":"step","phase":"intent","label":"意图：查事实","detail":"…"}   # Agent 步骤
data: {"type":"sources","items":[...]}      # 依据；多轮检索会多次发出，始终是累计列表
data: {"type":"thinking","text":"…"}         # 思考增量（推理模型的 reasoning_content）
data: {"type":"delta","text":"向"}           # 逐块增量
data: {"type":"done","answer":"…"}           # 收尾（含拼接后的全文，便于前端兜底）
data: {"type":"error","message":"…"}         # 任何失败都在流内报，不吞
```

Agent 工作流（v20）默认开启，可用设置项 ``chat.agent_enabled`` 关掉退回单轮检索。
"""

from __future__ import annotations

import dataclasses
import json
import logging
from collections.abc import Iterator, Sequence

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from app.api.auth import check_kb_scope, require_admin, require_read
from app.api.v1.schemas import (
    ChatApprovalIn,
    ChatApprovalOut,
    ChatRequestIn,
    ChatResponseOut,
    ChatResumeIn,
    ChatSourceOut,
    SuggestedQuestionsOut,
)
from app.core.exceptions import ConflictError, InvalidRequestError
from app.core.services import Services, get_services
from app.services import resume as resume_service
from app.services.agent import (
    ApprovalEvent,
    DeltaEvent,
    DoneEvent,
    SourcesEvent,
    StepEvent,
    ThinkingEvent,
    step_snapshot,
)
from app.services.agent_tools import build_runner, tool_specs
from app.services.api_key import Caller
from app.services.chat import ChatTurn, SourceRef
from app.services.conversation import LastTurn
from app.services.llm import ChatError, ChatMessage
from app.services.suggested_questions import (
    DEFAULT_LIMIT as SUGGESTED_DEFAULT_LIMIT,
)
from app.services.suggested_questions import (
    MAX_QUESTIONS as SUGGESTED_MAX,
)
from app.services.suggested_questions import (
    MIN_QUESTIONS as SUGGESTED_MIN,
)
from app.services.tool_loop import DEFAULT_MAX_SECONDS, DEFAULT_MAX_STEPS

logger = logging.getLogger(__name__)

#: 交给记忆服务时"助手"这一侧的说话人名字。
#: 记忆服务要求每条消息标明"谁说的"，缺了会被它自己的校验拒掉。
ASSISTANT_NAME = "KYLAB"

router = APIRouter(tags=["chat"])

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    # 关掉 nginx 一类反代的缓冲，否则流式会被攒成一坨再发
    "X-Accel-Buffering": "no",
}


@router.post(
    "/chat/stream",
    summary="快速检索问答（流式）",
    response_class=StreamingResponse,
)
def chat_stream(
    payload: ChatRequestIn,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> StreamingResponse:
    # 对话会读到库内原文，所以同样受密钥的库范围约束
    check_kb_scope(services, caller, payload.kb_ids)
    _require_conversation(services, payload, caller)
    _warn_on_scope_drift(services, payload)
    model_pk = _effective_model(services, payload)
    thinking, effort = _effective_thinking(services, payload)
    # **在流开始前把模型校验掉**：坏 pk 应当是 422，而不是流内的一条 error 事件
    # （流一旦开始，状态码已经发出去了）。没配任何模型不算错，交由流内报可读文案。
    services.chat.llm_config(model_pk)
    return StreamingResponse(
        _events(services, payload, model_pk, thinking, effort, caller),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@router.post(
    "/conversations/{conversation_id}/resume",
    summary="续跑上一轮（工具循环没跑完时）",
    response_class=StreamingResponse,
)
def resume_turn(
    conversation_id: str,
    payload: ChatResumeIn,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> StreamingResponse:
    """**接着上一轮继续做**，而不是重发一遍（v0.32，见 ``services/resume.py``）。

    什么时候有得续：上一轮是**降级收尾**的（工具步数或整轮墙钟用尽了）。
    那时候模型还想查，只是没机会了——这里把已拿到的材料交回给它、把出处接上、
    再给一点预算，让它把话说完。用户看到的是同一个回合被补完，而不是两条回答。

    契约与「重新生成」一致：**要么能续、要么报错**（422），不静默做别的事。
    找不到可续的回答时宁可让前端把「继续」按钮藏起来，也不要在这里悄悄换个行为。

    库范围、模型档位、思考档位**取会话已存的**——续跑是接着同一轮做，
    不是新一轮提问；只有钉住的技能从界面来（它不入库，见 ``ChatResumeIn``）。
    """
    if caller.user is not None and not caller.is_admin:
        conversation = services.conversations.get_for_owner(conversation_id, caller.user.id)
    else:
        conversation = services.conversations.get(conversation_id)
    check_kb_scope(services, caller, conversation.kb_ids)

    turn = services.conversations.last_turn(conversation_id)
    if turn is None:
        raise InvalidRequestError("这段对话里没有可续的回答")
    reason = resume_service.degraded_reason(turn.steps)
    if not reason:
        raise InvalidRequestError("这一轮是正常跑完的，没有可续的地方")

    # 档位取**会话已存的**，界面给了就用界面的（与 `_effective_*` 同一套优先级）
    model_pk = payload.model_pk or conversation.model_pk
    thinking = payload.thinking if payload.thinking is not None else conversation.thinking
    effort = payload.thinking_effort or conversation.thinking_effort
    # **先把那条没做完的回答删掉**：新的回答会顶替它（同一个问题不该挂两条答案，
    # 理由见 services/conversation.drop_answer）。这一步在流开始之前做——
    # 失败了要当场 4xx/5xx，而不是"流里报个错、库里还留着旧的"。
    services.conversations.drop_answer(conversation_id, answer_id=turn.answer_id)

    return StreamingResponse(
        _resume_events(
            services,
            conversation_id=conversation_id,
            # 库范围取**会话已存的**：续跑是接着同一轮做，不是新一轮提问
            kb_ids=conversation.kb_ids,
            payload=payload,
            question=turn.question,
            previous=turn,
            reason=reason,
            model_pk=model_pk,
            thinking=thinking,
            effort=effort,
            caller=caller,
        ),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@router.post(
    "/chat/approvals/{approval_id}",
    response_model=ChatApprovalOut,
    summary="对一条待确认的工具调用做出决定（允许一次 / 这类都允许 / 拒绝）",
)
def decide_approval(
    approval_id: str,
    payload: ChatApprovalIn,
    services: Services = Depends(get_services),
    _: Caller = Depends(require_admin),
) -> ChatApprovalOut:
    """把用户在确认条上点的那一下，交给**正在等它的那个执行器**（v0.41）。

    与 `/chat/stream` 的关系是这条协议的全部要点：那条流**还开着**、停在
    ``approvals.ApprovalRegistry.wait`` 上（见 ``services/approvals.py``），
    这一条请求只是把决定送回它手里。所以这里有两件事不能做：

    - **不能等**：这一阻塞，那一头就没人叫醒了；
    - **失效必须回话**（409）：超时之后（默认 120 秒）那一头已经按"没有回应"
      往下跑了；这时回一句"已记录"，用户就会以为命令执行了——那是最不能有的一种错觉。

    门槛取 ``require_admin``，与那个动作本身同一档（``agent_exec`` 的闸 1）：
    点这一下等于同意"在这台机器上执行代码"。成员账号根本不会收到这条询问
    （命令在执行前就被权限闸拦掉了），所以这里的门槛与它能答的东西是对齐的。
    """
    if not services.approvals.decide(approval_id, payload.decision):
        raise ConflictError(
            "这条确认已经失效了（等太久超时，或者已经点过一次）。"
            "这一轮会按「没有批准」处理；让它重来一次，它会再问你一遍。"
        )
    return ChatApprovalOut(accepted=True, detail="已交给正在等它的那一步")


@router.post("/chat", response_model=ChatResponseOut, summary="快速检索问答（一次性）")
def chat_once(
    payload: ChatRequestIn,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> ChatResponseOut:
    """非流式版本：给脚本、MCP 与自动化测试用，逻辑与流式完全相同。"""
    check_kb_scope(services, caller, payload.kb_ids)
    _require_conversation(services, payload, caller)
    _warn_on_scope_drift(services, payload)
    model_pk = _effective_model(services, payload)
    thinking, effort = _effective_thinking(services, payload)
    history, summary, _ = _context(services, payload, model_pk)

    if _use_agent(services):
        # **与流式走同一条链路**（P0）：这个端点的文档里写着"逻辑与流式完全相同"，
        # 而工具循环已经是流式那条路的主流程——这里不跟上的话，
        # 同一句话从 `/chat` 问和从 `/chat/stream` 问会得到两种性质的回答
        loop = _agent_loop(
            services,
            caller,
            kb_ids=payload.kb_ids,
            conversation_id=payload.conversation_id,
            model_pk=model_pk,
            thinking=thinking,
            effort=effort,
        )
        answer = _collect(
            loop.run(
                messages=services.chat.agent_messages(
                    query=payload.query,
                    history=history,
                    summary=summary,
                    kb_ids=payload.kb_ids,
                    skill_names=payload.skill_names,
                    model_pk=model_pk,
                )
            )
        )
    else:
        sources = services.chat.retrieve_sources(
            query=payload.query,
            kb_ids=payload.kb_ids,
            top_k=payload.top_k or services.runtime.get_int("chat.top_k") or 6,
        )
        answer = services.chat.answer(
            query=payload.query,
            sources=sources,
            history=history,
            summary=summary,
            model_pk=model_pk,
            thinking=thinking,
            thinking_effort=effort,
        )
    _record_turn(services, payload, answer=answer.answer, sources=answer.sources, caller=caller)
    return ChatResponseOut(answer=answer.answer, sources=_sources_out(answer.sources))


@router.get(
    "/chat/suggested-questions",
    response_model=SuggestedQuestionsOut,
    summary="推荐问题（取自入库时为各分段生成的问题）",
)
def suggested_questions(
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
    kb_ids: str = Query(default="", description="逗号分隔的知识库 id；留空返回空列表"),
    limit: int | None = Query(
        default=None,
        ge=SUGGESTED_MIN,
        le=SUGGESTED_MAX,
        description="最多返回几条；留空用默认",
    ),
) -> SuggestedQuestionsOut:
    """给对话页空状态那排胶囊喂数据。

    **不再调模型**（v23）：问题在**入库时**就为每个分段生成好了（见
    `services/suggested_questions.py`），这里只是随机抽几段、把它们的问题取回来。
    这样空状态看到的"你可以这样问"与库里真实内容一致，也不必为一个引导多花一次
    模型调用。

    **失败返回空列表而不是报错**（``generated=false``）：库里还没有问题
    （功能没开、或文档还没重新摄入）时如此，界面据此回退到静态样例——
    不该把"打开对话页"变成一次错误提示。
    """
    ids = [item.strip() for item in kb_ids.split(",") if item.strip()]
    if ids:
        check_kb_scope(services, caller, ids)
    questions = services.suggested_questions.list_questions(
        kb_ids=ids, limit=limit or SUGGESTED_DEFAULT_LIMIT
    )
    return SuggestedQuestionsOut(questions=questions, generated=bool(questions))


# --------------------------------------------------------------------- 内部


def _effective_model(services: Services, payload: ChatRequestIn) -> str | None:
    """这一轮实际用哪个对话模型。

    优先级：**请求里的 ``model_pk`` > 会话已存的 ``model_pk`` > 全局默认（``None``）**。

    请求带了 ``model_pk`` 且指定了会话时**回写会话**——用户在输入框换了模型，
    这条会话就该记住新选择（v12"跟随会话保存"）。回写失败只记日志：模型选择没存上
    不该让这一轮问不出来。
    """
    if payload.model_pk:
        if payload.conversation_id:
            try:
                record = services.conversations.get(payload.conversation_id)
                if record.model_pk != payload.model_pk:
                    services.conversations.set_model(payload.conversation_id, payload.model_pk)
            except Exception:
                logger.exception("会话模型回写失败：%s", payload.conversation_id)
        return payload.model_pk
    if payload.conversation_id:
        # 走到这里说明 `_require_conversation` 已经把"不存在/越主"挡掉了（404）
        return services.conversations.get(payload.conversation_id).model_pk
    return None


def _effective_thinking(
    services: Services, payload: ChatRequestIn
) -> tuple[bool | None, str | None]:
    """这一轮实际用哪档思考设置。

    与 ``_effective_model`` 同一套优先级：**请求 > 会话已存 > 全局默认（``None``）**。
    请求里带了任一项且指定了会话时回写会话，让这条会话记住用户在输入框里的选择；
    回写失败只记日志——偏好没存上不该让这一轮问不出来。

    返回 ``None`` 表示"交给设置页/模型 options 决定"，而不是"关闭"：
    两层都用 ``None`` 当"没选"，把 False 混进去会让"没选"变成"显式关闭"。
    """
    thinking = payload.thinking
    effort = payload.thinking_effort
    if thinking is None and effort is None:
        if payload.conversation_id:
            record = services.conversations.get(payload.conversation_id)
            return record.thinking, record.thinking_effort
        return None, None

    if payload.conversation_id:
        try:
            record = services.conversations.get(payload.conversation_id)
            merged_thinking = thinking if thinking is not None else record.thinking
            merged_effort = effort if effort is not None else record.thinking_effort
            if record.thinking != merged_thinking or record.thinking_effort != merged_effort:
                services.conversations.set_thinking(
                    payload.conversation_id, merged_thinking, merged_effort
                )
        except Exception:
            logger.exception("会话思考偏好回写失败：%s", payload.conversation_id)
    return thinking, effort


class _TurnSink:
    """把工具循环的事件摊成 SSE，同时攒下**落库要用的快照**。

    两条链路共用它：正常提问（``_events``）与续跑（``_resume_events``）。
    抽出来的理由很实在——这套映射里有好几处"踩过才知道"的细节
    （`running` 的步骤不入快照、`degraded` 要落库、空字段不发键省带宽、
    思考要攒全文否则刷新后只剩一句"已生成回答"）。**复制一份就一定会分叉**。

    它只管攒与发，不管收尾：`done` 事件与落库由调用方在循环结束后统一做，
    这样两处的口径不可能不一致。
    """

    def __init__(self) -> None:
        self.steps: list[dict[str, object]] = []
        self.thinking: list[str] = []
        self.deltas: list[str] = []
        self.sources: list = []

    @property
    def answer(self) -> str:
        return "".join(self.deltas)

    def feed(self, event: object) -> Iterator[str]:
        if isinstance(event, StepEvent):
            # 快照的收法在服务层（``agent.step_snapshot``）：定时任务那条链路
            # 也要落同一份，两处各写一份必然分叉（见那个函数的说明）
            snapshot = step_snapshot(event)
            if snapshot is not None:
                self.steps.append(snapshot)
            yield _sse(
                {
                    "type": "step",
                    "phase": event.phase,
                    "label": event.label,
                    "detail": event.detail,
                    "status": event.status,
                    # 工具名（v0.26）：界面按它选图标、把同类调用并成一组。
                    # 非工具步骤没有，所以空就不发这个键
                    **({"tool": event.tool} if event.tool else {}),
                    # 两个都是"可选补充"，只在有意义时发（v25）：
                    # degraded 让界面给续跑/重试入口，added 让界面说清这轮找了几条新资料
                    **({"degraded": True} if event.degraded else {}),
                    **({"added": event.added} if event.added is not None else {}),
                    # 入参与原文（v0.25）：界面默认不展开，点开才看。
                    # 空串就**不发这个键**——每一条步骤都带两个空字段，
                    # 一个二十步的长会话会白扛几十 KB
                    **({"args": event.args} if event.args else {}),
                    **({"result": event.result} if event.result else {}),
                    **(
                        {"artifacts": [dict(a) for a in event.artifacts]} if event.artifacts else {}
                    ),
                }
            )
        elif isinstance(event, SourcesEvent):
            self.sources = event.sources
            yield _sse(
                {
                    "type": "sources",
                    "items": [item.model_dump() for item in _sources_out(self.sources)],
                }
            )
        elif isinstance(event, ApprovalEvent):
            # **问用户**（v0.41）：这一条发出去之后，循环那边就停在 `wait` 上了
            # （见 tool_loop._resolve_approvals），所以它必须**原样、立刻**发出去——
            # 攒着不发等于让两边一起等死。
            #
            # 不进 `self.steps`：过程快照是"这一轮做过什么"，而这是一句还没被回答的问题。
            # 落进库的话，回看历史时会冒出一条永远等不到人点的确认。
            yield _sse(
                {
                    "type": "approval",
                    "approval_id": event.approval_id,
                    "tool": event.tool,
                    "label": event.label,
                    "args": event.args,
                    "detail": event.detail,
                    "rule": event.rule,
                    "timeout_seconds": event.timeout_seconds,
                }
            )
        elif isinstance(event, ThinkingEvent):
            # 顺手攒一份全文：落库时要把它存下来，否则用户离开这一页再回来
            # 就只剩一句"已生成回答"（v0.25）
            self.thinking.append(event.text)
            yield _sse({"type": "thinking", "text": event.text})
        elif isinstance(event, DeltaEvent):
            self.deltas.append(event.text)
            yield _sse({"type": "delta", "text": event.text})
        # DoneEvent 不在这里发：收尾统一放在循环外，保证 done 里的全文
        # 与落库用的 answer 是同一个字符串


def _source_from_snapshot(item: dict[str, object]) -> SourceRef:
    """把落库的出处快照（``ChatSourceOut`` 的 dict）还原成 ``SourceRef``。

    **按字段名过滤**而不是直接 ``SourceRef(**item)``：快照里可能带着
    ``SourceRef`` 没有的键（前端模型加的展示字段），直接展开会在某天多一个字段时
    炸在续跑这条路上——而那是一条"偶尔才走一次"的路，炸了很难被发现。
    """
    allowed = {field.name for field in dataclasses.fields(SourceRef)}
    return SourceRef(**{key: value for key, value in item.items() if key in allowed})


def _resume_steps(
    previous: Sequence[dict[str, object]], fresh: Sequence[dict[str, object]], *, reason: str
) -> list[dict[str, object]]:
    """续跑这一轮的过程快照：**上一轮那些 + 一条"继续"标记 + 这一轮新的**。

    为什么不只留新的：过程面板是"这一轮是怎么来的"。只看新的那半段，
    用户会看到"它一步都没查就回答了"——而事实是查过了，只是在上半场。
    那条标记把两半接上，也顺手回答了"为什么会有两段"。
    """
    marker: dict[str, object] = {
        "phase": "tool",
        "label": "继续上一轮",
        "detail": f"上一次停下来是因为：{reason}",
        "status": "done",
    }
    return [*previous, marker, *fresh]


def _agent_loop(
    services: Services,
    caller: Caller,
    *,
    kb_ids: Sequence[str] | None,
    conversation_id: str | None,
    model_pk: str | None,
    thinking: bool | None,
    effort: str | None,
    seed_sources: Sequence[SourceRef] = (),
    max_steps: int | None = None,
    max_seconds: float | None = None,
):
    """建这一轮的工具循环（工具表 + 执行器 + 预算）。

    **提问与续跑共用它**：两处都要"内置工具 + 技能 + 外部 MCP，执行器带调用者身份
    与这一轮的库范围"，复制一份就一定会分叉（续跑那条路少接一个工具，
    表现是"续跑之后它忽然不会用某个工具了"，极难排查）。

    ``seed_sources`` 只有续跑用：把上一轮已经拿到的出处接进来源账本
    （见 ``services/resume.py`` 模块头——编号必须与交给模型的说明一致）。
    """
    return services.chat.tool_loop(
        model_pk=model_pk,
        thinking=thinking,
        thinking_effort=effort,
        # **工具表含外部 MCP 服务的工具**（v0.20）：用户在能力页接进来的
        # 服务，它们的工具与内置工具一起交给模型；能不能真的调起来由
        # 执行器那一刻的准入策略决定（见 agent_tools._call_mcp）
        tools=tool_specs(
            services,
            owner_id=caller.owner_id,
            # 这一轮允许查的库（空 = 用户关掉了知识库开关）：
            # 关掉时知识库那一侧的工具**整个不出现**，免得模型每轮
            # 先去列库、再检索一次被拒（见 agent_tools._KB_TOOLS）
            kb_ids=kb_ids,
        ),
        # **这一轮有界面可以问**（v0.41）：`ask` 档的工具调用（目前是 run_command）
        # 挂进这张登记表，由循环发一条 approval 事件、停在那里等人回答；
        # 用户的决定从 `POST /chat/approvals/{id}` 交回来（见 services/approvals.py）。
        # 定时任务那条链路不传它——那里没有人回答，等满超时是白等。
        approvals=services.approvals,
        # 执行器带**调用者身份**与**这一轮允许查的库**：
        # 关掉知识库开关之后，模型也不该能绕过它去检索（见 agent_tools.build_runner）
        runner=build_runner(
            services,
            caller,
            kb_ids=kb_ids,
            # 产物（导出类工具）落在哪：见 services/artifacts.py
            conversation_id=conversation_id,
            # 子 Agent（P1 补上）：它自己解析这一轮的模型档位，
            # 执行器只管"给问题、拿结论与出处"
            subagent=lambda task: services.chat.run_subagent_text(
                question=task,
                kb_ids=kb_ids,
                model_pk=model_pk,
                thinking=thinking,
                thinking_effort=effort,
            ),
            seed_sources=seed_sources,
        ),
        max_steps=max_steps,
        max_seconds=max_seconds,
    )


def _events(
    services: Services,
    payload: ChatRequestIn,
    model_pk: str | None,
    thinking: bool | None,
    effort: str | None,
    caller: Caller,
) -> Iterator[str]:
    """把一次问答摊成一串 SSE 事件。

    任何异常都在**流内**报出去（``type=error``）而不是靠 HTTP 状态码：
    流一旦开始发送，状态码已经发出去了，改不了——这也是最容易漏的一处。

    两条链路：Agent 工作流（默认，见 ``services/agent.py``）与单轮检索（``chat.agent_enabled``
    关掉时）。两条都会把 ``sources`` 与 ``delta`` 用同一套事件形状发出去，
    前端不必关心走的是哪条。
    """
    chat = services.chat
    # 过程快照与正文都攒在 sink 里：**只活在内存里、结束时一次性写**——
    # 边流边写会让每一拍都多一次 UPDATE，而回看要的是最终那一份
    sink = _TurnSink()
    collected: list[str] = []
    step_log: list[dict[str, object]] = []
    thinking_parts: list[str] = []
    sources: list = []
    # 上下文（含压缩）对两条链路都适用：Agent 关掉时同样需要"摘要 + 最近原文"
    history, summary, compressed = _context(services, payload, model_pk)
    if compressed:
        yield _sse(
            {
                "type": "step",
                "phase": "compress",
                "label": "压缩上下文",
                "detail": "较早的对话已折成摘要，之后的问答仍记得它们",
                "status": "done",
            }
        )

    if _use_agent(services):
        # **工具循环是主流程**（P0）：模型拿到十几个工具（内置 + 技能 + 外部 MCP 服务），
        # 自己决定查什么、做什么；知识库检索是其中一个工具（`search`），
        # 不再是每轮必经的阶段——资料由它取回，而不是我们预先塞进提示词。
        #
        # 事件怎么摊成 SSE、快照怎么攒，全在 `_TurnSink` 里（与续跑共用一份：
        # 那段映射里有好几处踩过才知道的细节，复制一份就一定会分叉）。
        try:
            loop = _agent_loop(
                services,
                caller,
                kb_ids=payload.kb_ids,
                conversation_id=payload.conversation_id,
                model_pk=model_pk,
                thinking=thinking,
                effort=effort,
            )
            for event in loop.run(
                messages=chat.agent_messages(
                    query=payload.query,
                    history=history,
                    summary=summary,
                    kb_ids=payload.kb_ids,
                    skill_names=payload.skill_names,
                    model_pk=model_pk,
                    owner_id=_memory_owner(caller),
                )
            ):
                yield from sink.feed(event)
        except ChatError as exc:
            yield _sse({"type": "error", "message": str(exc)})
            return
        except Exception as exc:
            logger.exception("对话流异常")
            yield _sse({"type": "error", "message": f"对话失败：{exc}"})
            return
        sources = sink.sources
        step_log = sink.steps
        thinking_parts = sink.thinking
        collected = sink.deltas
    else:
        try:
            sources = chat.retrieve_sources(
                query=payload.query,
                kb_ids=payload.kb_ids,
                top_k=payload.top_k,
            )
        except Exception as exc:
            yield _sse({"type": "error", "message": f"检索失败：{exc}"})
            return
        # 用 pydantic 序列化而不是 ``s.__dict__``：
        # SourceRef 是 slots=True 的 dataclass，**没有 __dict__**，
        # 取它会在流式刚发第一个事件时就抛 AttributeError、把连接截断（踩过）。
        yield _sse(
            {
                "type": "sources",
                "items": [item.model_dump() for item in _sources_out(sources)],
            }
        )
        try:
            for delta in chat.answer_stream(
                query=payload.query,
                sources=sources,
                history=history,
                summary=summary,
                model_pk=model_pk,
                thinking=thinking,
                thinking_effort=effort,
                owner_id=_memory_owner(caller),
            ):
                collected.append(delta)
                yield _sse({"type": "delta", "text": delta})
        except ChatError as exc:
            yield _sse({"type": "error", "message": str(exc)})
            return
        except Exception as exc:
            logger.exception("对话流异常")
            yield _sse({"type": "error", "message": f"对话失败：{exc}"})
            return

    answer = "".join(collected)
    # 只在**回答确实产出了**之后落库：失败的那一轮不留下半截记录，
    # 否则回看时会出现"问了但没答"的空档，而用户无从判断当时发生了什么。
    # 这条判断必须真的写出来——v0.12 之前只有注释、没有 if，于是流"正常结束但一个字都没吐"
    # 时照样落了一条空回答（实测：推理模型的思考吃光预算时就是这样）。
    if answer:
        _record_turn(
            services,
            payload,
            answer=answer,
            sources=sources,
            steps=step_log,
            thinking="".join(thinking_parts),
            caller=caller,
        )
    else:
        logger.warning("对话流没有产出任何正文，本轮不落库：query=%r", payload.query[:80])
    yield _sse({"type": "done", "answer": answer})


def _resume_events(
    services: Services,
    *,
    conversation_id: str,
    payload: ChatResumeIn,
    kb_ids: Sequence[str],
    question: str,
    previous: LastTurn,
    reason: str,
    model_pk: str | None,
    thinking: bool | None,
    effort: str | None,
    caller: Caller,
) -> Iterator[str]:
    """把一次续跑摊成一串 SSE（事件形状与 ``_events`` 完全一致，前端不必区分）。

    与正常提问的三处差别，每一处都有理由：

    1. **不落库提问**：问题上一轮就在库里了，这次只是接着做（落第二遍会出现
       同一条提问挂两次）；
    2. **上下文里去掉这一轮的提问**：`prepare_context` 从库里读历史，而那条提问
       已经在库里了，再把它当 `query` 传一遍就会重复一次（模型尤其容易被
       重复的同一句问话带偏）；
    3. **预算抬高 + 出处接上**：见 ``services/resume.py``。
    """
    chat = services.chat
    sink = _TurnSink()
    # 上一轮的出处还原成对象：**既要接进账本，也要先当作这一轮已有的出处**——
    # 续跑一次都没检索（材料够了直接收尾）时，答案里的 [n] 仍然要有对应的出处记录
    seeds = [_source_from_snapshot(item) for item in previous.sources]
    sink.sources = list(seeds)

    # 历史里去掉这一轮的提问（它在库里，由 `question` 显式带进来）
    context_payload = ChatRequestIn(query=question, conversation_id=conversation_id)
    history, summary, _ = _context(services, context_payload, model_pk)
    if history and history[-1].role == "user" and history[-1].content == question:
        history = history[:-1]

    note = resume_service.resume_note(
        resume_service.ResumeMaterial(
            question=question,
            answer=previous.answer,
            steps=previous.steps,
            sources=previous.sources,
        ),
        reason=reason,
    )

    try:
        loop = _agent_loop(
            services,
            caller,
            kb_ids=kb_ids,
            conversation_id=conversation_id,
            model_pk=model_pk,
            thinking=thinking,
            effort=effort,
            seed_sources=seeds,
            max_steps=DEFAULT_MAX_STEPS + resume_service.RESUME_EXTRA_STEPS,
            max_seconds=DEFAULT_MAX_SECONDS + resume_service.RESUME_EXTRA_SECONDS,
        )
        for event in loop.run(
            messages=chat.agent_messages(
                # 提问 + 交接说明合成一个用户消息（而不是发两条相邻的 user：
                # 有些端点对连续同角色消息的处理方式不一致，而这里没有任何理由冒那个险）
                query=f"{question}\n\n{note}",
                history=history,
                summary=summary,
                kb_ids=kb_ids,
                skill_names=payload.skill_names,
                model_pk=model_pk,
                owner_id=_memory_owner(caller),
            )
        ):
            yield from sink.feed(event)
    except ChatError as exc:
        yield _sse({"type": "error", "message": str(exc)})
        return
    except Exception as exc:
        logger.exception("续跑流异常")
        yield _sse({"type": "error", "message": f"续跑失败：{exc}"})
        return

    answer = sink.answer
    if answer:
        try:
            services.conversations.append(
                conversation_id,
                role="assistant",
                content=answer,
                sources=[item.model_dump() for item in _sources_out(sink.sources)],
                steps=_resume_steps(previous.steps, sink.steps, reason=reason),
                thinking="".join(sink.thinking),
            )
        except Exception:
            # 与 `_record_turn` 同一条取舍：落库失败不该让用户丢掉**已经付过费**的回答
            logger.exception("续跑落库失败：%s", conversation_id)
    else:
        logger.warning("续跑没有产出正文：conversation=%s", conversation_id)
    yield _sse({"type": "done", "answer": answer})


def _use_agent(services: Services) -> bool:
    """Agent 工作流是否启用（设置项 ``chat.agent_enabled``，默认开）。

    布尔解析统一走 ``RuntimeConfigService.get_bool``：此前这里是手写的一份，
    记忆层的开关会是第二份，而两处判断迟早分叉（一处把空值当关、另一处当开）。
    """
    return services.runtime.get_bool("chat.agent_enabled", default=True)


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _context(
    services: Services, payload: ChatRequestIn, model_pk: str | None
) -> tuple[list[ChatMessage], str, bool]:
    """本轮要带给模型的历史、摘要，以及"这轮有没有做过压缩"。

    **不指定会话**（脚本/MCP 无状态调用）时不压缩：没有会话就没有历史可压。
    ``prepare_context`` 里的摘要调用可能失败（模型临时不可用），这里兜底成
    "最近若干条历史"——压缩是优化，不该把整轮问答拖垮。
    """
    if not payload.conversation_id:
        return (
            [ChatMessage(role=item.role, content=item.content) for item in payload.history],
            "",
            False,
        )
    try:
        prepared = services.chat.prepare_context(
            conversation_id=payload.conversation_id, query=payload.query, model_pk=model_pk
        )
        return prepared.history, prepared.summary, prepared.compressed
    except Exception:
        logger.warning("上下文准备失败，退回最近历史", exc_info=True)
        return services.conversations.history(payload.conversation_id), "", False


def _maybe_capture_memory(
    services: Services,
    conversation_id: str,
    *,
    query: str,
    answer: str,
    caller: Caller,
) -> None:
    """把这一轮交给记忆沉淀——**节流后的、best-effort 的**。

    三件事缺一不可，缺了就不入队：

    1. 记忆开着（``MemoryService`` 自己判，这里不重复判）；
    2. 这一轮真的落进了某个会话——没有会话就没有可回溯的来源；
    3. **到了该沉淀的回合**（每 N 个用户回合一次）。节流规则在服务层，
       这里只提供"这是第几个用户回合"。

    失败一律吞掉只记日志：**记忆是加分项，绝不能让它影响一次已经成功的问答**。
    这与 webhook 的处置同一口径。
    """
    if not conversation_id:
        return
    try:
        count = services.conversations.message_count(conversation_id)
    except Exception:
        logger.warning("读会话消息数失败，本轮不沉淀记忆：%s", conversation_id, exc_info=True)
        return
    # 一个回合 = 用户 + 助手两条消息（见 _record_turn）
    turn_count = count // 2
    messages = [
        {"role": "user", "name": "用户", "content": query},
        # `name` 是记忆服务要求的"谁说的"（缺它会被它自己的校验拒掉）
        {"role": "assistant", "name": ASSISTANT_NAME, "content": answer},
    ]
    try:
        services.memory.enqueue_capture(
            messages,
            session_id=conversation_id,
            turn_count=turn_count,
            user_id=_memory_owner(caller),
        )
    except Exception:
        logger.warning("记忆沉淀入队失败：%s", conversation_id, exc_info=True)


def _record_turn(  # type: ignore[no-untyped-def]
    services: Services,
    payload: ChatRequestIn,
    *,
    answer: str,
    sources,
    steps: list[dict[str, object]] | None = None,
    thinking: str = "",
    caller: Caller,
) -> None:
    """把这一轮写进会话（仅在指定了 ``conversation_id`` 时）。

    引用**存快照**：``_sources_out`` 出来的就是这一轮实际依据的原文出处。
    事后重查会得到不同的结果，引用编号就对不上了。
    """
    if not payload.conversation_id:
        return
    conversation_id = payload.conversation_id
    try:
        services.conversations.append(conversation_id, role="user", content=payload.query)
        services.conversations.append(
            conversation_id,
            role="assistant",
            content=answer,
            sources=[item.model_dump(mode="json") for item in _sources_out(sources)],
            # 过程与回答一起存：回看一条旧回答时，"它是怎么来的"和"它说了什么"
            # 同样重要（v0.25）
            steps=list(steps or ()),
            thinking=thinking,
        )
        services.conversations.ensure_title(conversation_id, payload.query)
    except Exception:
        # 落库失败不该让用户丢掉已经拿到的回答——那是**已经付过费**的结果。
        # 记日志即可；下一轮的历史会缺这一条，但不影响继续对话。
        logger.exception("对话落库失败：%s", conversation_id)
        return
    # 落库成功之后才谈沉淀：消息没进库就沉淀，记忆会指向一个空会话
    _maybe_capture_memory(
        services, conversation_id, query=payload.query, answer=answer, caller=caller
    )


def _memory_owner(caller: Caller) -> str | None:
    """这次问答该用**谁的记忆**（v0.15）。

    普通成员 → 自己的账号；管理员会话与 API Key 通道 → 共享桶（``None``）。
    判定本身在 ``Caller.owner_id``（同一个口径要供知识库/会话/工作区/能力用，
    各自写一份迟早会分叉）；这里保留这个函数是因为它在对话链路里被调了多处，
    名字比 ``caller.owner_id`` 更能说明"这是记忆归属"。
    """
    return caller.owner_id


def _require_conversation(services: Services, payload: ChatRequestIn, caller: Caller) -> None:
    """指了会话就必须存在**且属于当前调用方**。

    **不做"静默新建"**：那样用户拼错一个 id 会得到一次正常回答，然后发现历史没存上
    ——而落库失败是静默的（见 ``_record_turn`` 的取舍），两次静默叠起来根本无法排查。
    在**流还没开始**之前抛 404，用户立刻知道 id 不对。

    成员（v10）越主同样 404：对话内容是私有数据，403 会暴露"这条会话存在"。
    不拦的话，成员拿着别人的会话 id 就能把整段历史读走（`_history` 以库里为准）。
    管理员会话不受此限（is_admin）：它要能看到 API Key 建的无主会话。
    """
    if not payload.conversation_id:
        return
    if caller.user is not None and not caller.is_admin:
        services.conversations.get_for_owner(payload.conversation_id, caller.user.id)
    else:
        services.conversations.get(payload.conversation_id)


def _warn_on_scope_drift(services: Services, payload: ChatRequestIn) -> None:
    """会话建立的库范围与本次请求不一致时留一条日志。

    刻意**不拦**：用户可能就是想换个库继续问。但这种情况下的多轮指代会指向
    "上一轮在另一个库里看到的资料"，答非所问很难排查——所以留个痕迹。
    """
    if not payload.conversation_id:
        return
    try:
        record = services.conversations.get(payload.conversation_id)
    except Exception:
        return
    if record.kb_ids and set(record.kb_ids) != set(payload.kb_ids):
        logger.info(
            "会话 %s 的库范围与本次请求不同（会话 %s / 请求 %s），多轮上下文可能不连续",
            record.id,
            list(record.kb_ids),
            payload.kb_ids,
        )


def _sources_out(sources) -> list[ChatSourceOut]:  # type: ignore[no-untyped-def]
    return [ChatSourceOut.model_validate(source) for source in sources]


__all__ = ["router"]


def _collect(events: Iterator[object]) -> ChatTurn:
    """把事件流收成一次问答（非流式端点用）。

    收法：**最后一次 SourcesEvent 就是出处**，
    ``DoneEvent`` 带的是后端拼好的全文（以它为准，避免个别增量丢失后正文与出处对不上）。
    """
    answer = ""
    sources: list = []
    for event in events:
        if isinstance(event, SourcesEvent):
            sources = list(event.sources)
        elif isinstance(event, DoneEvent):
            answer = event.answer
    return ChatTurn(answer=answer, sources=sources)
