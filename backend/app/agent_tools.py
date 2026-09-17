"""Agent 的工具集：给模型看的规格 + 执行器（P0）。

与 `app/mcp_server/tools.py` 的关系是**同一份实现、两个门**：对外 MCP 客户端调
`call_tool`，对内由 `services/tool_loop.py` 调这里的 runner。所以"知识库降级成一个工具"
几乎是免费的——`search` 早就是那 13 个工具之一，只是以前的对话循环没走它。

这个模块里只有三类是内部门特有的：

1. **技能工具**（`list_skills` / `read_skill`）：它们是"读自己身上的说明书"，
   对外部 MCP 客户端没有意义（那个客户端自己就是 agent）。
2. **检索要收在会话选定的库范围内**（见 `build_runner`）：知识库不再是回答的框架，
   但"这一轮允许查哪些库"仍然要说清楚——否则关掉开关之后，模型一句
   `search` 就能把库全查了，那个开关就成了摆设。
3. **外部 MCP 服务暴露的工具**（v0.20）：用户在能力页接进来的服务，它们的工具
   一并进这张表（名字带 `mcp__<服务>__<工具>` 前缀），所以模型能像用内置工具
   一样用它们。**准入策略在调用那一刻判**，见 ``_call_mcp``。

工具表里三段的顺序是**内置 → 技能 → 外部**：模型对"先看到什么"有轻微偏好，
前面两段是我们自己担保的，外部的东西排最后。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any

from app.core.logging import sanitize_log_value
from app.mcp_server.tools import call_tool, tool_definitions
from app.services.api_key import Caller
from app.services.chat import SourceRef
from app.services.command_policy import (
    ACTION_ALLOW,
    ACTION_DENY,
    rules_from_runtime,
    suggest_rule,
)
from app.services.llm import ToolSpec
from app.services.mcp_client import normalized_server_name, split_qualified
from app.services.tool_loop import ToolOutcome, ToolRunner

__all__ = ["build_runner", "tool_specs"]

logger = logging.getLogger(__name__)

#: 单个技能附件最多读多少字符。技能里的脚本可能很大，读进来就是上下文成本。
MAX_ATTACHMENT_CHARS = 20000

#: 一条外部工具结果最多回给模型多少字符（在 `tool_loop.MAX_RESULT_CHARS` 之外再收一道）。
#: 外层那个上限是给所有工具的；外部服务的返回不受我们约束，实测有的服务会把
#: 整个网页塞回来。
MAX_MCP_RESULT_CHARS = 8000

_SKILL_TOOLS: tuple[dict[str, Any], ...] = (
    {
        "name": "list_skills",
        "description": (
            "列出这台机器上可用的技能（SOP 文档）。"
            "**当你不知道某类事该怎么做时先看它**——技能里往往是别人已经踩过坑的流程。"
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "spawn_subagent",
        "description": (
            "派一个子 Agent 去做一件**自包含**的事，把它的结论拿回来。"
            "它看不到我们这段对话，所以任务描述要写全（问什么、依据什么）。"
            "适合「需要啃一批资料才能得到一句话结论」的活；"
            "**它没有派生能力、有轮次与时限**，简单的事自己做更快。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "要它回答的问题，自包含、具体",
                }
            },
            "required": ["task"],
        },
    },
    {
        "name": "read_skill",
        "description": (
            "读一个技能的正文（它的流程与注意事项）。"
            "带 `file` 参数时读该技能的附属文件（脚本、模板、参考）。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "技能名，来自 list_skills"},
                "file": {
                    "type": "string",
                    "description": "附属文件的相对路径；省略则读 SKILL.md 正文",
                },
            },
            "required": ["name"],
        },
    },
)


def tool_specs(services: Any = None, *, owner_id: str | None = None) -> list[ToolSpec]:
    """这一轮提供给模型的全部工具：内置 → 技能 → 外部 MCP 服务。

    ``services`` 给不给决定后两段在不在：

    - 不给（单测、纯规格检查）→ 只有内置工具，行为与 P0 时一致；
    - 给了 → 再加上外部服务暴露的工具。**只列调用方自己有权限用的那些**
      （``owner_id`` 收口，与能力页看到的同一批），否则会出现
      "别人登记的 MCP 服务在我的对话里被调起来"。

    外部那一段走**缓存**（见 ``MCPClientService.cached_tools``），所以这句话
    不便宜但也不贵：它是每轮一次的内存查找，不是每轮一次握手。
    """
    specs = [
        ToolSpec(
            name=item["name"],
            description=str(item.get("description") or ""),
            # MCP 叫 inputSchema，OpenAI 叫 parameters——同一个东西，这里翻一次名
            parameters=item.get("inputSchema") or {"type": "object", "properties": {}},
        )
        for item in tool_definitions()
    ]
    specs.extend(
        ToolSpec(
            name=item["name"],
            description=str(item["description"]),
            parameters=item["inputSchema"],
        )
        for item in _SKILL_TOOLS
    )
    if services is not None:
        specs.extend(_mcp_specs(services, owner_id))
    return specs


def _mcp_specs(services: Any, owner_id: str | None) -> list[ToolSpec]:
    """外部 MCP 服务的工具，翻成给模型的规格。

    **描述要带上服务名**：模型拿到的是一个平铺的工具表，`search_web` 这个名字
    本身说不清它来自哪个服务、能做到什么程度；而 `mcp__tavily__search_web`
    既说了归属，也让它在解释"我用了哪个工具"时说得出人话。

    清单取不到（服务没起、命令不存在）时**那个服务整体不出现**，其余照常——
    一个外部服务挂掉不该让整张能力表消失。
    """
    specs: list[ToolSpec] = []
    try:
        pairs = services.mcp.available_tools(user_id=owner_id)
    except Exception:
        # 连服务列表都读不出来（存储异常）时不该让整轮对话起不来：工具表少一段
        # 仍然能答，而抛出去会让"问一句话"直接失败。
        logger.warning("外部 MCP 工具清单读取失败，本轮不带外部工具", exc_info=True)
        return []
    for record, tool in pairs:
        origin = f"[外部工具 · 来自 MCP 服务「{record.name}」]"
        specs.append(
            ToolSpec(
                name=tool.qualified,
                description=f"{origin} {tool.description}".strip(),
                # 外部服务的 inputSchema 不受我们约束：它可能是空的、也可能带
                # 我们没见过的关键字。原样透传，但**必须是个对象**——
                # 有的服务给 null，那样模型侧会直接拒掉整张表。
                parameters=tool.schema or {"type": "object", "properties": {}},
            )
        )
    return specs


def build_runner(
    services: Any,
    caller: Caller,
    *,
    kb_ids: Sequence[str] | None = None,
    subagent: Callable[[str], tuple[str, list[Any]]] | None = None,
) -> ToolRunner:
    """绑一个执行器。``kb_ids`` 是**这一轮允许查的库**（会话上选的那些）。

    范围规则（三条，都与"关掉知识库开关就该真的查不到"一致）：

    - 有范围、模型没指定库 → 用这个范围（它通常压根不知道有哪些库，逼它先列一遍
      是多余的一步）；
    - 有范围、模型指定了库 → **取交集**；交集为空就报错，并把它能查的库告诉它；
    - 没范围（用户关掉了知识库开关）→ 检索直接拒绝，并说明"要查资料得让对方打开"。
      这一条是那个开关的意义所在：它不该只挡界面。

    **外部工具也走这里**：``mcp__<服务>__<工具>`` 交给 ``_call_mcp``，
    它在真正调用之前过一遍准入策略（见那个函数的说明）。

    **执行器持有这一轮的"来源账本"**（``book``）。它是每轮新建的，所以账本正好
    等于"这一轮用到的资料"。为什么要它：模型可以在一轮里查好几次，而每次检索
    都从 [1] 开始编号——不累计的话，第二次检索的编号与第一次撞车，
    界面上（只认最后一批）会把先查到的那些资料**整批丢掉**，
    于是答案里的 [1][2] 指向的东西与用户看到的对不上。
    累计并**重新编号**必须在渲染资料之前做（内容与界面必须是同一套号），
    所以它在这里而不是在工具循环里。
    """
    scope = [str(item) for item in (kb_ids or []) if str(item).strip()]
    # 有些调用点（子 Agent 的测试、脚本）没有凭据主体，那就是**共享桶**
    # （``None``），与"管理员/API Key 通道"同一档——不是错误，不给它编一个身份。
    owner_id = caller.owner_id if caller is not None else None
    book: list[SourceRef] = []

    def run(name: str, args: dict[str, Any]) -> ToolOutcome:
        if name.startswith("mcp__"):
            return _call_mcp(services, name, args, owner_id=owner_id)
        if name == "spawn_subagent":
            task = str(args.get("task") or "").strip()
            if not task:
                return ToolOutcome(content="缺少参数：task")
            if subagent is None:
                # 明确说"这一轮没有"，而不是假装派了：模型据此才该自己去查
                return ToolOutcome(content="子 Agent 在这一轮不可用，请自己查。")
            try:
                answer, sources = subagent(task)
            except Exception as exc:
                logger.info("子 Agent 失败：%s", exc)
                return ToolOutcome(content=f"子 Agent 没跑成：{exc}")
            refs = _renumber(list(sources), offset=len(book))
            book.extend(refs)
            return ToolOutcome(
                content=answer or "（子 Agent 没有给出结论）",
                sources=list(book),
                summary="子 Agent 回报了结论",
            )
        if name == "list_skills":
            return ToolOutcome(content=_render_skills(services))
        if name == "read_skill":
            return ToolOutcome(content=_read_skill(services, args))
        if name == "search":
            scoped = _scope_search(args, scope)
            if scoped is None:
                return ToolOutcome(
                    content=(
                        "这一轮没有可查的知识库（对方关掉了知识库，或本会话没选库）。"
                        "需要资料的话，先把这个问题告知对方，不要凭常识补。"
                    )
                )
            # **走 `retrieve_sources`，不走 MCP 那个 `search` 工具。** 两者的区别不是
            # 检索本身（都是同一套混合检索），而是**取回来的是哪一段文本**：
            # 那个工具回的是命中的**那一块**（chunk），这里回的是它所在的**整段小节**
            # 加上文档摘要、并按条数均摊字数预算（v17/v25 做的"小块检索、大块阅读"）。
            #
            # 这正是 P0 换框架时丢过的东西：模型拿到的是被切碎的块，读起来缺上下文，
            # 但它**看起来完全正常**——只是答得更浅。所以内部这条门要用这一份；
            # 外部门保持 chunk 级返回不变（那是已发布的 MCP 契约，外部客户端
            # 靠 chunk_id 做二次读取）。
            kb_ids = [str(item) for item in (scoped.get("knowledge_base_ids") or [])]
            services.api_keys.check_access(caller, kb_ids=kb_ids)
            refs = _renumber(
                services.chat.retrieve_sources(
                    query=str(scoped.get("query") or ""),
                    kb_ids=kb_ids,
                    top_k=_int_or_none(scoped.get("top_k")),
                ),
                offset=len(book),
            )
            book.extend(refs)
            return ToolOutcome(
                content=_render_sources(refs),
                # **累计列表**（协议约定：多轮检索多次发出，始终是累计的）：
                # 只发这一批的话，先查到的那些资料会在界面上消失
                sources=list(book),
                summary=f"命中 {len(refs)} 段原文",
            )
        payload = call_tool(services, name, args, caller=caller)
        return ToolOutcome(content=_render(payload), summary=_summary(name, payload))

    return run


# ------------------------------------------------------------------ 外部 MCP 工具


def _call_mcp(
    services: Any, qualified: str, args: dict[str, Any], *, owner_id: str | None
) -> ToolOutcome:
    """调一个外部 MCP 服务的工具，**调用前先过准入策略**。

    三档的处理方式都与"这是它自己想要的"这件事一致：

    - ``allow`` → 调；
    - ``deny`` → 不调，并把**为什么**说清楚（模型据此换路，而不是反复重试）；
    - ``ask`` → **也不调**，并请模型如实告诉用户怎么放开它。

    ``ask`` 为什么不是"停下来问用户"：对话的这条链路是一个**拉取式的生成器**
    （事件由上层一个个取走），而"问用户"要求在这一步**把已经发生的事件先送出去、
    再阻塞等人回答**。拉取式生成器做不到——阻塞发生在 yield 之前，
    界面根本收不到那个询问，两边一起等（实测过这个死锁的形状：
    事件攒在列表里，前端什么都没有）。要支持它得先换成推送式事件流，
    那是一次协议层改造，不是这里加两行代码。

    于是取舍是：**宁可"这轮用不了、并说清怎么打开"，也不要静默执行**。
    默认档就是 ``ask``，所以"接进来就悄悄以用户名义调外部服务"这件事不会发生。
    """
    split = split_qualified(qualified)
    if split is None:
        return ToolOutcome(content=f"认不出这个工具名：{qualified}")
    server_part, tool = split
    record = _find_server(services, server_part, owner_id)
    if record is None:
        return ToolOutcome(
            content=(
                f"没有找到启用的 MCP 服务「{server_part}」"
                "（可能没登记、被停用，或不属于当前账号），这个工具这轮用不了。"
            )
        )
    decision = services.mcp.decide(
        record, tool, rules=rules_from_runtime(services.runtime, source="外部工具")
    )
    if decision.action == ACTION_DENY:
        return ToolOutcome(
            content=(
                f"这个外部工具被拒绝调用（{decision.reason}）。请换一条路完成这件事；"
                "如果确实需要它，把这一点告诉对方（它在「能力 → MCP 服务」里可以改）。"
            ),
            summary="被策略拒绝",
        )
    if decision.action != ACTION_ALLOW:
        rule = suggest_rule(qualified, "").describe()
        return ToolOutcome(
            content=(
                f"调用 {qualified} 需要用户先确认，**这一轮没有执行**。"
                "请如实告诉对方：要用这个外部工具，得先把「能力 → MCP 服务」里"
                f"「{record.name}」的策略改成「允许」，"
                f"或者在设置的放行清单里加一行 `{rule}`。"
                "**不要假装调用过，也不要凭猜测编造它的返回。**"
            ),
            summary="需要先确认，本轮没执行",
        )
    try:
        text = services.mcp.call(record, tool, args, approved=True)
    except Exception as exc:
        # 与内置工具同一口径：失败**如实回到循环**，不包装成空结果
        logger.info("外部工具 %s 调用失败：%s", qualified, sanitize_log_value(exc))
        return ToolOutcome(content=f"调用外部工具失败：{exc}")
    clipped = text[:MAX_MCP_RESULT_CHARS]
    if len(text) > MAX_MCP_RESULT_CHARS:
        clipped += f"\n\n（结果过长已截断，以上是前 {MAX_MCP_RESULT_CHARS} 字）"
    return ToolOutcome(
        content=clipped or "（外部工具没有返回内容）",
        summary=f"{record.name} 的 {tool} 返回了结果",
    )


def _find_server(services: Any, server_part: str, owner_id: str | None) -> Any | None:
    """按限定名里那段服务名找回登记记录（**只认启用中的，且按账号收口**）。

    比的是**规范化之后**的名字（``tool_qualified_name`` 会把下划线折成横线）：
    直接拿原名比的话，用户给服务起名 ``my_tool`` 时对话里永远找不到它。
    """
    for record in services.mcp.list(user_id=owner_id):
        if record.enabled and normalized_server_name(record.name) == server_part:
            return record
    return None


# ------------------------------------------------------------------ 检索的范围与形状


def _scope_search(args: dict[str, Any], scope: list[str]) -> dict[str, Any] | None:
    """把检索参数收进范围；无可查返回 ``None``。"""
    if not scope:
        return None
    asked = [str(item) for item in (args.get("knowledge_base_ids") or []) if str(item)]
    if not asked:
        return {**args, "knowledge_base_ids": scope}
    allowed = [item for item in asked if item in scope]
    if not allowed:
        # 明确拒绝而不是"悄悄换成允许的库"：换了它就会以为查的是自己指定的那个，
        # 于是把别处的结论按在这个库上说
        return None
    return {**args, "knowledge_base_ids": allowed}


def _render_sources(refs: Sequence[SourceRef]) -> str:
    """把资料渲染成**带编号的文本块**。

    不直接 `json.dumps`：模型接下来要给这些片段编引用号，而 JSON 里的字段名
    会把"编号"这件事弄糊（它分不清哪个是该引的数字）。这里的编号就是
    `SourceRef.index`——界面上的 [1][2] 与它一一对应。

    没命中时**明说没命中**：回一个空串会让模型把"没有资料"读成"资料是空的"，
    然后照样往下写。
    """
    if not refs:
        return "没有命中任何片段。"
    lines: list[str] = []
    for ref in refs:
        where = ref.document_name
        if ref.heading_path:
            where += f" › {ref.heading_path}"
        if ref.page is not None:
            where += f"（第 {ref.page} 页）"
        lines.append(f"[{ref.index}] {where}\n{ref.preview}")
    return "\n\n".join(lines)


def _renumber(refs: Sequence[SourceRef], *, offset: int) -> list[SourceRef]:
    """把一批资料接着**已有的编号**往下排（``offset`` = 这轮已经给出去几段）。

    引用号是模型与用户之间唯一的对接方式：模型写 [2]，用户点 [2] 要看的就是
    **那段**原文。所以编号一旦重排，渲染给模型的文本与发给界面的出处必须是
    同一次重排的结果——这也是它只能发生在渲染之前的原因。
    """
    return [
        replace(ref, index=offset + position)
        for position, ref in enumerate(refs, start=1)
    ]


def _int_or_none(value: Any) -> int | None:
    """``top_k`` 可能是模型给的字符串（有些模型把数字包成 ``"6"``）或缺失。"""
    if isinstance(value, bool):  # bool 是 int 的子类，这里必须先排掉
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


# ------------------------------------------------------------------ 技能


def _render_skills(services: Any) -> str:
    records = services.skills.list()
    if not records:
        return "这台机器上还没有安装技能。"
    lines = []
    for record in records:
        usable = "可用" if record.used_by_prompt else "被拦下（不进提示词，读了也不该照做）"
        lines.append(f"- {record.name}（{usable}）：{record.description}")
    return "可用技能：\n" + "\n".join(lines)


def _read_skill(services: Any, args: dict[str, Any]) -> str:
    name = str(args.get("name") or "").strip()
    if not name:
        return "缺少参数：name"
    record, body = services.skills.read(name)
    relative = str(args.get("file") or "").strip()
    if not relative:
        return f"【技能 {record.name}】\n{body}"
    path = _safe_attachment(record.directory, relative)
    if path is None:
        return "附属文件路径不合法（只能读技能目录里的文件）。"
    if not path.is_file():
        return f"技能里没有这个文件：{relative}"
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return f"读不出来：{exc}"
    return text[:MAX_ATTACHMENT_CHARS]


def _safe_attachment(directory: str, relative: str) -> Path | None:
    """把相对路径解析到技能目录**之内**。

    技能是可能从市场装来的第三方内容（见 services/skill_market.py 的防护），
    所以 `../..` 这类路径必须挡掉——否则一个技能就能让 agent 去读机器上任何文件。
    """
    root = Path(directory).resolve()
    try:
        candidate = (root / relative).resolve()
    except (OSError, ValueError):
        return None
    if not candidate.is_relative_to(root):
        return None
    return candidate


def _summary(name: str, payload: Any) -> str:
    """给过程面板一句人话。**只处理"结果里有条数"的那几个**，
    其余留给 `step_detail` 回退到结果开头——写死一堆猜的摘要不如不写。

    **裸列表也要认**（v0.22）：`list_knowledge_bases` 返回的就是一个 list，
    而第一版只处理 dict 里的 ``items``——于是那一行的回退路径把整个 JSON
    原样显示出来了（实测截图：面板里是
    ``[{"id": "kb_...", "name": "城市建成环境研究现状", "documents": 23…``）。
    "结果里有几条"这件事，无论外面包没包一层都一样要说得出来。

    ``items`` 只在这里算一次，**兜底那一条放在最后**：放在前面会把后面那些
    更具体的措辞（"回忆到 N 条"）挡掉——摘要写"共 2 条"没错，但不如说清是什么。
    """
    items = (
        payload
        if isinstance(payload, list)
        else (payload.get("items") if isinstance(payload, dict) else None)
    )
    if name == "list_knowledge_bases" and isinstance(items, list):
        return f"共 {len(items)} 个知识库"
    if name == "list_documents" and isinstance(payload, dict):
        total = payload.get("total")
        if isinstance(total, int):
            return f"共 {total} 篇文档"
    if name == "get_document_status" and isinstance(payload, dict):
        return f"当前阶段：{payload.get('stage') or '未知'}"
    if name == "recall" and isinstance(items, list):
        return f"回忆到 {len(items)} 条"
    if isinstance(items, list):
        return f"共 {len(items)} 条"
    return ""


def _render(payload: Any) -> str:
    """其余工具的结果：结构体走 JSON，字符串原样。"""
    if isinstance(payload, str):
        return payload
    try:
        return json.dumps(payload, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(payload)
