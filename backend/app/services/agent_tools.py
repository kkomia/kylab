"""Agent 的工具集：给模型看的规格 + 执行器（P0）。

与 `app/services/tools.py` 的关系是**同一份实现、两个门**：对外 MCP 客户端调
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
import threading
from collections.abc import Callable, Sequence
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any

from app.core.exceptions import InvalidRequestError
from app.core.logging import sanitize_log_value
from app.services import isolation as isolation_service
from app.services.agent_exec import run_command
from app.services.agent_files import (
    DEFAULT_READ_LINES,
    MAX_LIST_ENTRIES,
    MAX_SEARCH_HITS,
    list_files,
    read_file,
    resolve_roots,
    search_files,
)
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
from app.services.schedules import timezone_name
from app.services.tool_loop import ToolOutcome, ToolRunner
from app.services.tools import ARTIFACT_KEY, call_tool, tool_definitions

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
            "列出这台机器上的技能（SOP 文档）**安装与可用状态**。"
            "**可用技能的名字、描述与文件位置每一轮已经在你的系统提示词里**（"
            "「可用技能」那一段），所以平时不必调它；"
            "只有要确认「某个技能为什么不可用」（被安全扫描拦下、依赖没满足、或被丢弃）时才看。"
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
            "读一个技能的正文（它的流程与注意事项）——**正文不在提示词里，只能这样取**。"
            "技能名用系统提示词「可用技能」那一段里的名字（每行开头的那个）。"
            "带 `file` 参数时读该技能的附属文件（脚本、模板、参考）。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "技能名，来自系统提示词的技能目录"},
                "file": {
                    "type": "string",
                    "description": "附属文件的相对路径；省略则读 SKILL.md 正文",
                },
            },
            "required": ["name"],
        },
    },
)

#: **这台机器上的能力**（v0.33）：文件、执行、表格副本。
#:
#: 与 ``_SKILL_TOOLS`` 同一档：**只有对话这条门有**。它们的共同点是
#: "依赖这一轮的上下文"——工作区（会话挂的那个目录）、沙箱（这条会话的试错目录）、
#: 以及会话上选定的库范围。外部 MCP 客户端这三样都给不出，
#: 给它一个凭据不明的根或一份没有范围的表，比不给更糟。
_LOCAL_TOOLS: tuple[dict[str, Any], ...] = (
    {
        "name": "list_files",
        "description": (
            "列出一个目录里有**什么**（工作区或沙箱）。"
            "**不知道文件名时先列一遍**——search_files 要先知道搜什么。"
            "默认跳过 node_modules / .git / __pycache__ 这类依赖与缓存目录。"
            "给的路径是相对路径，可以直接回传给 read_file。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "目录的相对路径；留空 = 根目录"},
                "where": {
                    "type": "string",
                    "enum": ["workspace", "sandbox"],
                    "description": (
                        "看哪一侧：workspace = 对方的真实项目目录（默认），"
                        "sandbox = 你自己跑命令时的试错目录"
                    ),
                },
                "pattern": {"type": "string", "description": "按名字过滤，如 *.py；留空 = 全列"},
            },
        },
    },
    {
        "name": "read_file",
        "description": (
            "读一个文本文件的内容（按行分页，默认前 400 行）。"
            "**想看某个文件里到底写了什么时用它**；文件很长时会告诉你总行数，"
            "接着读用 offset。图片、压缩包、Office 文档读不了——"
            "要读那些的内容，先把它们加进知识库。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "文件的相对路径"},
                "where": {
                    "type": "string",
                    "enum": ["workspace", "sandbox"],
                    "description": "同 list_files；留空 = 有工作区就用工作区",
                },
                "offset": {"type": "integer", "description": "从第几行开始（从 1 计），默认 1"},
                "limit": {"type": "integer", "description": "读多少行，默认 400，上限 2000"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "search_files",
        "description": (
            "在工作区里**按内容搜**，回「哪个文件、第几行、那一行是什么」。"
            "**想知道某个函数在哪定义、某个配置在哪写的、哪个文件提到过某个词时用它**"
            "——比逐个文件读省得多。支持正则。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "要找的内容，支持正则"},
                "path": {"type": "string", "description": "在哪个子目录里搜；留空 = 整个根"},
                "where": {
                    "type": "string",
                    "enum": ["workspace", "sandbox"],
                    "description": "同 list_files",
                },
                "ignore_case": {"type": "boolean", "description": "忽略大小写，默认 true"},
            },
            "required": ["pattern"],
        },
    },
    {
        "name": "run_command",
        "description": (
            "**在沙箱里执行一条命令**，把输出拿回来。"
            "命令行的工作目录是沙箱目录（绝对路径见工具结果），工作区会被挂载成读写。"
            "适合：跑一段脚本算数、处理刚生成的文件、看依赖装没装、批量改名。"
            "**默认断网**（要联网得显式说明理由并让用户放行）。"
            "三道闸都在：不是管理员、策略没放行、机器上没有内核级隔离，"
            "这三种情况都会**明确拒绝并告诉你怎么放开**——被拒时不要重试同一条命令。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "要跑的命令（会被按 shell 词法拆成参数，但**不走 shell**）",
                },
                "argv": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "也可以直接给参数数组（更精确，推荐）；与 command 二选一",
                },
                "timeout_seconds": {
                    "type": "integer",
                    "description": (
                        f"超时秒数，默认 {int(isolation_service.DEFAULT_TIMEOUT_SECONDS)}"
                    ),
                },
                "allow_network": {
                    "type": "boolean",
                    "description": "是否允许联网（默认 false = 断网）",
                },
            },
        },
    },
    {
        "name": "list_tables",
        "description": (
            "列出**有结构化副本的表格文档**（入库的 CSV / Excel），带表名、列名与行数。"
            "**要回答统计类问题（一共多少、哪个月最高、按人汇总）时先调它**，"
            "再用 query_table 查——检索只给最相关的几行，答不了「一共」。"
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "query_table",
        "description": (
            "对表格副本跑一条**只读 SQL**（DuckDB 语法，只能 SELECT / WITH）。"
            "表名就是 list_tables 给的那个 document_id，列名就是 CSV 的表头。"
            "**聚合统计必须走它**：`SELECT sum(金额) FROM doc_xxx`。"
            "结果最多回几百行——要精确的数字请让 SQL 自己算（sum / count / group by）。"
            "它不能改数据、不能读写文件、也不能查这一轮范围之外的文档。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "sql": {"type": "string", "description": "一条 SELECT / WITH 查询"},
                "limit": {"type": "integer", "description": "最多回多少行，默认 100"},
            },
            "required": ["sql"],
        },
    },
    {
        "name": "schedule_task",
        "description": (
            "**挂一条定时任务**：到点自动替对方跑这句话，结果落在一条会话里。"
            "只在对方明确说「以后每天/每周…帮我做这件事」时才调——"
            "**不要替他决定要不要定时**。时间按**服务器时区**解释（工具结果里会说明是哪个时区）；"
            "一次性的事用 once + 具体时间，周期性的事用 cron（5 字段：分 时 日 月 周）。"
            "建完请把「什么时候跑、跑什么、结果在哪看」告诉对方。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "任务名（会用它当那条会话的标题）"},
                "prompt": {
                    "type": "string",
                    "description": (
                        "到点要问的那句话，写具体（如「把昨天的构建日志汇总成三条结论」）"
                    ),
                },
                "cron": {
                    "type": "string",
                    "description": (
                        "5 字段表达式：分 时 日 月 周。"
                        "例：`0 9 * * *` = 每天 9:00；`30 8 * * 1` = 每周一 8:30"
                    ),
                },
                "run_at": {
                    "type": "string",
                    "description": (
                        "一次性的时刻（ISO 8601，如 2026-09-21T09:00）。给了它就是一次性任务"
                    ),
                },
                "knowledge_base_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "到点查哪些库；留空 = 跟随这条对话的库范围",
                },
            },
            "required": ["name", "prompt"],
        },
    },
    {
        "name": "list_scheduled_tasks",
        "description": (
            "列出已经挂上的定时任务（下次什么时候跑、上次跑成没跑成）。"
            "**对方问「我之前让你定时做的事呢」时用它**，别凭记忆答。"
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
)

#: 这些工具**同样属于知识库那一侧**：关掉知识库开关时它们一起消失。
#: 判据是"数据从哪来"——表格副本就是入库文档的产物，用户关掉知识库时
#: 不该还留一条按 SQL 读库里内容的近路（与 ``_KB_TOOLS`` 同一条纪律）。
_LOCAL_KB_TOOLS = frozenset({"list_tables", "query_table"})

#: 文件三件事：一趟走 ``agent_files`` 的那三个函数（它们共用"两个根"的解析）。
_FILE_TOOLS = frozenset({"list_files", "read_file", "search_files"})


#: **知识库这一侧**的工具（v0.27）。
#:
#: 用户把会话上的知识库开关关掉时（这一轮的 ``kb_ids`` 为空），这些工具
#: **一个都不出现在工具表里**。改之前只是"检索会被拒绝"——工具照给，
#: 于是模型每轮都先 `list_knowledge_bases` 看一眼、再 `search` 一次，
#: 拿到一句"这一轮没有可查的知识库"，两个来回就这么花掉了
#: （用户报的现象："没开知识库，但每轮都去知识库检索"）。
#:
#: 边界**只画在知识库上**：记忆（`recall` / `remember`）与笔记（`create_note` /
#: `list_notes`）不属于这一侧——用户点名说过"这里的知识库不包括 agent 记忆"。
#: 而"把笔记加入知识库"（`attach_note_to_kb`）与"把产物存进知识库"
#: （`ingest_artifact`）**算**这一侧：它们动的是知识库。
_KB_TOOLS = frozenset(
    {
        "search",
        "list_knowledge_bases",
        "create_knowledge_base",
        "list_documents",
        "get_document_status",
        "delete_document",
        "upload_document",
        "add_data_source",
        "attach_note_to_kb",
        "ingest_artifact",
    }
)


def tool_specs(
    services: Any = None, *, owner_id: str | None = None, kb_ids: Sequence[str] | None = None
) -> list[ToolSpec]:
    """这一轮提供给模型的全部工具：内置 → 技能 → 外部 MCP 服务。

    ``services`` 给不给决定后两段在不在：

    - 不给（单测、纯规格检查）→ 只有内置工具，行为与 P0 时一致；
    - 给了 → 再加上外部服务暴露的工具。**只列调用方自己有权限用的那些**
      （``owner_id`` 收口，与能力页看到的同一批），否则会出现
      "别人登记的 MCP 服务在我的对话里被调起来"。

    外部那一段走**缓存**（见 ``MCPClientService.cached_tools``），所以这句话
    不便宜但也不贵：它是每轮一次的内存查找，不是每轮一次握手。

    ``kb_ids`` 是**这一轮允许查的库**（会话上选的那些）。为空 = 用户关掉了
    知识库开关，那就**别把知识库那一侧的工具摆给它**（见 ``_KB_TOOLS``）——
    给了又拒，只会白花两个来回（模型先看一眼有哪些库，再检索一次被拒）。
    **不传**（None）按"没有知识库"处理：与 ``build_runner`` 同一口径——
    没有范围就是查不了，那么工具表里也不该有它。
    """
    scope = [str(item) for item in (kb_ids or []) if str(item).strip()]
    specs = [
        ToolSpec(
            name=item["name"],
            description=str(item.get("description") or ""),
            # MCP 叫 inputSchema，OpenAI 叫 parameters——同一个东西，这里翻一次名
            parameters=_dialogue_parameters(item),
        )
        for item in tool_definitions()
        if scope or item["name"] not in _KB_TOOLS
    ]
    specs.extend(
        ToolSpec(
            name=item["name"],
            description=str(item["description"]),
            parameters=item["inputSchema"],
        )
        for item in _SKILL_TOOLS
    )
    # 这台机器上的能力（文件 / 执行 / 表格）**排在内置与技能之后、外部服务之前**：
    # 前两段是我们担保的，外部的东西排最后（见模块头）。
    specs.extend(
        ToolSpec(
            name=item["name"],
            description=str(item["description"]),
            parameters=item["inputSchema"],
        )
        for item in _LOCAL_TOOLS
        if scope or item["name"] not in _LOCAL_KB_TOOLS
    )
    if services is not None:
        specs.extend(_mcp_specs(services, owner_id))
    return specs


#: 在**对话这条门**上不收 ``knowledge_base_id`` 的工具（v0.26）。
#:
#: 外部门（MCP）保持原契约：那条通道没有会话，产物唯一的落点就是知识库，
#: 而且"外部客户端点名叫了哪个库"这件事本身就是显式的。
#: 对话这条门不一样：产物先落盘，入库是另一个动作。**参数留在这里过不了日子**——
#: 它是可选的，模型就会在某些时候顺手填上；而它一旦被填上，
#: 它就会重新开始替用户挑库（这正是"把 docx 塞进「笔记」"的成因）。
_DIALOGUE_DROPS_KB = frozenset({"export_document", "export_table", "export_deck"})


def _dialogue_parameters(item: dict[str, Any]) -> dict[str, Any]:
    """把内置工具的 schema 调成**对话这条门**该有的样子。

    目前只有一件事：导出类工具不再向模型暴露 ``knowledge_base_id``。
    """
    schema = item.get("inputSchema") or {"type": "object", "properties": {}}
    if item["name"] not in _DIALOGUE_DROPS_KB:
        return schema
    properties = {
        key: value
        for key, value in (schema.get("properties") or {}).items()
        if key != "knowledge_base_id"
    }
    return {**schema, "properties": properties}


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
    conversation_id: str | None = None,
    subagent: Callable[[str], tuple[str, list[Any]]] | None = None,
    seed_sources: Sequence[SourceRef] = (),
) -> ToolRunner:
    """绑一个执行器。``kb_ids`` 是**这一轮允许查的库**（会话上选的那些）。

    ``conversation_id`` 决定**产物落在哪儿**（v0.26，见 ``services/artifacts.py``）：
    挂在工作的会话落进工作区目录，没挂的落进对象存储里按会话分的临时前缀。
    没有它（外部 MCP 客户端、一次性脚本）时导出类工具只剩"直接入库"那一条路。

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

    **账本是共享可变状态，所以要加锁**（v0.27）：工具循环会把同一批里的几次调用
    并发跑（见 ``tool_loop._execute_batch``），而两个检索线程同时进 ``_absorb``
    会抢同一个编号——两边都读到"账本里有 3 条"，各自从 4 开始编，于是同一段资料
    拿到同一个号、或者一条编号谁也没占。去重、顺延编号、取快照这三件事
    因此都在同一把锁里做完。
    """
    scope = [str(item) for item in (kb_ids or []) if str(item).strip()]
    # 有些调用点（子 Agent 的测试、脚本）没有凭据主体，那就是**共享桶**
    # （``None``），与"管理员/API Key 通道"同一档——不是错误，不给它编一个身份。
    owner_id = caller.owner_id if caller is not None else None
    # ``seed_sources``：**续跑**时把上一轮已经拿到的出处接着带上（见 services/resume.py）。
    # 必须从这里进来，不能只写进提示词——提示词里告诉模型"[3] 是那份共识"，
    # 而账本里没有第 3 条，它引用出来的编号就会指向别的资料。
    # 编号从 1 重排：与提示词里给它的编号是同一套。
    book: list[SourceRef] = _renumber(list(seed_sources), offset=0)
    book_lock = threading.Lock()

    def _record(incoming: Sequence[SourceRef]) -> list[SourceRef]:
        """把一批新资料并进账本，返回**真正新增**的那些（编号已排好）。"""
        with book_lock:
            return _absorb(book, list(incoming))

    def _snapshot() -> list[SourceRef]:
        """当前账本的副本。**与 ``_record`` 同一把锁**：读的时候可能正有人在写。"""
        with book_lock:
            return list(book)

    #: 两个根（工作区 / 沙箱）**按需解析、一轮里只解析一次**：多数回合压根不碰文件，
    #: 而解析要查一次会话与工作区（两次查询）。用列表当格子是为了在闭包里赋值。
    _roots_cache: list[Any] = []

    def _roots():  # type: ignore[no-untyped-def]
        if not _roots_cache:
            _roots_cache.append(
                resolve_roots(services, conversation_id=conversation_id, caller=caller)
            )
        return _roots_cache[0]

    def run(name: str, args: dict[str, Any], *, approval: str | None = None) -> ToolOutcome:
        """``approval`` 只有 ``run_command`` 用得上（v0.41）：``ask`` 档下工具循环
        会先把这条命令**问成一条待确认**（执行器登记、循环发事件并等人回答），
        拿到决定之后带着它把这一条重跑一遍——见 ``tool_loop._resolve_approvals``。"""
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
            refs = _record(list(sources))
            return ToolOutcome(
                content=answer or "（子 Agent 没有给出结论）",
                sources=_snapshot(),
                summary="子 Agent 回报了结论",
                added=len(refs),
            )
        if name == "list_skills":
            return ToolOutcome(content=_render_skills(services))
        if name == "read_skill":
            return ToolOutcome(content=_read_skill(services, args))
        if name in _FILE_TOOLS:
            return _run_file_tool(name, _roots(), args)
        if name == "run_command":
            outcome = run_command(
                services, caller, conversation_id=conversation_id, args=args, approval=approval
            )
            return ToolOutcome(
                content=outcome.text, summary=outcome.summary, approval=outcome.approval
            )
        if name == "list_tables":
            return _list_tables(services, scope)
        if name == "query_table":
            return _query_table(services, scope, args)
        if name == "schedule_task":
            return _schedule_task(services, caller, scope, args)
        if name == "list_scheduled_tasks":
            return _list_scheduled(services, caller)
        if name == "search":
            scoped = _scope_search(args, scope)
            if scoped is None:
                return ToolOutcome(content=_NO_KB_SCOPE)
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
            refs = _record(
                services.chat.retrieve_sources(
                    query=str(scoped.get("query") or ""),
                    kb_ids=kb_ids,
                    top_k=_int_or_none(scoped.get("top_k")),
                )
            )
            if refs:
                content = _render_sources(refs)
                summary = f"命中 {len(refs)} 段原文"
            else:
                # 两种情况要分开说：库里真没有，与"命中的前面都给过了"。
                # 都回 `_render_sources([])` 那句"没有命中任何片段"，模型会把后者
                # 读成前者，于是放弃换角度的尝试——而它其实只是重复查了同一处。
                content = (
                    "这一次没有新增片段：命中的内容前面已经给过（或这个库里没有相关的）。"
                    "请基于已有资料作答；还要查就换一个角度或关键词。"
                )
                summary = "没有新的片段"
            return ToolOutcome(
                content=content,
                # **累计列表**（协议约定：多轮检索多次发出，始终是累计的）：
                # 只发这一批的话，先查到的那些资料会在界面上消失
                sources=_snapshot(),
                summary=summary,
                added=len(refs),
            )
        payload = call_tool(services, name, args, caller=caller, conversation_id=conversation_id)
        # 产出物**先摘走、再渲染**：那个键是给界面用的，模型不该看到一份
        # 自己结果的副本（它会照着复述，白占上下文）。顺序不能反。
        artifacts: list[dict[str, object]] = []
        if isinstance(payload, dict) and ARTIFACT_KEY in payload:
            raw = payload.pop(ARTIFACT_KEY)
            if isinstance(raw, dict):
                artifacts = [dict(raw)]
        return ToolOutcome(
            content=_render(payload),
            summary=_summary(name, payload),
            artifacts=artifacts,
        )

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
    return [replace(ref, index=offset + position) for position, ref in enumerate(refs, start=1)]


def _absorb(book: list[SourceRef], incoming: Sequence[SourceRef]) -> list[SourceRef]:
    """把一批新资料并进这一轮的账本，返回**真正新增**的那些（已接着现有编号排好）。

    去重按 ``chunk_id``：一轮里可以查好几次，换了检索词但落点相同是常事。
    不去重的话同一段会占两个引用号——界面上两条一模一样的出处，
    而模型可能各引一次，读者会以为那是两份不同的资料。

    **先到的那条保留原编号，不因为"这次分数更高"替换**：编号在第一次检索时就已经
    渲染给模型了（``[n]`` 写在工具结果里），重排会让它先前写下的引用指向别处。
    代价是同一段保留的分数未必是最高那次——分数只用于排序与阈值过滤，
    不影响引用关系，所以这个取舍是划算的。

    返回值同时也是"这一步新增了几段"的口径（`ToolOutcome.added`）。
    """
    known = {item.chunk_id for item in book}
    fresh: list[SourceRef] = []
    for ref in incoming:
        if ref.chunk_id in known:
            continue
        known.add(ref.chunk_id)
        fresh.append(ref)
    refs = _renumber(fresh, offset=len(book))
    book.extend(refs)
    return refs


def _int_or_none(value: Any) -> int | None:
    """``top_k`` 可能是模型给的字符串（有些模型把数字包成 ``"6"``）或缺失。"""
    if isinstance(value, bool):  # bool 是 int 的子类，这里必须先排掉
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


# ------------------------------------------------------------------ 文件 / 表格


def _run_file_tool(name: str, roots: Any, args: dict[str, Any]) -> ToolOutcome:
    """文件三件事的入口。**结果渲染成文本而不是 JSON**：文件内容与列目录的
    换行在 JSON 里会变成一屏 ``\\n``，而这段文本是给模型读的（与 ``_web_fetch`` 同理）。"""
    if name == "list_files":
        payload = list_files(
            roots,
            where=args.get("where"),
            path=str(args.get("path") or ""),
            pattern=str(args.get("pattern") or ""),
            limit=_int_or_none(args.get("limit")) or MAX_LIST_ENTRIES,
        )
        entries = payload["entries"] if isinstance(payload["entries"], list) else []
        lines = [
            f"{'d' if item['type'] == 'dir' else 'f'} {item['path']}"
            + (f"（{_size_text(item['size_bytes'])}）" if item["type"] == "file" else "")
            for item in entries
        ]
        head = f"{payload['where']}:{payload['path']} 共 {payload['total']} 项"
        return ToolOutcome(
            content=_join_blocks(
                head, chr(10).join(lines) or "（这个目录是空的）", str(payload["note"])
            ),
            summary=f"{payload['where']} 下 {payload['total']} 项",
        )
    if name == "read_file":
        payload = read_file(
            roots,
            where=args.get("where"),
            path=str(args.get("path") or ""),
            offset=_int_or_none(args.get("offset")) or 1,
            limit=_int_or_none(args.get("limit")) or DEFAULT_READ_LINES,
        )
        head = (
            f"【{payload['where']}:{payload['path']}】"
            f"第 {payload['offset']}–{payload['offset'] + payload['lines'] - 1} 行"
            f"（共 {payload['total_lines']} 行，{_size_text(payload['size_bytes'])}）"
        )
        return ToolOutcome(
            content=_join_blocks(
                head, str(payload["text"]) or "（这个文件是空的）", str(payload["note"])
            ),
            summary=f"读了 {payload['lines']} 行",
        )
    payload = search_files(
        roots,
        where=args.get("where"),
        path=str(args.get("path") or ""),
        pattern=str(args.get("pattern") or ""),
        ignore_case=args.get("ignore_case") is not False,
        limit=_int_or_none(args.get("limit")) or MAX_SEARCH_HITS,
    )
    hits = payload["hits"] if isinstance(payload["hits"], list) else []
    lines = [f"{item['path']}:{item['line']}: {item['text']}" for item in hits]
    head = (
        f"搜「{payload['pattern']}」：命中 {payload['total']} 处"
        f"（扫了 {payload['scanned_files']} 个文件）"
    )
    return ToolOutcome(
        content=_join_blocks(head, chr(10).join(lines) or "（没有命中）", str(payload["note"])),
        summary=f"命中 {payload['total']} 处" if hits else "没有命中",
    )


def _list_tables(services: Any, scope: list[str]) -> ToolOutcome:
    """列有结构化副本的表格。范围与 ``search`` 同一套：**会话选定的那些库**。"""
    if not scope:
        return ToolOutcome(content=_NO_KB_SCOPE, summary="没有可查的知识库")
    items = services.tabular.tables(kb_ids=scope)
    if not items:
        return ToolOutcome(
            content=(
                "这一轮能查的库里没有表格文档（只有 CSV / Excel 会有结构化副本）。"
                "PDF、Word 里的表格答不了统计问题——那是检索的活。"
            ),
            summary="没有表格可查",
        )
    lines = []
    for item in items:
        columns = "、".join(str(name) for name in item["columns"])
        lines.append(f"{item['document_id']}（{item['name']}，{item['rows']} 行）\n  列：{columns}")
    return ToolOutcome(
        content=_join_blocks(
            "有结构化副本的表格（SQL 里用这个 id 当表名）：",
            chr(10).join(lines),
            "统计类问题用 query_table 跑 SQL；只是想看几行原文用 read_document 那条路（检索）。",
        ),
        summary=f"{len(items)} 张表",
    )


def _query_table(services: Any, scope: list[str], args: dict[str, Any]) -> ToolOutcome:
    if not scope:
        return ToolOutcome(content=_NO_KB_SCOPE, summary="没有可查的知识库")
    sql = str(args.get("sql") or "")
    try:
        payload = services.tabular.query_sql(
            sql=sql, kb_ids=scope, limit=_int_or_none(args.get("limit")) or 100
        )
    except Exception as exc:
        # 报错**原样回给模型**：里面的措辞是照着"它下一步该怎么做"写的
        # （表名不在范围内会告诉它能用哪些表），包装成"查询失败"就白写了
        logger.info("表格查询被拒或失败：%s", sanitize_log_value(exc))
        return ToolOutcome(content=str(exc), summary="查询没跑成")
    columns = [str(item) for item in payload["columns"]]
    rows: list = payload["rows"] if isinstance(payload["rows"], list) else []
    body = _table_text(columns, [[str(cell) for cell in row] for row in rows])
    return ToolOutcome(
        content=_join_blocks(
            f"SQL：{payload['sql']}",
            body,
            f"{len(rows)} 行" + ("（已达上限，可能还有更多）" if payload["truncated"] else ""),
            str(payload["note"]),
        ),
        summary=f"查到 {len(rows)} 行" if rows else "查询没有结果",
    )


def _table_text(columns: list[str], rows: list[list[str]]) -> str:
    """结果渲染成 Markdown 表。**不用 JSON**：模型对表格形状的读数比一层
    字段名包着的数组准（它要念的是"这一列是什么"）。单元格按 60 字截断——
    一格里塞一篇正文会让整张表没法看，而那种内容本来也不该进 SELECT *。"""
    head = "| " + " | ".join(columns) + " |"
    rule = "| " + " | ".join("---" for _ in columns) + " |"
    body = ["| " + " | ".join(cell[:60].replace("|", "\\|") for cell in row) + " |" for row in rows]
    return "\n".join([head, rule, *body])


def _join_blocks(*blocks: str) -> str:
    return "\n\n".join(item for item in blocks if item and item.strip())


# ------------------------------------------------------------------ 定时任务


def _schedule_task(
    services: Any, caller: Caller, scope: list[str], args: dict[str, Any]
) -> ToolOutcome:
    """挂一条定时任务（v0.33）。

    **库范围默认跟随这条对话**（而不是空）：模型在对话里被要求"以后每天帮我盯这件事"，
    它手里最合理的资料范围就是此刻这一轮的库——留给它一个空白字段，
    它要么编一个、要么把库全勾上，两种都不如"跟现在一样"。

    时间的解释权在服务层（cron 的解析只有一份），报错原文回给模型：
    那里的措辞是照着"怎么改对"写的。
    """
    sessions = getattr(services, "schedules", None)
    if sessions is None:  # pragma: no cover - 只在手工拼 Services 的测试里出现
        return ToolOutcome(content="这台服务没有启用定时任务。", summary="定时任务不可用")
    name = str(args.get("name") or "").strip()
    prompt = str(args.get("prompt") or "").strip()
    run_at_text = str(args.get("run_at") or "").strip()
    cron_text = str(args.get("cron") or "").strip()
    asked = [str(item) for item in (args.get("knowledge_base_ids") or []) if str(item)]
    # 先解析时间（**在 try 之外**）：格式不对是"参数给错了"，该作为工具错误抛出去，
    # 而不是被下面那段"建失败"的兜底吞成一句内容（那样模型看不出自己写错了格式）
    when = _parse_when(run_at_text) if run_at_text and not cron_text else None
    try:
        record = sessions.create(
            name=name,
            prompt=prompt,
            # 给了具体时间就是一次性的；两个都没给时按"每天"处理并让 cron 校验去报错
            kind="once" if when is not None else "cron",
            cron=cron_text,
            run_at=when,
            kb_ids=asked or scope,
            owner_id=caller.owner_id,
        )
    except Exception as exc:
        logger.info("定时任务建失败：%s", sanitize_log_value(exc))
        return ToolOutcome(content=str(exc), summary="定时任务没建成")
    return ToolOutcome(
        content=_join_blocks(
            f"已挂上定时任务「{record.name}」（{sessions.next_run_text(record)}，"
            f"按 {timezone_name()} 计算）。",
            "到点它会自己跑一遍，结果落在一条同名会话里——对方可以在「任务中心 → 定时任务」"
            "看到它，也可以点「立即跑一次」当场试验。",
        ),
        summary=f"已挂上定时任务：{sessions.next_run_text(record)}",
    )


def _list_scheduled(services: Any, caller: Caller) -> ToolOutcome:
    sessions = getattr(services, "schedules", None)
    if sessions is None:  # pragma: no cover
        return ToolOutcome(content="这台服务没有启用定时任务。", summary="定时任务不可用")
    records = sessions.list(owner_id=caller.owner_id)
    if not records:
        return ToolOutcome(content="还没有挂过定时任务。", summary="没有定时任务")
    lines = []
    for item in records:
        state = "启用" if item.enabled else "已停用"
        last = {
            "ok": "上次跑成了",
            "degraded": "上次没跑完（撞上步数或时间闸）",
            "failed": f"上次失败：{item.last_error[:80]}",
        }.get(item.last_status, "还没跑过")
        lines.append(
            f"- {item.name}（{state}，{sessions.next_run_text(item)}）：{item.prompt[:60]}"
            f"\n  下次：{_local_text(item.next_run_at)}；{last}"
        )
    return ToolOutcome(
        content="已挂的定时任务：\n" + "\n".join(lines), summary=f"{len(records)} 条定时任务"
    )


def _parse_when(text: str) -> datetime:
    """把 ``run_at`` 解析成时间。**不带时区的按服务器本地时间解释**——
    与界面上的 datetime-local 同一口径（用户填的是他看到的钟点）。"""
    cleaned = text.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(cleaned)
    except ValueError as exc:
        raise InvalidRequestError(
            f"run_at 不是合法的时间：{text!r}（用 ISO 8601，如 2026-09-21T09:00）"
        ) from exc


def _local_text(moment: datetime | None) -> str:
    if moment is None:
        return "不会再跑"
    return moment.astimezone().strftime("%Y-%m-%d %H:%M")


def _size_text(value: object) -> str:
    if not isinstance(value, int):
        return "大小未知"
    if value < 1024:
        return f"{value} B"
    if value < 1024 * 1024:
        return f"{value / 1024:.1f} KB"
    return f"{value / (1024 * 1024):.1f} MB"


#: 关掉知识库开关时那三个知识库工具统一用这句话（避免三处各写一份措辞）。
_NO_KB_SCOPE = (
    "这一轮没有可查的知识库（对方关掉了知识库，或本会话没选库）。"
    "需要资料的话，先把这个问题告知对方，不要凭常识补。"
)


# ------------------------------------------------------------------ 技能


def _render_skills(services: Any) -> str:
    """列全部技能（这是"想看全部字段"时才调的——目录每轮已经在提示词里了）。

    两种"不可用"要**分开说**（v0.43）：`discarded` 是没通过格式校验的
    （缺字段、描述超 1024——照 ZCode 的规则丢弃），`used_by_prompt=False`
    是别的缘故（例如同名被更高优先级的技能遮蔽）。混成一句"被拦下"，
    用户没法知道该改什么。
    """
    records = services.skills.list()
    if not records:
        return "这台机器上还没有安装技能。"
    lines = []
    for record in records:
        if getattr(record, "discarded", False):
            reason = str(getattr(record, "flagged", "") or "没通过格式校验")
            usable = f"已丢弃（{reason}）"
        elif record.used_by_prompt:
            usable = "可用"
        else:
            usable = "被同名技能遮蔽（不进提示词）"
        lines.append(f"- {record.name}（{usable}）：{record.description}")
    return "全部技能：\n" + "\n".join(lines)


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
    if name == "list_notes" and isinstance(payload, dict):
        total = payload.get("total")
        if isinstance(total, int):
            return f"共 {total} 条笔记"
    if name in ("export_document", "export_table", "export_deck") and isinstance(payload, dict):
        # 这一条原先没人写，于是过程面板里**把整个 JSON 铺了出来**
        # （实测截图：`{"artifact_id": "art_89cb…", "name": "酒馆战棋S14上分攻略….pptx"…`）
        size = payload.get("size_bytes")
        size_text = f"（{int(size) // 1024} KB）" if isinstance(size, int) else ""
        return f"已生成「{payload.get('name') or '文件'}」{size_text}"
    if name == "ingest_artifact" and isinstance(payload, dict):
        return f"已存进知识库：{payload.get('name') or ''}".rstrip("：")
    if name == "remember" and isinstance(payload, dict):
        # 那三段 note 是**给模型看的操作说明**，不是给用户看的结论——
        # 原来它整段出现在过程面板里，用户读到的是"一条只记一句可复用的事实"
        return "已写入长期记忆" if payload.get("saved") else "这条已经在长期记忆里了"
    if name == "create_note" and isinstance(payload, dict):
        return f"已存为笔记「{payload.get('title') or ''}」"
    if name == "attach_note_to_kb" and isinstance(payload, dict):
        return "已把笔记加入知识库"
    if name == "create_knowledge_base" and isinstance(payload, dict):
        return f"已新建知识库「{payload.get('name') or ''}」"
    if name == "upload_document" and isinstance(payload, dict):
        suffix = "（库里已有同样的内容）" if payload.get("is_duplicate") else ""
        return f"已上传「{payload.get('name') or ''}」{suffix}"
    if name == "add_data_source" and isinstance(payload, dict):
        return f"已登记数据源「{payload.get('name') or ''}」"
    if name == "delete_document" and isinstance(payload, dict):
        return "已删除这份文档（7 天内可恢复）"
    if name == "search" and isinstance(payload, dict):
        hits = payload.get("hits")
        if isinstance(hits, list):
            return f"命中 {len(hits)} 段原文" if hits else "没有命中任何片段"
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
