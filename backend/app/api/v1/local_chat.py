"""本机档的对话侧只读端点：事件日志 / 上下文用量 / 命令目录 / 用量面板。

这四条原先住在 ``api/v1/chat.py`` 与 ``api/v1/stats.py`` 里，本机档靠"按原路径薄重声明"
（``local.py`` 的 ``chat_reads`` / ``stats_reads``）把它们挂出来。现在那两个模块整体删了
（它们承载的会话链路是服务器档的事，本机档的对话走边车的 ``/turn*``），所以这四条
**在这里成为真实现**——路径、依赖、响应模型、OpenAPI 说明一个字没变，只是换了家。

**为什么是这四条**：它们的读源全在本机库里。

- ``GET /conversations/{id}/events`` 读 ``session_events``（只追加的事件日志）；
- ``GET /chat/context-usage`` 按会话历史与提示词现算（不落库、不触发压缩）；
- ``GET /chat/commands`` 读这台机器上的命令目录（``data/commands/`` + 仓库命令 +
  ``<data_dir>/skills/``，含"被禁用的技能"那栏的读法）——目录与执行同源；
- ``GET /stats/usage`` 读本机 ``usage_events`` 现聚。

其余那些（``/chat/stream``、``/chat``、``/conversations/{id}/resume``、审批、
``/stats/dashboard``）**不在这里**：前几条整条链路钉在会话面上、且本机档的对话走边车；
``/stats/dashboard`` 数的是知识库那边的家当（库数 / 文档数 / 切块数 / 任务数），
本机那几样都不存在，读它们必 503。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.auth import require_read
from app.api.v1.schemas import (
    CommandListOut,
    CommandOut,
    ContextUsageItemOut,
    ContextUsageOut,
    SessionEventListOut,
    SessionEventOut,
    UsageOut,
)
from app.core.caller import Caller
from app.core.services import Services, get_services
from app.services.agent_tools import build_tool_table

__all__ = ["router"]

router = APIRouter(tags=["local"])

MAX_WINDOW_DAYS = 365


def _require_visible_conversation(services: Services, conversation_id: str, caller: Caller) -> None:
    """会话要存在且可见，否则 404。**所有"按会话读"的端点共用这一处判定。**

    抽成一个函数的理由与 ``Caller.owner_id`` 一样：这条规则一旦有两份，
    就会出现"某个端点忘了判归属"——而那种漏法不报错，只是把别人的会话读走了。
    本机档的调用主体只有"本机主人"一种（``is_admin=True``，见 ``api/auth.py``——
    他**带** ``user``，所以"没有账号"不是这一档的判据），走的是不带归属收窄的那一支；
    留着这条判定是为了与既有的会话端点**同一套口径**。
    """
    if caller.user is not None and not caller.is_admin:
        services.conversations.get_for_owner(conversation_id, caller.user.id)
    else:
        services.conversations.get(conversation_id)


@router.get(
    "/chat/context-usage",
    response_model=ContextUsageOut,
    summary="上下文用量（按来源分解，估算）",
)
def context_usage(
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
    conversation_id: str = Query(description="要算哪条会话的上下文；必填"),
) -> ContextUsageOut:
    """这一轮上下文**被什么占着**（P1-3 的仪表，照 ZCode 的 ``chat.contextUsage.breakdown``）。

    为什么值得有：用户看到"它怎么变笨了 / 怎么变慢了"，能回答的一句话是
    "上下文里 60% 是技能目录"。按来源分解比一个百分比有用得多，
    也是"装了多少技能、给了多少工具"这件事第一次变得可核对。

    三件事按顺序说清：

    1. **算的是这一轮真会发出去的那一份**：历史（摘要 + 摘要之后的消息）、
       基础提示词 + 当前模式那段 + 库级提示词、技能目录、工具表、人设文件，
       外加框架开销那一项。工具表由协议层现拼（要调用者身份与这一轮的库范围）。
    2. **只读**：调它**不会**触发压缩（``prepare_context`` 那条路才会），
       所以它可以被界面随时刷新。
    3. **是估算**：按字符数算（刻意偏高），``estimated`` 恒真、``note`` 里写着这句话
       ——真实的用量只有模型端点返回的 ``usage`` 才知道。

    归属判定与既有的会话端点同一套（成员越主 404，不暴露存在性）。
    """
    _require_visible_conversation(services, conversation_id, caller)
    conversation = services.conversations.get(conversation_id)
    usage = services.chat.context_usage(
        conversation_id=conversation_id,
        owner_id=caller.owner_id,
        # 工具表与那一轮给模型的一模一样：同一处拼装（``_agent_loop``），
        # 两处各拼一份的话，仪表会显示一套、模型拿到另一套。
        # v0.57 起交给模型的是**核心常驻那一份**（外围靠发现通道），所以这里也按它算——
        # 否则仪表会把"其实没发出去的外围工具"算进上下文。
        tools=build_tool_table(
            services, owner_id=caller.owner_id, kb_ids=list(conversation.kb_ids)
        ).resident(),
    )
    return ContextUsageOut(
        items=[
            ContextUsageItemOut(
                kind=part.kind,
                label=part.label,
                chars=part.chars,
                tokens=part.tokens,
                # 注入内容的开头一段（D09）：界面上给"本轮注入了什么"一个内容级入口
                preview=part.preview,
                share=(part.tokens / usage.used) if usage.used else 0.0,
            )
            for part in usage.parts
        ],
        used=usage.used,
        total=usage.total,
        ratio=round(usage.ratio, 4),
        compress_at=usage.compress_at,
        # **实际**阈值（比例与绝对上限取小的那个，D37）：界面按这个说"到多少会自动压"，
        # 否则窗口调大之后那句提示是个永远到不了的数（实测 1M 窗口报 70 万，
        # 而那条会话总共才 1.2 万）
        compress_budget=usage.compress_budget,
        estimated=True,
        note=(
            "按字符数估算：中日韩 1 字约 1 token、其余 4 字符约 1 token（偏高一点），"
            "不是分词器给的准确值；真实用量看每次调用返回的 usage。"
        ),
    )


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
            "thinking、error、interrupted、mode/changed、command）；留空返回全部"
        ),
    ),
) -> SessionEventListOut:
    """这条会话的**事件日志**——"当时到底发生了什么"的原始记录（P0-2）。

    与 ``GET /conversations/{id}`` 的分工：那个端点返回消息（含 ``steps`` 快照，
    是**回看时要显示的东西**），这个返回**只追加的原始事件**（流式过程中的每一步、
    每一次工具调用、中断与失败）。两者是"投影"与"事实"的关系——快照的每一条
    都能在日志里找到出处（``services/session_events.steps_from_events``
    就是那条换算，端到端用例比对了两者相等）。

    归属判定与既有的会话端点**同一套**（成员越主 404，不暴露存在性）。

    ``kinds`` 里出现词表之外的取值会 **422**：这个端点是给人读日志、给脚本做
    "只看中断"这类筛选用的，拼错了却拿到空列表会让人以为"这条会话没有这类事件"。
    """
    _require_visible_conversation(services, conversation_id, caller)
    wanted = [item.strip() for item in kinds.split(",") if item.strip()]
    events = services.conversations.session_events(conversation_id, kinds=wanted or None)
    return SessionEventListOut(items=[SessionEventOut.model_validate(event) for event in events])


@router.get(
    "/chat/commands",
    response_model=CommandListOut,
    summary="可用命令（内置 + 自定义 + 技能，被遮蔽的也在里面）",
)
def list_commands(
    services: Services = Depends(get_services),
    _: Caller = Depends(require_read),
) -> CommandListOut:
    """斜杠命令的目录：前端那个 ``/`` 菜单就吃这一份（P1-2 第 4 条）。

    三条与界面直接相关的约定：

    1. **``{name, summary, usage, group}`` 四个字段是给菜单的**（``group`` 是**菜单
       分组**：``builtin`` / ``user`` / ``repo`` / ``skill``，见 ``CommandDef.group``
       ——技能那批是单独一档，不再借技能自己的发现源分组），其余字段是顺带给出的排错信息；
    2. **被遮蔽的与加载失败的都在列表里**（``shadowed_by`` / ``error``，与插件列表
       同一套做法）：静默藏掉会让用户以为文件没生效，而原因只有这里知道；
    3. **``short_circuit`` 只是"这条通常要不要模型"的说明**：为真的是 ``/help`` ``/mode``
       这一类，为假的是改写类（``/skill``、**技能自己的那条命令**与自定义 md 命令）。
       **界面不据它分流**——它是**表级**的保守口径，判不出 ``/plan`` 这种
       "看有没有参数"的两面派；真正的判据是这一轮的结果。
    """
    items = services.commands.list()
    return CommandListOut(
        items=[
            CommandOut(
                name=item.name,
                summary=item.summary,
                usage=item.usage or f"/{item.name}",
                group=item.group,
                details=list(item.details),
                argument_hint=item.argument_hint,
                short_circuit=item.short_circuit,
                shadowed_by=item.shadowed_by,
                error=item.error,
                path=item.path,
            )
            for item in items
        ],
        total=len(items),
        user_dir=str(services.commands.user_dir),
        builtin_dir=str(services.commands.builtin_dir),
    )


@router.get(
    "/stats/usage",
    response_model=UsageOut,
    summary="用量（本机 usage_events：token 与调用量，不含钱）",
)
def usage_summary(
    days: int = Query(default=30, ge=1, le=MAX_WINDOW_DAYS, description="观察窗口（天）"),
    services: Services = Depends(get_services),
    _: Caller = Depends(require_read),
) -> UsageOut:
    """最近 N 天的用量（对话 / 向量化 / 检索 / 重排）。

    **只给 token 与调用量，不给钱**：单价随供应商、版本、缓存命中、时段折扣
    不断变，内置一张价目表必然过期——而过期的价钱比不给更糟，
    用户会照着它做决定。

    ``unreported_calls`` 说清"有几次调用供应商没报用量"：不区分的话，
    统计页会把"没报"画成"没用"，那是在撒谎。

    **一条已知的缺口，写在这里免得把 0 读成"没用"**：本机那条**主链**今天不记账
    ——``ChatService.tool_loop``（边车 ``/turn`` 与定时任务默认走的那条 Agent 链）
    不调 ``UsageService.record``，边车的 ``RemoteModelClient`` 也不记。
    今天会往这张表写的只有 ``summarize_history``（上下文压缩那次模型调用）。
    所以这一条端点在本机**多数时候读到 0**，
    那是"没记账"而**不是**"没用量"——真要让它有意义，得让本机那条主链也记账
    （落点与"哪些 agent 步骤该按次记"一起定，属另一个单元）。
    """
    return UsageOut.model_validate(services.usage.summary(days=days))
