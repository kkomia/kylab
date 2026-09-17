"""Agent 的工具集：给模型看的规格 + 执行器（P0）。

与 `app/mcp_server/tools.py` 的关系是**同一份实现、两个门**：对外 MCP 客户端调
`call_tool`，对内由 `services/tool_loop.py` 调这里的 runner。所以"知识库降级成一个工具"
几乎是免费的——`search` 早就是那 13 个工具之一，只是以前的对话循环没走它。

只有两处是内部门特有的：

1. **技能工具**（`list_skills` / `read_skill`）：它们是"读自己身上的说明书"，
   对外部 MCP 客户端没有意义（那个客户端自己就是 agent）。
2. **检索要收在会话选定的库范围内**（见 `build_runner`）：知识库不再是回答的框架，
   但"这一轮允许查哪些库"仍然要说清楚——否则关掉开关之后，模型一句
   `search` 就能把库全查了，那个开关就成了摆设。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from app.mcp_server.tools import call_tool, tool_definitions
from app.services.api_key import Caller
from app.services.chat import SourceRef
from app.services.llm import ToolSpec
from app.services.tool_loop import ToolOutcome, ToolRunner

__all__ = ["build_runner", "tool_specs"]

logger = logging.getLogger(__name__)

#: 单个技能附件最多读多少字符。技能里的脚本可能很大，读进来就是上下文成本。
MAX_ATTACHMENT_CHARS = 20000

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


def tool_specs() -> list[ToolSpec]:
    """这一轮提供给模型的全部工具。

    两项顺序照旧（内置在前、技能在后）：模型对"先看到什么"有轻微偏好，
    而内置工具是日常用得最多的那批。
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
    return specs


def build_runner(
    services: Any,
    caller: Caller,
    *,
    kb_ids: Sequence[str] | None = None,
) -> ToolRunner:
    """绑一个执行器。``kb_ids`` 是**这一轮允许查的库**（会话上选的那些）。

    范围规则（三条，都与"关掉开关就该真的查不到"一致）：

    - 有范围、模型没指定库 → 用这个范围（它通常压根不知道有哪些库，逼它先列一遍
      是多余的一步）；
    - 有范围、模型指定了库 → **取交集**；交集为空就报错，并把它能查的库告诉它；
    - 没范围（用户关掉了知识库开关）→ 检索直接拒绝，并说明"要查资料得让对方打开"。
      这一条是那个开关的意义所在：它不该只挡界面。
    """
    scope = [str(item) for item in (kb_ids or []) if str(item).strip()]

    def run(name: str, args: dict[str, Any]) -> ToolOutcome:
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
            payload = call_tool(services, name, scoped, caller=caller)
            hits = payload.get("hits") if isinstance(payload, dict) else None
            return ToolOutcome(
                content=_render_search(payload),
                sources=_sources_of(payload),
                summary=f"命中 {len(hits or [])} 段原文",
            )
        payload = call_tool(services, name, args, caller=caller)
        return ToolOutcome(content=_render(payload), summary=_summary(name, payload))

    return run


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


def _render_search(payload: Any) -> str:
    """把检索结果渲染成**带编号的文本块**。

    不直接 `json.dumps`：模型接下来要给这些片段编引用号，而 JSON 里的字段名
    会把"编号"这件事弄糊（它分不清哪个是该引的数字）。这里的编号就是
    `SourceRef.index`——界面上的 [1][2] 与它一一对应。
    """
    if not isinstance(payload, dict):
        return _render(payload)
    hits = payload.get("hits") or []
    if not hits:
        note = payload.get("note") or ""
        return f"没有命中任何片段。{note}".strip()
    lines: list[str] = []
    for index, hit in enumerate(hits, start=1):
        where = str(hit.get("document_name") or "")
        if hit.get("heading_path"):
            where += f" › {hit['heading_path']}"
        if hit.get("page") is not None:
            where += f"（第 {hit['page']} 页）"
        lines.append(f"[{index}] {where}\n{hit.get('text') or ''}")
    return "\n\n".join(lines)


def _sources_of(payload: Any) -> list[SourceRef]:
    """检索结果 → 界面用的出处。**取不到就少给，不编**。"""
    if not isinstance(payload, dict):
        return []
    sources: list[SourceRef] = []
    for index, hit in enumerate(payload.get("hits") or [], start=1):
        try:
            sources.append(
                SourceRef(
                    index=index,
                    chunk_id=str(hit.get("chunk_id") or ""),
                    document_id=str(hit.get("document_id") or ""),
                    document_name=str(hit.get("document_name") or ""),
                    heading_path=hit.get("heading_path"),
                    page=hit.get("page"),
                    score=float(hit.get("score") or 0.0),
                    preview=str(hit.get("text") or ""),
                    knowledge_base_id=str(hit.get("knowledge_base_id") or ""),
                )
            )
        except (TypeError, ValueError):
            logger.info("一条检索结果无法转成出处，跳过", exc_info=True)
    return sources


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
    """
    if name == "list_knowledge_bases" and isinstance(payload, dict):
        items = payload.get("items")
        if isinstance(items, list):
            return f"共 {len(items)} 个知识库"
    if name == "list_documents" and isinstance(payload, dict):
        total = payload.get("total")
        if isinstance(total, int):
            return f"共 {total} 篇文档"
    if name == "get_document_status" and isinstance(payload, dict):
        return f"当前阶段：{payload.get('stage') or '未知'}"
    if name == "recall" and isinstance(payload, dict):
        items = payload.get("items")
        if isinstance(items, list):
            return f"回忆到 {len(items)} 条"
    return ""


def _render(payload: Any) -> str:
    """其余工具的结果：结构体走 JSON，字符串原样。"""
    if isinstance(payload, str):
        return payload
    try:
        return json.dumps(payload, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(payload)
