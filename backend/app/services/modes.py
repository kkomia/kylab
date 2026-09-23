"""Agent 模式四档：``plan`` / ``build`` / ``edit`` / ``yolo``（P1-1，开发计划 §12.225）。

**四档的名字、顺序与语义直接照抄 ZCode**（《Agent-与对话架构对标调研 v0.1》§2.6，
证据等级：字符串证据 + UI 字符串）：

===================  ==================================  ==========================================
档                    ZCode 的原文案                         抄到我们这里的语义
===================  ==================================  ==========================================
``plan``             "先给计划再动手"                     没给出计划前，会改动东西的工具一律不执行
``build``            "变更前确认"（默认档）                照现行策略走：该问的照问
``edit``             "自动编辑"                           写类不再逐条问（执行命令那一类照问）
``yolo``             "少确认全放行"                        连审批也不再问（显式拒绝仍然拦得住）
===================  ==================================  ==========================================

## 两条不能破的规矩

1. **模式不改工具清单，只喂权限引擎**（§2.6 第 1 条，ZCode 的原话是
   ``allow(tool, …, "mode.yolo", "Yolo mode bypasses permission prompts")``）：
   四档下交给模型的工具表**一个都不多、一个都不少**，变的只是"这一步允不允许执行"。
   否则每加一档都要去改所有工具的可用性，模式与工具会互相锁死。
   —— 唯一的例外是 `plan` 档的**计划门闸**（见下），而它拦的是"执行"而不是"看见"：
   工具照样出现在工具表里，模型照样能调，只是调用会被拦下并拿到理由。
2. **判定只有一处**（``allows`` / ``auto_approves``）：循环、审批、界面提示都从这里取答案。
   散在几处写判定，等于给"同一个模式下两处口径不同"留门。

## 拦下时说什么

`plan` 档的拒绝**不是错误**，是这一档的规矩，所以回给模型的话必须包含两样
（QwenPaw 的 ``set_plan_gate`` 就是这么做的，见 §2.6 第 3 条）：
**为什么被拦**（这一档的规矩 + 这个工具为什么算"会改东西"）与
**怎么办**（先用文字给出计划、等对方确认）。只说"不允许"的回话，
模型只会反复重试同一个调用，而屏幕前的人不知道发生了什么。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from app.services.tool_meta import ToolMeta

__all__ = [
    "DEFAULT_MODE",
    "MODES",
    "MODE_BUILD",
    "MODE_DEFS",
    "MODE_EDIT",
    "MODE_PLAN",
    "MODE_YOLO",
    "ModeDef",
    "allows",
    "auto_approves",
    "blocked_reason",
    "coerce",
    "describe",
    "is_write",
    "label_of",
]

logger = logging.getLogger(__name__)

MODE_PLAN = "plan"
MODE_BUILD = "build"
MODE_EDIT = "edit"
MODE_YOLO = "yolo"

#: 全部合法取值。**顺序照 ZCode 的枚举**（``build|edit|plan|yolo``），
#: 界面按它排列——"默认档在最前、破坏性最大的在最后"这个次序是抄来的，不另发明。
MODES: tuple[str, ...] = (MODE_BUILD, MODE_EDIT, MODE_PLAN, MODE_YOLO)

#: 默认档。ZCode 的默认也是 ``build``（"变更前确认"）：
#: 默认档必须是**最不意外**的那一个，而"没问就动了东西"是最让人意外的。
DEFAULT_MODE = MODE_BUILD


@dataclass(frozen=True, slots=True)
class ModeDef:
    """一档模式的展示文案（界面与设置页都用它，不另写一份）。"""

    name: str
    label: str
    """短名字（界面上的徽标）。"""
    hint: str
    """一句话说明（ZCode 的 UI 文案，直译）。"""
    detail: str
    """选这一档会发生什么（界面的第二行 + 回给模型的理由里都会用）。"""


MODE_DEFS: dict[str, ModeDef] = {
    MODE_BUILD: ModeDef(
        name=MODE_BUILD,
        label="构建",
        hint="变更前确认",
        detail="该问的照问：写类与执行命令都按现行策略走。",
    ),
    MODE_EDIT: ModeDef(
        name=MODE_EDIT,
        label="编辑",
        hint="自动编辑",
        detail="写东西不再逐条问；执行命令（动整台机器的那一类）照旧问。",
    ),
    MODE_PLAN: ModeDef(
        name=MODE_PLAN,
        label="计划",
        hint="先给计划再动手",
        detail="没给出计划、对方没确认之前，会改动东西的工具一律不执行（只读的照跑）。",
    ),
    MODE_YOLO: ModeDef(
        name=MODE_YOLO,
        label="全放行",
        hint="少确认全放行",
        detail="该问的也不再问；显式的拒绝规则与「拒绝执行」总开关仍然拦得住。",
    ),
}


def coerce(value: object) -> str:
    """把设置里的取值归一成四档之一；**不认识的一律回默认档**。

    不抛异常：这个值来自设置页（自由文本）与 ``.env``，写错一个字母就让整轮对话
    失败是不划算的——回默认档是**最不意外**的处置（默认档是"变更前确认"，
    拦不住的东西一个都没多）。但**要留一条日志**：静默回默认是那种"改了不生效"
    的问题里最难查的一类。
    """
    text = str(value or "").strip().lower()
    if text in MODE_DEFS:
        return text
    if text:
        logger.warning("不认识的 agent 模式 %r，按默认档 %s 处理", value, DEFAULT_MODE)
    return DEFAULT_MODE


def label_of(mode: object) -> str:
    """档位的短名字（界面与回话里都用它，例如「计划」）。"""
    return MODE_DEFS[coerce(mode)].label


def describe() -> list[dict[str, str]]:
    """四档的展示定义（设置页的下拉项与前端控件都从这里取，不各写一份）。"""
    return [
        {
            "name": item.name,
            "label": item.label,
            "hint": item.hint,
            "detail": item.detail,
        }
        for item in (MODE_DEFS[name] for name in MODES)
    ]


# ---- 判定 ---------------------------------------------------------------------


def is_write(meta: ToolMeta) -> bool:
    """这个工具算不算"会改动东西"的那一类。

    两个条件取或，两个都有出处：

    - ``not read_only``：工具自己声明过"我只读"就不算写类；
    - ``side_effect_scope not in ("none", "network")``：影响面落在会话/工作区/机器上，
      必然动了东西。**``network`` 不算写**，与 ``tool_meta.ToolMeta.parallel``
      同一处有据的偏离：我们这一档的 ``network`` 明确是"只发请求、不改任何东西"
      （抓网页、搜索），而 ZCode 把"碰网络"与"可能写"混在同一个枚举里。
      计划档要挡的是"动手"，不是"上网查"。

    ``fail-closed``：没声明元数据的工具（外部 MCP、新加的）按写类算——
    元数据默认值本身就是最保守的那一档（``read_only=False`` / ``system``）。
    """
    return (not meta.read_only) or meta.side_effect_scope not in ("none", "network")


def _scope_is_local(meta: ToolMeta) -> bool:
    """影响面收在这一轮会话或用户的工作区里（"编辑"档管得住的范围）。"""
    return meta.side_effect_scope in ("session", "workspace")


def allows(
    meta: ToolMeta,
    mode: object,
    *,
    plan_given: bool = True,
    tool: str = "",
    tool_label: str = "",
) -> tuple[bool, str]:
    """**唯一的判定函数**：这一档下允许执行这个工具吗；不允许就把理由一并给出。

    返回 ``(是否允许, 理由)``。允许时理由为空串——调用方据此直接执行，
    不需要再看别的条件（判定散成两处，就会漂）。

    ``build`` / ``edit`` / ``yolo`` 三档**一律允许**：它们的差别在"要不要问一句"
    （见 ``auto_approves``），而不在"能不能做"。只有 ``plan`` 档会真的拦下调用，
    而且只在**计划还没给出来**的时候（门闸状态由 ``services/plan_gate`` 持有）。
    """
    name = coerce(mode)
    if name != MODE_PLAN:
        return True, ""
    if plan_given or not is_write(meta):
        return True, ""
    return False, blocked_reason(tool=tool, tool_label=tool_label, meta=meta, mode=name)


def blocked_reason(
    *,
    tool: str,
    meta: ToolMeta,
    mode: str,
    tool_label: str = "",
) -> str:
    """被模式拦下时**回给模型**的那段话：为什么被拦 + 怎么办。

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


def auto_approves(meta: ToolMeta, mode: object) -> bool:
    """这一档下，**需要用户点头的调用**能不能免掉那一次询问。

    与 ``allows`` 分开是因为它们答的是两个问题："能不能做"与"要不要问"。
    吞成一个返回值，调用方就得自己拆，而拆错的那一半不会有任何报错。

    - ``edit``：**写类**（影响面在会话/工作区里）且不 destructive 的免问——
      "自动编辑"照 ZCode 的语义就是"这些改动不必每一条都点头"。
      ``system`` 档（执行命令）与 destructive 的照问：它们的影响面在那一档之外。
    - ``yolo``：一律免问（ZCode 的 ``"Yolo mode bypasses permission prompts"``）。
      **但"免问"不等于"越过拒绝"**：显式的拒绝规则与「沙箱执行 → 拒绝」总开关
      在 ``agent_exec`` 里排在审批之前，仍然拦得住——模式只决定"要不要问一句"。
    """
    name = coerce(mode)
    if name == MODE_YOLO:
        return True
    if name == MODE_EDIT:
        return _scope_is_local(meta) and not meta.destructive
    return False
