"""工具元数据表：**并发放行、审批口径、界面分类都读这一张表**（v0.42）。

照抄 ZCode 的工具六字段与 DSH 的 fail-closed 调度，见
《Agent-与对话架构对标调研 v0.1》§2.2。三家（ZCode / DSH / QwenPaw）在这件事上
收敛得很一致：**工具的元数据同时是"给模型看的说明"与"给引擎用的策略"**，
两边各写一套必然相漂。

| 字段 | 它回答的问题 |
| --- | --- |
| ``read_only`` | 会不会改东西（只读的可以随便重放、可以审计） |
| ``destructive`` | 会不会删/覆盖（比 read_only 更严一档） |
| ``concurrent_safe`` | 能不能和同一批里的别的调用**同时**跑 |
| ``side_effect_scope`` | 影响面：``none``/``session``/``workspace``/``system``/``network`` |
| ``risk_level`` | ``low`` / ``medium`` / ``high`` / ``critical`` |
| ``needs_approval`` | 这一档是不是**总是**要问用户（策略之外的第二道） |

## 为什么这件事是个安全修复，不只是抄

v0.41 之前，工具循环把**一批调用一律并发**（``tool_loop._execute_batch``）——
"读三页网页"确实该并发，但"导出文档 + 建笔记 + 上传文档"并发就是在赌它们之间没有共享状态，
而这个赌注是隐式的：加一个写类工具的人根本不知道自己在被并发调用。
ZCode 的判定是 ``concurrentSafe && !destructive && !needsApproval && scope == "none"``，
DSH 是 **fail-closed**（没声明或判定抛异常一律当独占）。这里照抄两者的交集：

- **默认独占**（未知工具 = 不并发）：加新工具忘了声明，最坏是慢一点，不是坏数据；
- 只有显式声明 ``concurrent_safe=True`` 的才进同一个并发组（例如只读检索、抓网页）；
- 独占调用是**天然的屏障**：它自己一组，前后两组不会跨过它并发。

## 还没接的字段（写在这里，免得被当成死数据）

``side_effect_scope`` / ``risk_level`` / ``needs_approval`` 是给后面两件事预备的：
P1-1 的 agent 模式（plan 档按 scope 拦写类工具）与 P2-1 的界面（工具卡按 risk 显示徽标）。
**在它们落地之前，这三个字段只被"表要完整"这条门禁用到**（见
``tests/unit/services/test_tool_meta.py``：内置工具一个都不能漏）——这是刻意的：
先定字段名与取值，抄的时候不至于各写各的。
"""

from __future__ import annotations

from dataclasses import dataclass

__all__ = [
    "KINDS",
    "RISKS",
    "SCOPES",
    "TOOL_META",
    "ToolMeta",
    "kind_of",
    "meta_of",
    "parallel_groups",
]

#: 影响面取值（照 ZCode 的 ``sideEffectScope``）。
SCOPES: tuple[str, ...] = ("none", "session", "workspace", "system", "network")

#: 风险分级（照 ZCode 的 ``riskLevel``；``critical`` 留给"不可逆的外部动作"）。
RISKS: tuple[str, ...] = ("low", "medium", "high", "critical")

#: 工具卡的**语义种类**（P2-1，照 ZCode 的固定枚举，见调研报告 §2.5 第 1 条）。
#:
#: ZCode 的工具卡只认``（kind, status, input, output）``四元组，kind 是**类别**
#: 而不是工具名——所以它加几十个工具不用动界面。我们照这条：
#: 种类在这里定、随 ``StepEvent.kind`` 发给界面，界面按它选图标与配色，
#: **工具名只用来显示**（那一行的中文标签）。
#:
#: 九档，对应"这件事对用户是什么"（前八档照 ZCode 的枚举，``tool`` 是补的那一档）：
#:
#: | kind | 是什么 |
#: | --- | --- |
#: | ``read`` | 读一眼：列清单、看状态、读文件 |
#: | ``search`` | 找东西：检索、联网搜、抓网页、在文件里搜 |
#: | ``write`` | 写入/产出：建库、上传、写笔记、导出、挂定时任务 |
#: | ``delete`` | 删除/覆盖（不可逆） |
#: | ``exec`` | 在这台机器上跑东西 |
#: | ``skill`` | 技能目录与技能正文 |
#: | ``session`` | 动的是这一轮的会话上下文（子 Agent、会话内的产物） |
#: | ``message`` | 消息/回复（**今天没有内置工具用它**：留给"发消息"那一类） |
#: | ``tool`` | 认不出来的（外部 MCP 工具）：中性一档，不猜 |
#:
#: ``tool`` 这一档是**我们补的第九个取值**（八档之外），理由是一条实测过的坑：
#: 未知工具的元数据是 fail-closed（``_UNKNOWN``，按"动整台机器"算），
#: 把它画成 ``exec`` 会让界面上一个只读的 MCP 工具看起来像"在跑命令"——
#: 策略上的保守是对的，**显示上的保守不能靠同一档**。
KINDS: tuple[str, ...] = (
    "read",
    "search",
    "write",
    "delete",
    "exec",
    "skill",
    "session",
    "message",
    "tool",
)


@dataclass(frozen=True, slots=True)
class ToolMeta:
    """一个工具的元数据。**只读是默认**——不声明的工具按最保守的解释走。"""

    read_only: bool = False
    destructive: bool = False
    concurrent_safe: bool = False
    #: 影响面。默认 ``system``：不知道它动什么，就按"可能动整台机器"算。
    side_effect_scope: str = "system"
    risk_level: str = "high"
    needs_approval: bool = False

    @property
    def parallel(self) -> bool:
        """能不能进并发组（ZCode 的判定，取 DSH 的 fail-closed 兜底）。

        **一处有据的偏离**：ZCode 的字面判定是 ``sideEffectScope == "none"``，
        那会把联网工具（搜索、抓网页）也串行化——而 KYLAB 这边恰恰相反，
        "一批抓三页"是实测省下最多时间的那一类（v0.27：三页串行 3 秒、并行 1.2 秒），
        也是系统提示词第 2 条鼓励模型做的事。两家对 ``sideEffectScope`` 的用法不同：
        ZCode 那一档把"碰网络"和"可能写"混在一个枚举里，我们的 ``network``
        明确是**只发请求、不改任何东西**（它上面还压着 ``read_only`` 这一位）。
        所以这里放宽到 ``none`` 与 ``network``：**真正的门槛是"不动东西"**。
        """
        return (
            self.concurrent_safe
            and not self.destructive
            and not self.needs_approval
            and self.side_effect_scope in ("none", "network")
        )


#: 一个"只读 + 可并发 + 无副作用"的模板：检索、列举、读文件都归它。
_READ = ToolMeta(
    read_only=True,
    concurrent_safe=True,
    side_effect_scope="none",
    risk_level="low",
)

#: **表**。键是工具名（与 ``tools.TOOL_NAMES`` / ``agent_tools`` 里那几组一致）。
#:
#: 取值只看两件事：**它动不动东西**、**动了什么**。改一处之前先问一句
#: "它能不能和同批的别的调用同时跑"——这正是这张表存在的理由。
TOOL_META: dict[str, ToolMeta] = {
    # ---- 知识库（内置那批，见 services/tools.py）----
    "list_knowledge_bases": _READ,
    "create_knowledge_base": ToolMeta(side_effect_scope="workspace", risk_level="medium"),
    "upload_document": ToolMeta(side_effect_scope="workspace", risk_level="medium"),
    "add_data_source": ToolMeta(side_effect_scope="workspace", risk_level="medium"),
    "search": _READ,
    "list_documents": _READ,
    "get_document_status": _READ,
    "delete_document": ToolMeta(
        destructive=True, side_effect_scope="workspace", risk_level="high"
    ),
    "create_note": ToolMeta(side_effect_scope="workspace", risk_level="medium"),
    "attach_note_to_kb": ToolMeta(side_effect_scope="workspace", risk_level="medium"),
    "list_notes": _READ,
    "recall": _READ,
    # 写的是人设文件（MEMORY.md 那一层），长期数据
    "remember": ToolMeta(side_effect_scope="workspace", risk_level="medium"),
    # 产物落在**这一轮的会话**里（artifacts），不是用户的工作区
    "export_document": ToolMeta(side_effect_scope="session", risk_level="low"),
    "export_table": ToolMeta(side_effect_scope="session", risk_level="low"),
    "export_deck": ToolMeta(side_effect_scope="session", risk_level="low"),
    # 把它自己产出的东西收进库里：动的是长期数据
    "ingest_artifact": ToolMeta(side_effect_scope="workspace", risk_level="medium"),
    # 联网：只读且**最该并发**（一批抓三页是常态）
    "web_search": ToolMeta(
        read_only=True,
        concurrent_safe=True,
        side_effect_scope="network",
        risk_level="low",
    ),
    "web_fetch": ToolMeta(
        read_only=True,
        concurrent_safe=True,
        side_effect_scope="network",
        risk_level="low",
    ),
    # 技能：读一次、看一眼
    "list_skills": _READ,
    "read_skill": _READ,
    # 子代理是一次完整的调研（贵、有副作用、要落消息），独占
    "spawn_subagent": ToolMeta(side_effect_scope="session", risk_level="medium"),
    # ---- 这台机器上的能力（v0.33，见 agent_tools._LOCAL_TOOLS）----
    "list_files": _READ,
    "read_file": _READ,
    "search_files": _READ,
    # 执行命令：动的是**整台机器**，风险最高，而且总是要用户点头（策略之外的第二道）
    "run_command": ToolMeta(
        destructive=True, side_effect_scope="system", risk_level="high", needs_approval=True
    ),
    "list_tables": _READ,
    "query_table": _READ,
    # 挂定时任务：它自己不动文件，但会**在未来动手**——不并发，改天再说
    "schedule_task": ToolMeta(side_effect_scope="workspace", risk_level="medium"),
    "list_scheduled_tasks": _READ,
}

#: 未知工具（外部 MCP 服务暴露的）：**fail-closed**——不并发、按动系统算。
#:
#: 为什么不去读 MCP 的 ``annotations``（DSH 是用 ``idempotentHint`` 反推的）：
#: 我们这边的客户端目前**没有把 annotations 带上来**，凭工具名猜并发安全是在赌。
#: 等 MCP 客户端把 annotations 透出来，再按 DSH 那条做（见调研报告 §2.2）。
#:
#: **它不参与种类推导**：``kind_of`` 对没在表里的名字直接给 ``tool``
#: （策略上按"动整台机器"算是对的，显示上画成"执行"是错的，见 ``KINDS``）。
_UNKNOWN = ToolMeta()


def meta_of(name: str) -> ToolMeta:
    """取一个工具的元数据；**不认识就按最保守的算**（fail-closed）。"""
    return TOOL_META.get(str(name or ""), _UNKNOWN)


#: 六字段**分不出来**的那几个：种类在这里显式指名（P2-1）。
#:
#: 为什么需要这张表：``read_only`` / ``side_effect_scope`` / ``destructive``
#: 回答的是"动不动东西、动了什么"，而"读一眼"与"找东西"在它们眼里是同一档
#: （都是只读、影响面 none）——那个区别是**语义**，不是策略，元数据里没有它的位置。
#: 所以这几条按名字指名，**仍然写在这一张表旁边**（不在前端，也不另起一份
#: 名字→样子的映射）：界面对工具名一无所知，它只认 ``kind``。
#:
#: 导出三件套同理：它们的 scope 是 ``session``（产物落在这一轮的会话里），
#: 按元数据推会得到 ``session``；但用户看到的是"它做出来一份东西"，
#: 归 ``write`` 才与"建笔记、上传文档"是同一件事（ZCode 把这类单列成"任务输出"，
#: 我们的八档里没有那一档，收进 ``write``；真正的那份文件由产物卡片单独承担）。
_KIND_OVERRIDES: dict[str, str] = {
    # 从"已有的东西里找一段"——与 read（列清单、看状态）不是一回事
    "search": "search",
    "recall": "search",
    "search_files": "search",
    # 技能是能力层的一档（ZCode 的枚举里也单列）
    "list_skills": "skill",
    "read_skill": "skill",
    # 产出交付物（见上面那段）
    "export_document": "write",
    "export_table": "write",
    "export_deck": "write",
}


def _derive_kind(meta: ToolMeta) -> str:
    """按元数据推种类（推导规则，顺序即优先级）。

    顺序是有讲究的：``run_command`` 同时是 ``destructive`` 与 ``system``——
    先看影响面，它才是"执行"；``delete_document`` 是 ``workspace`` + ``destructive``，
    落到"删除"。反过来（先看 destructive）会把命令画成删除，
    而"删了一份文档"与"在这台机器上跑了一条命令"对用户是两件事。
    """
    if meta.side_effect_scope == "system":
        return "exec"
    if meta.destructive:
        return "delete"
    if meta.read_only:
        return "search" if meta.side_effect_scope == "network" else "read"
    if meta.side_effect_scope == "session":
        return "session"
    return "write"


def kind_of(name: str) -> str:
    """工具名 → 语义种类（P2-1）。**界面拿到的就是它，不再自己按名字分类。**

    与 ``meta_of`` 一样对未知工具 fail-closed，但兜的那一档不同：``tool``
    （中性图标），不是按"动整台机器"推出来的 ``exec``——见 ``KINDS`` 最后一条。
    """
    tool = str(name or "")
    if tool not in TOOL_META:
        return "tool"
    explicit = _KIND_OVERRIDES.get(tool)
    if explicit is not None:
        return explicit
    return _derive_kind(TOOL_META[tool])


def parallel_groups(calls: list[str]) -> list[list[int]]:
    """把一批调用切成组：能并发的连成一组，独占的各成一组（**天然屏障**）。

    返回的是**下标**（调用方要按原顺序回填结果）。形状与 DSH 的
    ``{parallelGroups, executionOrder}`` 一致：组序 = 调用序，组内可并发。

    例：``[read_file, read_file, run_command, read_file, web_fetch]`` →
    ``[[0, 1], [2], [3, 4]]``——中间那条命令把它前后的读操作隔开，
    因为"它自己会改文件"，两边的读结果不可能互相作数。
    """
    groups: list[list[int]] = []
    open_group = False
    for index, name in enumerate(calls):
        if meta_of(name).parallel:
            if open_group and groups:
                groups[-1].append(index)
            else:
                groups.append([index])
                open_group = True
        else:
            groups.append([index])
            open_group = False
    return groups
