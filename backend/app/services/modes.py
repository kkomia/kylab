"""两个维度的控制：**权限**（能碰什么）× **任务行为模式**（怎么干活）。

口径是用户 2026-09-27 定的原话："一个是仅查看 / 工作区内编辑 / 完全访问，这是用来控制
权限的；另一个是计划 / 目标这种模式，是用来控制 agent 行为的，不是用来控制权限，
而是控制任务行为。**所以这是两个维度的东西**。"

======================  ==========================================================
维度                    取值与含义
======================  ==========================================================
**权限**（`chat.permission`）  ``view`` 仅查看 / ``workspace`` 工作区内编辑 / ``full`` 完全访问
**模式**（`chat.mode`）      ``goal`` 目标 / ``plan`` 计划
======================  ==========================================================

在此之前这里是**四档模式**（``plan`` / ``build`` / ``edit`` / ``yolo``，照 ZCode 抄的）——
那四档其实是这两根轴缠在一起：``build``/``edit``/``yolo`` 的差别在"能碰多少"（权限），
``plan`` 的差别在"要不要先给计划"（任务行为）。拆开之后：

**权限三档**（"能碰什么"，判定在 ``permission_allows``）：

- **仅查看**：写类工具一律拦下（不改文件、不跑命令）；
- **工作区内编辑**（默认）：会话与工作区里的写放行、不再逐条问；动整台机器的那一类
  （``side_effect_scope=system``，例如执行命令）**仍要问一句**；
- **完全访问**：写与命令都放行、也不再问。**但"免问"不等于"越过拒绝"**：
  显式的拒绝规则仍然拦得住（见 `agent_exec` 的三道闸）。

**任务行为模式两档**（"怎么干活"，判定在 ``plan_allows``）：``goal`` 直接干；
``plan`` 在**没给出计划、对方没确认**之前，会改动东西的工具一律不执行（只读的照跑）。

## 三条不能破的规矩（继承自四档时代，理由没变）

1. **档不改工具清单，只喂权限引擎**：交给模型的工具表**一个都不多、一个都不少**，
   变的只是"这一步允不允许执行"。否则每加一档都要去改所有工具的可用性，
   档与工具会互相锁死。——唯一的例外是 ``plan`` 的**计划门闸**，而它拦的是"执行"
   而不是"看见"：工具照样出现在表里，模型照样能调，只是调用会被拦下并拿到理由。
2. **判定只有一处**（``decide`` / ``auto_approves``）：循环、审批、界面提示都从这里取答案。
   散在几处写判定，等于给"同一档下两处口径不同"留门。
3. **权限先于计划**：两道闸都要过。顺序是**先权限后计划**——"这一档根本不许做"
   与"这一档许做，但得先给计划"回给模型的下一步完全不同（前者该放弃、后者该写计划）。

## 拦下时说什么

被拦下**不是错误**，是这一档的规矩，所以回给模型的话必须包含两样：
**为什么被拦**（这一档的规矩 + 这个工具为什么算"会改动东西"）与**怎么办**。
只说"不允许"的回话，模型只会反复重试同一个调用，而屏幕前的人不知道发生了什么。

## 老值怎么办

``chat.mode`` 里可能还留着旧的四档取值（旧部署、``.env``、网页上写过的）。
``coerce`` 一律**映射到新档并留一条日志**：``plan`` → ``plan``，``build``/``edit``/``yolo``
→ ``goal``（那三档的差别现在由权限轴表达，而权限轴有自己的设置项）。
不认识的取值回默认档——写错一个字母就让整轮对话失败是不划算的。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from app.services.tool_meta import ToolMeta

__all__ = [
    "DEFAULT_MODE",
    "DEFAULT_PERMISSION",
    "MODES",
    "MODE_DEFS",
    "MODE_GOAL",
    "MODE_PLAN",
    "PERMISSIONS",
    "PERMISSION_DEFS",
    "PERMISSION_FULL",
    "PERMISSION_VIEW",
    "PERMISSION_WORKSPACE",
    "LegacyMode",
    "ModeDef",
    "PermissionDef",
    "auto_approves",
    "blocked_reason",
    "coerce",
    "coerce_permission",
    "decide",
    "describe_modes",
    "describe_permissions",
    "is_write",
    "label_of",
    "permission_label_of",
]

logger = logging.getLogger(__name__)

# ---- 权限（"能碰什么"） --------------------------------------------------------

PERMISSION_VIEW = "view"
PERMISSION_WORKSPACE = "workspace"
PERMISSION_FULL = "full"

#: 全部合法取值。**顺序 = 由紧到松**，界面按它排列（用户列的就是这个次序）。
PERMISSIONS: tuple[str, ...] = (PERMISSION_VIEW, PERMISSION_WORKSPACE, PERMISSION_FULL)

#: 默认档。取中间那一档的理由：**默认要能干活**（"仅查看"当默认，产品一上来就是废的），
#: 而"动整台机器"（执行命令、动系统里别的东西）仍然要问一句——风险留在看得见的地方。
DEFAULT_PERMISSION = PERMISSION_WORKSPACE


@dataclass(frozen=True, slots=True)
class PermissionDef:
    """一档权限的展示文案（界面与提示词都用它，不另写一份）。"""

    name: str
    label: str
    """短名字（界面上的胶囊）。"""
    hint: str
    """一句话说明（四到六个字）。"""
    detail: str
    """选这一档会发生什么（界面第二行 + 提示词里都会用）。"""


PERMISSION_DEFS: dict[str, PermissionDef] = {
    PERMISSION_VIEW: PermissionDef(
        name=PERMISSION_VIEW,
        label="仅查看",
        hint="只看不动",
        detail="不改文件、不跑命令：会改动东西的工具这一轮一律不执行，只读的照跑。",
    ),
    PERMISSION_WORKSPACE: PermissionDef(
        name=PERMISSION_WORKSPACE,
        label="工作区内编辑",
        hint="工作区里可以动手",
        detail="会话与工作区里的改动直接做、不再逐条问；执行命令、动这台机器上别的东西仍要问一句。",
    ),
    PERMISSION_FULL: PermissionDef(
        name=PERMISSION_FULL,
        label="完全访问",
        hint="不再逐条问",
        detail="写与命令都放行、也不再问；显式的拒绝规则仍然拦得住。",
    ),
}

# ---- 模式（"怎么干活"） --------------------------------------------------------

MODE_GOAL = "goal"
MODE_PLAN = "plan"

MODES: tuple[str, ...] = (MODE_GOAL, MODE_PLAN)

DEFAULT_MODE = MODE_GOAL


@dataclass(frozen=True, slots=True)
class ModeDef:
    """一档模式的展示文案（界面与设置页都用它，不另写一份）。"""

    name: str
    label: str
    hint: str
    detail: str


MODE_DEFS: dict[str, ModeDef] = {
    MODE_GOAL: ModeDef(
        name=MODE_GOAL,
        label="目标",
        hint="给个目标就去做",
        detail="直接动手：能用工具就用，边做边说。要不要问、能碰多少由**权限**那一档决定。",
    ),
    MODE_PLAN: ModeDef(
        name=MODE_PLAN,
        label="计划",
        hint="先给计划再动手",
        detail="没给出计划、对方没确认之前，会改动东西的工具一律不执行（只读的照跑）。",
    ),
}

#: 旧的四档取值 → 新档（``build``/``edit``/``yolo`` 的差别现在归**权限**轴，见模块头）。
LegacyMode = dict[str, str]
_LEGACY_MODES: LegacyMode = {
    "build": MODE_GOAL,
    "edit": MODE_GOAL,
    "yolo": MODE_GOAL,
    "plan": MODE_PLAN,
    # 旧常量仍导出（别处还按名字引用它们，见 __all__）：它们现在都指向新档
    MODE_GOAL: MODE_GOAL,
    MODE_PLAN: MODE_PLAN,
}

_LEGACY_PERMISSIONS: dict[str, str] = {
    # 旧的"命令执行策略"三档（`sandbox.exec_policy`，已折进权限轴）：
    #   allow  → 完全访问（命令直接跑）
    #   ask    → 工作区内编辑（命令要问一句）
    #   deny   → 仅查看（命令不跑）
    "allow": PERMISSION_FULL,
    "ask": PERMISSION_WORKSPACE,
    "deny": PERMISSION_VIEW,
    # 更早的那一档（"照跑但不过审批"）：按它能做什么归到完全访问
    "sandbox": PERMISSION_FULL,
}


def coerce(value: object) -> str:
    """把设置里的模式取值归一成两档之一；旧的四档与不认识的一律回默认档。

    不抛异常：这个值来自设置页（自由文本）与 ``.env``，写错一个字母就让整轮对话
    失败是不划算的——回默认档是**最不意外**的处置。但**要留一条日志**：
    静默回默认是那种"改了不生效"的问题里最难查的一类。
    """
    text = str(value or "").strip().lower()
    if text in MODE_DEFS:
        return text
    if text in _LEGACY_MODES:
        mapped = _LEGACY_MODES[text]
        logger.info("agent 模式 %r 是旧的四档取值，按新档 %s 处理", value, mapped)
        return mapped
    if text:
        logger.warning("不认识的 agent 模式 %r，按默认档 %s 处理", value, DEFAULT_MODE)
    return DEFAULT_MODE


def coerce_permission(value: object) -> str:
    """把权限取值归一成三档之一；旧的"命令执行策略"三档**当取值**也认。

    **认的是"值"、不是"旧的键"**：`sandbox.exec_policy` 那一项已经从设置里删掉、
    也没人再读它（见 `runtime_config` 那一项的注释）。这里认 `allow`/`ask`/`deny`/`sandbox`
    是为了"有人照旧写法把它写在 `chat.permission` 上"这种情况——那种写法应当照旧生效，
    而不是静默回默认档。
    """
    text = str(value or "").strip().lower()
    if text in PERMISSION_DEFS:
        return text
    if text in _LEGACY_PERMISSIONS:
        mapped = _LEGACY_PERMISSIONS[text]
        logger.info("权限取值 %r 来自旧的「命令执行策略」，按 %s 处理", value, mapped)
        return mapped
    if text:
        logger.warning("不认识的权限档 %r，按默认档 %s 处理", value, DEFAULT_PERMISSION)
    return DEFAULT_PERMISSION


def label_of(mode: object) -> str:
    """档位的短名字（界面与回话里都用它，例如「计划」）。"""
    return MODE_DEFS[coerce(mode)].label


def permission_label_of(permission: object) -> str:
    """权限档的短名字（界面与回话里都用它，例如「仅查看」）。"""
    return PERMISSION_DEFS[coerce_permission(permission)].label


def describe_modes() -> list[dict[str, str]]:
    """两档模式的展示定义（设置页的下拉项从这里取，不各写一份）。"""
    return [
        {"name": item.name, "label": item.label, "hint": item.hint, "detail": item.detail}
        for item in (MODE_DEFS[name] for name in MODES)
    ]


def describe_permissions() -> list[dict[str, str]]:
    """三档权限的展示定义（设置页与输入区那颗胶囊都从这里取）。"""
    return [
        {"name": item.name, "label": item.label, "hint": item.hint, "detail": item.detail}
        for item in (PERMISSION_DEFS[name] for name in PERMISSIONS)
    ]


# ---- 判定 ---------------------------------------------------------------------


def is_write(meta: ToolMeta) -> bool:
    """这个工具算不算"会改动东西"的那一类。

    两个条件取或，两个都有出处：

    - ``not read_only``：工具自己声明过"我只读"就不算写类；
    - ``side_effect_scope not in ("none", "network")``：影响面落在会话/工作区/机器上，
      必然动了东西。**``network`` 不算写**，与 ``tool_meta.ToolMeta.parallel``
      同一处有据的偏离：我们这一档的 ``network`` 明确是"只发请求、不改任何东西"
      （抓网页、搜索）。

    ``fail-closed``：没声明元数据的工具（外部 MCP、新加的）按写类算——
    元数据默认值本身就是最保守的那一档（``read_only=False`` / ``system``）。
    """
    return (not meta.read_only) or meta.side_effect_scope not in ("none", "network")


def _scope_is_local(meta: ToolMeta) -> bool:
    """影响面收在这一轮会话或用户的工作区里（"工作区内编辑"能覆盖的范围）。"""
    return meta.side_effect_scope in ("session", "workspace")


def permission_allows(
    meta: ToolMeta,
    permission: object,
    *,
    tool: str = "",
    tool_label: str = "",
) -> tuple[bool, str]:
    """**权限那道闸**：这一档下允许执行这个工具吗；不允许就把理由一并给出。

    - ``view`` 仅查看：写类一律拦下（只读的照跑）；
    - ``workspace`` / ``full``：一律允许，差别在"要不要问一句"（见 ``auto_approves``）。

    返回 ``(是否允许, 理由)``。允许时理由为空串——调用方据此直接执行，
    不需要再看别的条件（判定散成两处，就会漂）。
    """
    name = coerce_permission(permission)
    if name != PERMISSION_VIEW:
        return True, ""
    if not is_write(meta):
        return True, ""
    return False, permission_blocked_reason(
        tool=tool, tool_label=tool_label, meta=meta, permission=name
    )


def plan_allows(
    meta: ToolMeta,
    mode: object,
    *,
    plan_given: bool = True,
    tool: str = "",
    tool_label: str = "",
) -> tuple[bool, str]:
    """**计划那道闸（任务行为）**：``plan`` 档下没给计划时，写类一律拦下。

    ``goal`` 档**一律允许**：它的差别不在"能不能做"，那件事归权限轴
    （见 ``permission_allows``）。
    """
    name = coerce(mode)
    if name != MODE_PLAN:
        return True, ""
    if plan_given or not is_write(meta):
        return True, ""
    return False, blocked_reason(tool=tool, tool_label=tool_label, meta=meta, mode=name)


def decide(
    meta: ToolMeta,
    *,
    mode: object,
    permission: object,
    plan_given: bool = True,
    tool: str = "",
    tool_label: str = "",
) -> tuple[bool, str]:
    """**唯一的合流判定**：两道闸都要过，**先权限后计划**（顺序的理由见模块头第 3 条）。

    返回 ``(是否允许, 理由)``；允许时理由为空串。
    """
    allowed, reason = permission_allows(meta, permission, tool=tool, tool_label=tool_label)
    if not allowed:
        return False, reason
    return plan_allows(meta, mode, plan_given=plan_given, tool=tool, tool_label=tool_label)


def permission_blocked_reason(
    *,
    tool: str,
    meta: ToolMeta,
    permission: str,
    tool_label: str = "",
) -> str:
    """被**权限档**拦下时回给模型的那段话：为什么被拦 + 怎么办。

    三段都要有（与 ``blocked_reason`` 同一套理由）：现在是什么档、为什么这个工具算
    "会改动东西"、怎么办。``view`` 档的"怎么办"是**如实说明并停手**——
    这一档不许做，换个名字重试或绕路都不行。
    """
    label = PERMISSION_DEFS[coerce_permission(permission)].label
    who = tool_label or tool or "这个工具"
    name = tool or who
    return (
        f"现在是「{label}」权限，这一步没有执行。\n"
        f"这一档的规矩是{PERMISSION_DEFS[PERMISSION_VIEW].hint}：不改动任何东西。\n"
        f"「{who}」（{name}）会改动东西——影响面是 {meta.side_effect_scope}"
        f"{'，而且不可逆' if meta.destructive else ''}，所以被拦下了。\n"
        "怎么办：如实告诉对方这一步需要更高的权限（设置 → 聊天 → 权限，或在输入区那一颗上改），"
        "把你要做的事说清楚让他决定；**不要重试这个调用，也不要换个名字绕过去**。"
        "只读的事（查资料、读文件、搜索）照做，那些不受这一档限制。"
    )


def blocked_reason(
    *,
    tool: str,
    meta: ToolMeta,
    mode: str,
    tool_label: str = "",
) -> str:
    """被**计划档**拦下时**回给模型**的那段话：为什么被拦 + 怎么办。

    写给模型看，所以三段都要有：**现在是什么档**（它可能压根不知道）、
    **为什么这个工具算"会改动东西"**（用元数据里的事实说，不用形容词）、
    **怎么办**（这一档要求的动作是什么）。最后一句是防它换个名字重试。
    """
    label = MODE_DEFS[coerce(mode)].label
    who = tool_label or tool or "这个工具"
    name = tool or who
    return (
        f"现在是「{label}」档，这一步没有执行。\n"
        f"这一档的规矩是{MODE_DEFS[MODE_PLAN].hint}：**先给出计划、等对方确认**，"
        f"在那之前不改动任何东西。\n"
        f"「{who}」（{name}）会改动东西——影响面是 {meta.side_effect_scope}"
        f"{'，而且不可逆' if meta.destructive else ''}，所以被拦下了。\n"
        "怎么办：用一段文字把计划说清楚——要做什么、动哪些东西、分几步、有哪些风险，"
        "然后停下来等对方确认（他的下一句话就是确认）。确认之后这一步再接着做。\n"
        "**不要重试这个调用，也不要换个名字绕过去**；如果你认为现在就必须做，"
        "先把理由与影响面说清，让对方自己决定。"
    )


def auto_approves(meta: ToolMeta, permission: object) -> bool:
    """这一档权限下，**需要用户点头的调用**能不能免掉那一次询问。

    与 ``permission_allows`` 分开是因为它们答的是两个问题："能不能做"与"要不要问"。
    吞成一个返回值，调用方就得自己拆，而拆错的那一半不会有任何报错。

    - ``workspace``：**写类且影响面在会话/工作区里**的免问——"工作区内编辑"照字面就是
      "这些改动不必每一条都点头"。``system`` 档（执行命令）与 destructive 的照问：
      它们的影响面在那一档之外。
    - ``full``：一律免问。**但"免问"不等于"越过拒绝"**：显式的拒绝规则与
      拒绝执行（`agent_exec` 的三道闸）排在审批之前，仍然拦得住——权限档只决定
      "要不要问一句"，不决定"能不能"（那是 `permission_allows` 的事）。
    - ``view``：压根不放行（`permission_allows` 已经拦下了），这里返回 False 只是
      "别免问"这个安全侧的兜底。
    """
    name = coerce_permission(permission)
    if name == PERMISSION_FULL:
        return True
    if name == PERMISSION_WORKSPACE:
        return _scope_is_local(meta) and not meta.destructive
    return False
