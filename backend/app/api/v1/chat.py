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

**同一批事件还顺手记一份会话事件日志**（P0-2，照 ZCode 的只追加日志设计）：
``turn/start``、``step``、``tool_call``、``thinking``、``error``、``interrupted``、
``turn/end`` 逐个进 ``session_events`` 表，词表与投影在 ``services/session_events.py``。
消息里那份 ``steps`` 快照**形状不变**（老读法不受影响），但它从此是日志的投影：
``GET /conversations/{id}/events`` 读的是原始事件，回看时算出来的过程面板与它等价。
"""

from __future__ import annotations

import dataclasses
import json
import logging
import threading
from collections.abc import Iterator, Sequence
from queue import Empty, Queue

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
    SessionEventListOut,
    SessionEventOut,
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
from app.services.session_events import (
    KIND_ERROR,
    KIND_INTERRUPTED,
    KIND_STEP,
    TURN_DEGRADED,
    TURN_EMPTY,
    TURN_ERROR,
    TURN_OK,
    EventDraft,
    interrupted_payload,
    step_event_draft,
    thinking_draft,
    turn_end_draft,
    turn_start_draft,
)
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

#: SSE 心跳间隔（秒）。
#:
#: **为什么要有它**（P2-2，抄 ZCode 的长连接处置）：这条流经常**几十秒没有任何字节**
#: ——等端点出第一个字（推理模型首字延迟实测可到十几秒）、跑一个抓网页的工具、
#: 派一个子 Agent，那些时间里模型那边一切正常，而我们一个事件都发不出来。
#: 问题是"长时间没有数据"这件事在中间层看起来与"连接死了"一模一样：nginx 的
#: ``proxy_read_timeout`` 默认 60 秒就会把上游读断、浏览器与部分企业代理也有各自的
#: 空闲上限。被掐掉时用户看到的是"回答写到一半没了"，而那一刻模型还在正常生成
#: ——**报错指不到真正的病因**（看起来像模型坏了）。
#: 每 15 秒一个极小的心跳：对应用语义没有任何影响（见 ``_ping``），
#: 对中间层来说这条连接一直在动。
#:
#: 15 秒是"远小于最常见的 60 秒反代超时、又不会把空闲流刷成噪声"的量级。
SSE_PING_SECONDS = 15.0


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
        # 套一层心跳（P2-2）：流里长时间没事件时也要有字节出去，见 SSE_PING_SECONDS
        _with_pings(_events(services, payload, model_pk, thinking, effort, caller)),
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
        # 续跑同样套心跳：这条路更容易长时间没事件（它往往要跑不少工具步）
        _with_pings(
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
            )
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
    """非流式版本：给脚本、MCP 与自动化测试用，逻辑与流式完全相同。

    P0-2 起这条链路也记事件日志：它此前只把答案与出处落库、
    **过程一个字都不存**——于是同一句话从 `/chat` 问和从 `/chat/stream` 问，
    会话里的过程面板一个有内容一个空着。现在两条路共用 ``_TurnSink`` 那一份映射
    （事件、快照、思考都是它攒的），差别只剩"怎么把事件发出去"。
    """
    check_kb_scope(services, caller, payload.kb_ids)
    _require_conversation(services, payload, caller)
    _warn_on_scope_drift(services, payload)
    model_pk = _effective_model(services, payload)
    thinking, effort = _effective_thinking(services, payload)
    history, summary, _ = _context(services, payload, model_pk)
    sink = _TurnSink()
    sink.start_turn(query=payload.query, model_pk=model_pk)

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
        answer_text = ""
        for event in loop.run(
            messages=services.chat.agent_messages(
                query=payload.query,
                history=history,
                summary=summary,
                kb_ids=payload.kb_ids,
                skill_names=payload.skill_names,
                model_pk=model_pk,
            )
        ):
            if isinstance(event, DoneEvent):
                # 收尾那条带的是后端拼好的全文，**以它为准**（避免个别增量丢失后
                # 正文与出处对不上）——与流式那条路同一个口径
                answer_text = event.answer
            # 事件不发出去（这里没有流），但要**收进 sink**：快照与日志都由此而来
            for _ in sink.feed(event):
                pass
        answer = ChatTurn(answer=answer_text or sink.answer, sources=list(sink.sources))
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
    sink.close_turn(status=_turn_status(sink.steps), answer=answer.answer)
    _record_turn(
        services,
        payload,
        answer=answer.answer,
        sources=answer.sources,
        steps=sink.steps,
        thinking="".join(sink.thinking),
        caller=caller,
        events=sink.events,
    )
    return ChatResponseOut(answer=answer.answer, sources=_sources_out(answer.sources))


@router.get(
    "/conversations/{conversation_id}/events",
    response_model=SessionEventListOut,
    summary="会话事件日志（只追加，按 seq 正序）",
)
def conversation_events(
    conversation_id: str,
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
    kinds: str = Query(
        default="",
        description=(
            "逗号分隔的事件类型（turn/start、turn/end、step、tool_call、"
            "thinking、error、interrupted）；留空返回全部"
        ),
    ),
) -> SessionEventListOut:
    """这条会话的**事件日志**——"当时到底发生了什么"的原始记录（P0-2）。

    与 ``GET /conversations/{id}`` 的分工：那个端点返回消息（含 ``steps`` 快照，
    是**回看时要显示的东西**），这个返回**只追加的原始事件**（流式过程中的每一步、
    每一次工具调用、中断与失败）。两者是"投影"与"事实"的关系——快照的每一条
    都能在日志里找到出处（``services/session_events.steps_from_events``
    就是那条换算，端到端用例比对了两者相等）。

    **落在 chat.py 而不是 conversations.py**：事件的写入在对话链路里
    （``_TurnSink``），读写放一处，那一侧改动时不会漏掉另一侧。
    归属判定与既有的会话端点**同一套**（成员越主 404，不暴露存在性）。

    ``kinds`` 里出现词表之外的取值会 **422**：这个端点是给人读日志、给脚本做
    "只看中断"这类筛选用的，拼错了却拿到空列表会让人以为"这条会话没有这类事件"。
    """
    _require_visible_conversation(services, conversation_id, caller)
    wanted = [item.strip() for item in kinds.split(",") if item.strip()]
    events = services.conversations.session_events(conversation_id, kinds=wanted or None)
    return SessionEventListOut(items=[SessionEventOut.model_validate(event) for event in events])


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

    **P0-2 起它还顺手攒一份会话事件日志**：同一批事件按 kind 记进
    ``self.events``（词表见 ``services/session_events.py``），收尾时与消息
    **同一个事务**落库。快照照旧攒（老读法一个字不变），但它从此是那份日志的
    投影——"当时到底发生了什么"由日志回答，"回看时显示什么"由投影回答。

    刻意**不记**的几样，各有理由：

    - 正文增量（``delta``）：它就是答案本身，已经随消息落库；
    - 出处（``sources``）：同上，而且是**累计**语义（每次检索都重发一遍全量）；
    - 待确认（``approval``）：词表里没有它，而且它"还没被回答"——审批自己有
      登记表（``services/approvals.py``）。等 P1-1 的模式闸落地再按 ZCode 的
      ``approval/*`` 补一对审计事件；
    - 压缩那一步（``_events`` 里直接发的那条 step）：它是给界面看的一句提示，
      不进消息快照，记进日志会让"投影等于快照"这条验收当场不成立。
    """

    def __init__(self) -> None:
        self.steps: list[dict[str, object]] = []
        self.thinking: list[str] = []
        self.deltas: list[str] = []
        self.sources: list = []
        #: 这一轮的会话事件（草稿）。``seq`` / ``id`` 由存储层在写那个事务里给。
        self.events: list[EventDraft] = []
        #: 这一轮**有没有结论**（``close_turn`` 之后为真）。
        #: 中断收尾据此判断"要不要补一条 interrupted"：已经收尾过的一轮不该被
        #: 记成"被中断"（用户读完答复才关页面，是很正常的一件事）。
        self.finished = False
        #: 当前这段连续思考的 payload。同一次思考在日志里只占一条：增量拼进来，
        #: 每来一块写一行会让长会话的日志膨胀几十倍，而那些行在投影里没有区别。
        self._thinking_draft: dict[str, object] | None = None
        #: **已开始、还没有结果**的调用（``running`` 有、``done`` 没等到）。
        #: 中断时它就是要补进 ``interrupted.payload.unpaired`` 的那份名单。
        self._pending_calls: list[dict[str, object]] = []

    @property
    def answer(self) -> str:
        return "".join(self.deltas)

    def start_turn(
        self, *, query: str, model_pk: str | None, resume_reason: str | None = None
    ) -> None:
        """这一轮开始（``turn/start``）。

        **在流开始之前**就记下：之后无论正常收尾、失败还是被中断，
        日志的第一条都是"这一轮要做什么"，不会出现"有步骤、不知道在答什么"。
        """
        self.events.append(
            turn_start_draft(query=query, model_pk=model_pk, resume_reason=resume_reason)
        )

    def close_turn(self, *, status: str, answer: str) -> None:
        """这一轮有结论了（``turn/end``）。

        终止原因是**枚举**（``ok`` / ``degraded`` / ``error`` / ``empty``），
        不是"有没有异常"（调研报告 §2.1 第 2 条：异常分不清"没预算"与"崩了"）。
        """
        self.events.append(
            turn_end_draft(status=status, answer_chars=len(answer), steps=len(self.steps))
        )
        self.finished = True

    def mark_interrupted(self, *, reason: str) -> None:
        """用户中途停止 / 断开：补一条 ``interrupted``（QwenPaw 那条教训）。

        补的不只是"被中断了"这句话，还有**哪些调用没有结果**
        （``unpaired``）与用户**已经看到**的那段正文——否则下一轮不知道
        哪些动作是半截的，回看时也说不清当时屏幕上写到了哪。

        补完就当作"这一轮有结论了"（``finished``）：同一轮不会再被记第二次。
        """
        self.events.append(
            EventDraft(
                kind=KIND_INTERRUPTED,
                payload=interrupted_payload(
                    reason=reason, unpaired=self._pending_calls, answer=self.answer
                ),
            )
        )
        self.finished = True

    def note_error(self, message: str) -> None:
        """这一轮在流里失败了：``error`` 那一条（``turn/end`` 由调用方收）。"""
        self.events.append(EventDraft(kind=KIND_ERROR, payload={"message": message}))

    def _track_call(self, event: StepEvent) -> None:
        """跟踪"已开始、还没有结果"的调用（中断时那份名单，见 ``mark_interrupted``）。

        配对按**工具名**先进先出：``tool_loop._perform`` 的发法是"running 按调用顺序
        发全 → 执行 → done 也按调用顺序发"（见那里的说明），所以同名调用会按顺序
        一一对上。配不上对的那条 running，就是这一轮里"结果没等到"的调用。
        """
        if not event.tool:
            return
        if event.status == "running":
            self._pending_calls.append({"tool": event.tool, "label": event.label})
            return
        for index, pending in enumerate(self._pending_calls):
            if pending["tool"] == event.tool:
                del self._pending_calls[index]
                return

    def feed(self, event: object) -> Iterator[str]:
        # 换了一种事件就意味着这段思考结束了：下一条思考增量的到来会开新的一段
        if not isinstance(event, ThinkingEvent):
            self._thinking_draft = None

        if isinstance(event, StepEvent):
            # 快照的收法在服务层（``agent.step_snapshot``）：定时任务那条链路
            # 也要落同一份，两处各写一份必然分叉（见那个函数的说明）
            snapshot = step_snapshot(event)
            if snapshot is not None:
                self.steps.append(snapshot)
            # 同一条事件**同时**进日志：写侧的映射也只有一处（``step_event_draft``
            # 复用 step_snapshot），所以"日志投影 == 快照"不是靠约定而是靠同一份代码
            self.events.append(step_event_draft(event))
            self._track_call(event)
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
            # 日志里同一次连续思考只占**一条**：增量拼进同一个 payload。
            # 每来一块写一行的话，一条长思考就是几百行，而那些行在投影里
            # 完全一样（思考不进 steps）——只增长度，不增信息。
            if self._thinking_draft is None:
                draft = thinking_draft()
                self.events.append(draft)
                self._thinking_draft = draft.payload
            self._thinking_draft["text"] = f"{self._thinking_draft['text']}{event.text}"
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


def _resume_marker(reason: str) -> dict[str, object]:
    """续跑时那条「继续上一轮」的标记步骤。

    它是**消息快照与事件日志共用的同一份 dict**：消息那边的 ``_resume_steps``
    与日志那边的 ``step`` 事件都从它来。两处各写一份的话，"投影等于快照"
    只会在续跑这条路上悄悄不成立——而那条路难得走一次。
    """
    return {
        "phase": "tool",
        "label": "继续上一轮",
        "detail": f"上一次停下来是因为：{reason}",
        "status": "done",
    }


def _resume_steps(
    previous: Sequence[dict[str, object]], fresh: Sequence[dict[str, object]], *, reason: str
) -> list[dict[str, object]]:
    """续跑这一轮的过程快照：**上一轮那些 + 一条"继续"标记 + 这一轮新的**。

    为什么不只留新的：过程面板是"这一轮是怎么来的"。只看新的那半段，
    用户会看到"它一步都没查就回答了"——而事实是查过了，只是在上半场。
    那条标记把两半接上，也顺手回答了"为什么会有两段"。
    """
    return [*previous, _resume_marker(reason), *fresh]


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
        # 会话 id：只用来取那条会话的**计划门闸**（P1-1 的 `plan` 档要记
        # "本会话给没给过计划"，见 services/plan_gate.py）。模式档本身从运行期配置读，
        # 不从这里传——那条路上只有一个读点，见 services/chat.tool_loop 的说明
        conversation_id=conversation_id,
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
    """流式问答的**收尾**：建 sink、记 ``turn/start``、把断开也记进日志（P0-2）。

    这一层刻意薄：它只做"这一轮从哪开始、到哪结束"。正文那一段在
    ``_turn_events`` 里，两条链路（正常提问 / 续跑）共用同一份收尾，
    于是不可能出现"一条链路记日志、另一条不记"。

    ``GeneratorExit`` 是这里唯一必须拦的东西：用户在流式期间点停止、或者直接
    关掉页面时，Starlette 会 close 掉这个生成器，异常从 ``yield from`` 那里穿上来。
    不接住的话，库里就只剩半截（QwenPaw 那条教训：中断不补齐，
    下一轮与回看都说不清"当时停在哪一步"）。
    """
    sink = _TurnSink()
    sink.start_turn(query=payload.query, model_pk=model_pk)
    try:
        yield from _turn_events(
            services,
            payload,
            sink=sink,
            model_pk=model_pk,
            thinking=thinking,
            effort=effort,
            caller=caller,
        )
    except GeneratorExit:
        _record_interruption(services, payload.conversation_id, sink)
        raise


def _turn_events(
    services: Services,
    payload: ChatRequestIn,
    *,
    sink: _TurnSink,
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
    # 边流边写会让每一拍都多一次 UPDATE，而回看要的是最终那一份。
    # （P0-2 起同样的取舍套用到事件日志上：攒在 sink 里，与消息同一个事务写。
    # 日志**只追加**这一点不受影响——它不更新任何东西，只是写得更晚一点。）
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
            yield _fail(services, payload.conversation_id, sink, str(exc))
            return
        except Exception as exc:
            logger.exception("对话流异常")
            yield _fail(services, payload.conversation_id, sink, f"对话失败：{exc}")
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
            yield _fail(services, payload.conversation_id, sink, f"检索失败：{exc}")
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
            yield _fail(services, payload.conversation_id, sink, str(exc))
            return
        except Exception as exc:
            logger.exception("对话流异常")
            yield _fail(services, payload.conversation_id, sink, f"对话失败：{exc}")
            return

    answer = "".join(collected)
    # 只在**回答确实产出了**之后落库：失败的那一轮不留下半截记录，
    # 否则回看时会出现"问了但没答"的空档，而用户无从判断当时发生了什么。
    # 这条判断必须真的写出来——v0.12 之前只有注释、没有 if，于是流"正常结束但一个字都没吐"
    # 时照样落了一条空回答（实测：推理模型的思考吃光预算时就是这样）。
    if answer:
        # 这一轮有结论了：先记 ``turn/end``（终止原因是枚举，不是"有没有异常"），
        # 再连消息一起写——消息与事件同一个事务，见
        # `ConversationService.record_turn`。
        sink.close_turn(status=_turn_status(step_log), answer=answer)
        _record_turn(
            services,
            payload,
            answer=answer,
            sources=sources,
            steps=step_log,
            thinking="".join(thinking_parts),
            caller=caller,
            events=sink.events,
        )
    else:
        # 一个字都没吐（推理模型的思考吃光预算时就是这样）：不落消息，
        # 但**日志要留**——"为什么这一轮没有回答"正是回看时要问的。
        logger.warning("对话流没有产出任何正文，本轮不落库：query=%r", payload.query[:80])
        sink.close_turn(status=TURN_EMPTY, answer="")
        _flush_events(services, payload.conversation_id, sink)
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

    事件日志这边与正常提问同一套收尾（建 sink → ``turn/start`` → 断开时补
    ``interrupted``），只是 ``turn/start`` 多带 ``resume_reason``：
    "这一轮为什么接着做"在日志里必须看得出来，否则回看时会以为用户又问了一遍。
    """
    sink = _TurnSink()
    sink.start_turn(query=question, model_pk=model_pk, resume_reason=reason)
    # **那条「继续上一轮」的标记也进日志**：消息里的 steps 是"上一轮 + 标记 +
    # 这一轮"（见 ``_resume_steps``），日志若只记新的一半，投影就对不上了
    # ——而"投影等于快照"正是这条链路要守的东西。
    sink.events.append(EventDraft(kind=KIND_STEP, payload=_resume_marker(reason)))
    try:
        yield from _resume_turn_events(
            services,
            conversation_id=conversation_id,
            payload=payload,
            kb_ids=kb_ids,
            question=question,
            previous=previous,
            reason=reason,
            sink=sink,
            model_pk=model_pk,
            thinking=thinking,
            effort=effort,
            caller=caller,
        )
    except GeneratorExit:
        # 与 ``_events`` 同一处置：续跑跑到一半被停止 / 断开的，同样要补齐
        _record_interruption(services, conversation_id, sink)
        raise


def _resume_turn_events(
    services: Services,
    *,
    conversation_id: str,
    payload: ChatResumeIn,
    kb_ids: Sequence[str],
    question: str,
    previous: LastTurn,
    reason: str,
    sink: _TurnSink,
    model_pk: str | None,
    thinking: bool | None,
    effort: str | None,
    caller: Caller,
) -> Iterator[str]:
    """续跑的主体（与 ``_events`` 的收尾分开，理由同 ``_turn_events``）。"""
    chat = services.chat
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
        yield _fail(services, conversation_id, sink, str(exc))
        return
    except Exception as exc:
        logger.exception("续跑流异常")
        yield _fail(services, conversation_id, sink, f"续跑失败：{exc}")
        return

    answer = sink.answer
    if answer:
        # 终止原因与落库**同时**发生：``close_turn`` 先记 ``turn/end``，
        # ``append_answer`` 再把消息与这批事件写进同一个事务（P0-2）
        sink.close_turn(status=_turn_status(sink.steps), answer=answer)
        try:
            services.conversations.append_answer(
                conversation_id,
                answer=answer,
                sources=[item.model_dump() for item in _sources_out(sink.sources)],
                steps=_resume_steps(previous.steps, sink.steps, reason=reason),
                thinking="".join(sink.thinking),
                events=sink.events,
            )
        except Exception:
            # 与 `_record_turn` 同一条取舍：落库失败不该让用户丢掉**已经付过费**的回答
            logger.exception("续跑落库失败：%s", conversation_id)
    else:
        logger.warning("续跑没有产出正文：conversation=%s", conversation_id)
        sink.close_turn(status=TURN_EMPTY, answer="")
        _flush_events(services, conversation_id, sink)
    yield _sse({"type": "done", "answer": answer})


def _use_agent(services: Services) -> bool:
    """Agent 工作流是否启用（设置项 ``chat.agent_enabled``，默认开）。

    布尔解析统一走 ``RuntimeConfigService.get_bool``：此前这里是手写的一份，
    记忆层的开关会是第二份，而两处判断迟早分叉（一处把空值当关、另一处当开）。
    """
    return services.runtime.get_bool("chat.agent_enabled", default=True)


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _ping() -> str:
    """一条心跳（P2-2，见 ``SSE_PING_SECONDS``）。

    **它不带 ``data:`` 行**，与别的 SSE 事件不同，这是刻意的：前端把每一条
    ``data:`` 都当成一条消息去认 ``type``，而它只认识 done / error / step / …
    那几种——多出一个陌生的 type 会落到"其余都当错误"那条分支上
    （``frontend/src/api/chat.ts`` 的 ``emit``）。心跳是**给连接看的，不是给界面看的**，
    所以它连 data 都没有；按 SSE 规范，data 为空的事件不会派发给 EventSource，
    浏览器那边同样什么都不会发生。
    """
    return "event: ping\n\n"


def _with_pings(events: Iterator[str]) -> Iterator[str]:
    """把一条事件流包成"空闲就发心跳"的那条流（P2-2）。

    **为什么必须另起一个线程**：这条流是同步生成器，"模型说一句我们发一句"，
    它一次 ``next()`` 可能阻塞几十秒（等首字、跑一个抓网页的工具、派子 Agent）。
    在同一根线里等就没法在等待期间发出任何字节——而那正是会被中间层掐掉的事
    （见 ``SSE_PING_SECONDS``）。所以内层生成器在**它自己的线程**里跑，
    本生成器只做一件简单的事：队列里有事件就发，超时没动静就发一个心跳。

    两处细节各有原因，改的时候别省：

    - **断开时（本生成器被 close）由那个线程去关内层生成器**：GeneratorExit 会沿着
      ``_events`` 的 ``except GeneratorExit`` 把 ``interrupted`` 补进会话事件日志
      （P0-2 那条验收）。从本线程直接 ``close()`` 不行——生成器可能正在那个线程里
      执行，那会抛 "generator already executing"。所以本线程只置一个停止标记，
      由那边**在两次 next 之间**自己收工（正在跑的那一步会跑完，那正是"停在哪一步"
      要记的东西；不会等到整轮结束——``stop`` 在每次取到事件后都要检查一次）。
    - **内层抛出的异常原样带回本线程再抛**：它的类型是上层分支的依据
      （``_turn_events`` 的 ``except ChatError``），在别的线程里抛会被解释成
      "这一层自己崩了"，用户拿到的文案也就成了 500 那套。
    """
    queue: Queue[tuple[str, object]] = Queue()
    stop = threading.Event()

    def pump() -> None:
        try:
            for item in events:
                if stop.is_set():
                    break
                queue.put(("event", item))
        except BaseException as exc:
            # 连 BaseException 一起接：这里的职责只是**原样搬运**，判断留给消费侧
            # （``_turn_events`` 的 except 分支）；漏掉一类异常会让流莫名其妙地断死
            queue.put(("error", exc))
        finally:
            try:
                events.close()
            except Exception:  # 收尾失败不该盖过已经发生的那件事（成功或失败）
                logger.exception("关闭对话流失败")
            queue.put(("end", None))

    worker = threading.Thread(target=pump, name="chat-sse-heartbeat", daemon=True)
    worker.start()
    try:
        while True:
            try:
                kind, payload = queue.get(timeout=SSE_PING_SECONDS)
            except Empty:
                yield _ping()
                continue
            if kind == "event":
                yield payload  # type: ignore[misc]
            elif kind == "end":
                return
            else:
                raise payload  # type: ignore[misc]
    finally:
        stop.set()


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
    events: Sequence[EventDraft] = (),
) -> None:
    """把这一轮写进会话（仅在指定了 ``conversation_id`` 时）。

    引用**存快照**：``_sources_out`` 出来的就是这一轮实际依据的原文出处。
    事后重查会得到不同的结果，引用编号就对不上了。

    ``events``（P0-2）：这一轮的会话事件，与两条消息**同一个事务**落库
    （见 ``ConversationService.record_turn``）。所以不可能出现"消息在、事件不在"。
    """
    if not payload.conversation_id:
        return
    conversation_id = payload.conversation_id
    try:
        services.conversations.record_turn(
            conversation_id,
            question=payload.query,
            answer=answer,
            sources=[item.model_dump(mode="json") for item in _sources_out(sources)],
            # 过程与回答一起存：回看一条旧回答时，"它是怎么来的"和"它说了什么"
            # 同样重要（v0.25）
            steps=list(steps or ()),
            thinking=thinking,
            events=list(events),
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


# ------------------------------------------------------------------ 事件日志收尾


def _turn_status(steps: Sequence[dict[str, object]]) -> str:
    """这一轮的终止原因（枚举，见 ``services/session_events`` 的四个取值）。

    降级判定**复用续跑那条路的口径**（``resume.degraded_reason``）而不是自己看
    一眼 ``degraded`` 键：同一个问题（"这一轮跑完了吗"）有两份判断，
    迟早会出现"日志说降级、界面不给继续按钮"这种对不上的状态。
    """
    return TURN_DEGRADED if resume_service.degraded_reason(steps) else TURN_OK


def _flush_events(services: Services, conversation_id: str | None, sink: _TurnSink) -> None:
    """把攒下的事件落库（**没有消息可写**时的收尾）。

    三处用它：流内失败、流跑完但一个字都没吐、以及用户中途停止。
    这三种情况按 v0.12 起的取舍都不留消息（失败的一轮不留半截记录），
    而它们**恰恰最需要日志**——"当时为什么没有回答"只有这里答得出来。

    best-effort：写日志失败绝不能把已经发生的失败再放大一次，只记日志。
    """
    if not conversation_id or not sink.finished or not sink.events:
        return
    try:
        services.conversations.append_events(conversation_id, sink.events)
    except Exception:
        logger.exception("会话事件落库失败：%s", conversation_id)


def _fail(services: Services, conversation_id: str | None, sink: _TurnSink, message: str) -> str:
    """流内失败的收尾：把 ``error`` + ``turn/end`` 记进日志，并给出要发的那条 SSE。

    返回值就是客户端看到的那条 ``type=error``——**顺序不能反**：
    先记日志再返回，日志里才不会有"没有结尾的一轮"。
    """
    sink.note_error(message)
    sink.close_turn(status=TURN_ERROR, answer="")
    _flush_events(services, conversation_id, sink)
    return _sse({"type": "error", "message": message})


def _record_interruption(services: Services, conversation_id: str | None, sink: _TurnSink) -> None:
    """用户中途停止 / 断开时的收尾（P0-2 的第 5 条，QwenPaw 那条教训）。

    两件事：补一条 ``interrupted``（含"哪些调用没有结果"与已看到的正文），
    再把这一轮攒到现在的事件一起写进日志。**已经收尾的一轮不补**——用户读完答复
    才关页面是很正常的事，那不该被记成"被中断"。
    """
    if sink.finished:
        return
    sink.mark_interrupted(reason="客户端断开或用户停止")
    _flush_events(services, conversation_id, sink)


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
    _require_visible_conversation(services, payload.conversation_id, caller)


def _require_visible_conversation(services: Services, conversation_id: str, caller: Caller) -> None:
    """会话要存在且可见，否则 404。**所有"按会话读"的端点共用这一处判定。**

    抽成一个函数的理由与 ``Caller.owner_id`` 一样：这条规则一旦有两份，
    就会出现"某个端点忘了判归属"——而那种漏法不报错，只是把别人的会话读走了。
    """
    if caller.user is not None and not caller.is_admin:
        services.conversations.get_for_owner(conversation_id, caller.user.id)
    else:
        services.conversations.get(conversation_id)


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
