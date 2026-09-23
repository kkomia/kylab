"""斜杠命令：内置表 + ``commands/*.md`` 自定义命令（P1-2，开发计划 §12.225）。

**照抄的是三家各自最容易漏掉的那一半**（调研报告《Agent-与对话架构对标调研 v0.1》
§2.7「agent 命令」，ZCode 那一半是文档级证据、DSH 与 QwenPaw 那一半是源码级）：

===================  ============================================  ===========================
抄谁                  它的原话                                     抄到我们这里的落点
===================  ============================================  ===========================
QwenPaw              「三类命令进 LLM **之前**短路」                 ``parse`` 在协议层被调用，
                                                                  短路类命令不建工具循环
DSH                  「``/`` 行**永不静默降级**为普通 prompt」     认不出的 ``/`` 也当命令答一句，
                     +「命令执行写 session log 但**不进模型       并且不落 user/assistant 消息
                     历史**」
ZCode                内置表 ``{name, summary, usage, details[]}``   ``BUILTIN_COMMANDS``
ZCode                自定义命令 = 一个 md 文件，**文件名即命令名**， ``_load`` / ``COMMAND_NAME_RE``
                     扁平 frontmatter，``$ARGUMENTS`` / ``$1..$N``，
                     「有参数但正文无占位符时自动追加 User arguments:」
===================  ============================================  ===========================

**优先级：内置 > 用户自定义 > 仓库自带，重名 first match wins**（ZCode 的
「用户级 > 工作区级 > 插件级」那一条按我们的三层改写）。被遮蔽的那条**仍然列出来**、
带 ``shadowed_by``——与插件列表同一套做法，静默藏掉会让人以为文件没生效。

**命令分两类**，这个区分是这一模块对协议层最重要的一句话：

- **短路类**（``short_circuit=True``）：``/help`` ``/new`` ``/stop`` ``/mode``
  ``/model`` ``/compact``。它们**不进模型**、**不产生 assistant 消息**——由协议层
  直接执行并把结果回给界面（QwenPaw 那套优先级 0/10/20/30 要的就是这个）。
- **改写类**（``short_circuit=False``）：``/skill``、``/plan <描述>`` 与全部自定义
  md 命令。它们把渲染后的正文**当作这一轮的提示**（ZCode：``/skill`` 会重写下一条
  prompt），所以还是要过一次模型、还是会留下回答；进历史的也只是渲染后的正文。
  ``/plan`` 是**看有没有参数的两面派**（不带描述时就是 ``/mode plan``），
  真正决定走哪条路的见 ``CommandDef.short_circuit`` 那一段说明。

**参数语义就两条**（ZCode 第 3 条：省掉大量「命令没收到参数」的困惑）：
``$ARGUMENTS``（全部参数原样）与 ``$1``…``$N``（按空白切分后的第 N 个）。
**正文里一个占位符都没有、但用户给了参数时自动把参数追加到末尾**——那是最常见的
一种「命令写了但好像没收到」的情形，照抄它的兜底（ZCode 是 ``User arguments:``，
这里用中文是因为这一句是给**模型**读的，而它接下来要用中文作答）。
"""

from __future__ import annotations

import logging
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from app.services.memory_files import parse_frontmatter
from app.services.modes import MODE_DEFS, MODES
from app.services.session_events import KIND_TURN_START

__all__ = [
    "BUILTIN_COMMANDS",
    "COMMANDS_DIR",
    "COMMAND_FILE_SUFFIX",
    "COMMAND_NAME_RE",
    "MODE_SOURCE_COMMAND",
    "MODE_SOURCE_SETTINGS",
    "MODE_VALUES",
    "NAME_COMPACT",
    "NAME_HELP",
    "NAME_MODE",
    "NAME_MODEL",
    "NAME_NEW",
    "NAME_PLAN",
    "NAME_SKILL",
    "NAME_STOP",
    "USER_ARGUMENTS_LABEL",
    "CommandDef",
    "CommandService",
    "ModeWatch",
    "ParsedCommand",
    "TurnControl",
    "builtin_names",
    "is_builtin",
    "modes_text",
    "parse",
    "render",
    "split_args",
]

logger = logging.getLogger(__name__)

#: 用户级自定义命令目录（``<data_dir>/commands/``，与 ``data/skills`` 同一层）。
COMMANDS_DIR = "commands"

#: 自定义命令的文件后缀。ZCode 用 ``.md``。同一个目录里还可能有 README、
#: 示例之类的东西，靠后缀区分比靠"能不能解析"稳。
COMMAND_FILE_SUFFIX = ".md"

#: 命令名的合法形状，**逐字照抄 ZCode**（``^[a-z0-9][a-z0-9_:-]{0,63}$``）：
#: 小写字母或数字开头，之后允许 ``_``、``:``、``-``（ZCode 用冒号表达嵌套目录，
#: 例如 ``review/code.md`` → ``/review:code``）。**违规的文件直接丢弃并记原因**：
#: 名字不合法的命令在界面上就是"不见了"，而原因只有这里知道。
COMMAND_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_:-]{0,63}$")

#: 参数没处可放时的兜底前缀（ZCode 的 ``User arguments:``）。
USER_ARGUMENTS_LABEL = "用户参数："

#: ``mode/changed`` 事件的两个来源（P1-1 遗留第 6 条，payload 里的 ``source``）。
MODE_SOURCE_COMMAND = "command"
"""用户在会话里当场敲了 ``/mode``——切换就发生在这一条会话上。"""

MODE_SOURCE_SETTINGS = "settings"
"""这一轮开始时发现档与上一轮不同：上次是**在会话之外**改的（设置页、输入框那一排
的控件、``.env``）。我们的模式是应用级配置而不是会话字段（见 ``services/modes``），
所以"会话里换过档"只能靠这一处观测出来——不观测，那条审计信息在日志里永远是缺的。"""


# --------------------------------------------------------------------- 数据结构


@dataclass(frozen=True, slots=True)
class CommandDef:
    """一条命令的完整定义。

    ``name`` / ``summary`` / ``usage`` / ``details`` 四个字段**照 ZCode 的内置表**
    （调研报告 §2.7 第 1 条逐字列了它的实现）——``/help <命令>`` 与前端那个 ``/``
    菜单共用这一份数据，于是"菜单里有一个、``/help`` 里没有"这类不一致不可能发生。
    """

    name: str
    summary: str
    """一句话：这条命令是干什么的（菜单那一行 + ``/help`` 的列表）。"""
    usage: str = ""
    """怎么用（形如 ``/mode [plan|build|edit|yolo]``），空 = 没有参数。"""
    details: tuple[str, ...] = ()
    """展开说明（``/help <命令>`` 用它）。空 = 没有更多可说的。"""

    source: str = "builtin"
    """``builtin`` / ``user`` / ``repo``——与发现源一一对应，菜单按它分组。"""
    argument_hint: str = ""
    """自定义命令 frontmatter 里的 ``argument-hint``（照 ZCode）。"""
    allowed_tools: tuple[str, ...] = ()
    """``allowed-tools``（照 ZCode）。**本轮只登记、不消费**：这一轮的工具表由模式与
    库范围决定（见 ``services/modes`` 模块头第 1 条"模式不改工具清单"），再加一条
    "按命令收窄工具"的路会与它打架。列在列表端点里，让人看得见它被读到了。"""
    model: str = ""
    """``model``（照 ZCode）。同上：本轮只登记。"""
    body: str = ""
    """正文（仅自定义命令）；内置命令是空串——它们的行为在协议层。"""
    path: str = ""
    """md 文件的绝对路径（内置命令为空）。排错时要能找到它。"""

    shadowed_by: str = ""
    """**被谁遮蔽**：同名的更高优先级命令（空 = 没被遮蔽）。被遮蔽的仍然出现在
    列表里（照插件列表的做法），但调不到。"""
    error: str = ""
    """加载失败的原因（人话）。空 = 没问题。失败的一条**也在列表里**——
    静默跳过等于把"为什么我放的文件不生效"变成一个查不出的问题。"""

    @property
    def is_builtin(self) -> bool:
        return self.source == "builtin"

    @property
    def short_circuit(self) -> bool:
        """是否**不进模型**（见模块头"命令分两类"）。

        内置的八条里只有 ``/skill`` 不短路（它的正文就是这一轮的提示）；
        自定义命令一律不短路。

        ``/plan`` 是**看有没有参数的两面派**：不带描述时就是 ``/mode plan``（不碰模型），
        带上描述时那段描述是这一轮的提示（与 ``/skill`` 同一条路）。所以这个**表级**
        标记给的是保守口径（"不带参数时不产生回答"，菜单据此不建气泡），而**这一次**
        到底走哪条路由 ``api/v1/chat.py`` 的 ``_CommandResult.short_circuit`` 决定
        ——它看的是这次的结果带没带 ``prompt``。两处都留着是刻意的：菜单只拿得到表，
        真正的分流必须在拿到结果之后。
        """
        return self.is_builtin and self.name != "skill"

    @property
    def usable(self) -> bool:
        return not self.shadowed_by and not self.error


@dataclass(frozen=True, slots=True)
class ParsedCommand:
    """一次输入解析出来的结果：命令名 + 原样的参数字符串。"""

    name: str
    args: str = ""
    """``/mode plan`` → ``"plan"``（**原样**，不做切分：``$ARGUMENTS`` 要的就是它）。"""


# --------------------------------------------------------------------- 内置表

BUILTIN_COMMANDS: tuple[CommandDef, ...] = (
    CommandDef(
        name="help",
        summary="列出所有命令；给个命令名就看它的详细用法",
        usage="/help [命令名]",
        details=(
            "不带参数时列出全部可用命令（内置 + 自定义，按名字排序）。",
            "带一个命令名时展开它的用法与说明——与前端那个 `/` 菜单读的是同一份数据。",
        ),
    ),
    CommandDef(
        name="compact",
        summary="把较早的对话压成摘要，腾出上下文",
        usage="/compact",
        details=(
            "走的是平时那条压缩链路（services/chat.ChatService.compact）：把当前还没进",
            "摘要的对话交给模型压成一段摘要，并把标记推到最新一条消息。",
            "与自动压缩的区别只有一个——它不等占用越过阈值，你说压就压。",
            "**这一条自己要调用一次摘要模型**（压缩本身就是一次模型调用），",
            "但这一轮不产生回答、也不进模型历史。",
        ),
    ),
    CommandDef(
        name="new",
        summary="开一条新会话（当前这条留在历史里）",
        usage="/new",
        details=(
            "新建一条空会话并把界面切过去。库范围、模型、思考档取当前这条会话的，",
            "所以「新会话」不会把这一轮的选择也一起重置掉。",
            "当前这条会话不必担心：它**不会被删**，只是不再是当前会话。",
        ),
    ),
    CommandDef(
        name="stop",
        summary="停止正在跑的那一轮",
        usage="/stop",
        details=(
            "把这一轮叫停：已经流出来的正文留着（它仍然是有用的），会话日志里补一条",
            "`interrupted`——含「哪些调用没有结果」，下一轮据此知道哪些动作是半截的。",
            "没有在跑的一轮时如实回一句，不会假装做了什么。",
        ),
    ),
    CommandDef(
        name="mode",
        summary="切 Agent 模式（plan / build / edit / yolo）",
        usage="/mode [plan|build|edit|yolo]",
        details=(
            "不带参数时只报当前档，四档的语义见 services/modes.py：",
            "plan = 先给计划再动手 / build = 变更前确认（默认档）/",
            "edit = 自动编辑 / yolo = 少确认全放行。",
            "切换**下一轮生效**，并在会话日志里记一条 `mode/changed`",
            "（带 previousMode 与 source，照 ZCode 的 SessionModeChanged）。",
        ),
    ),
    CommandDef(
        name="model",
        summary="看这条会话用的对话模型，或者换一个",
        usage="/model [模型名]",
        details=(
            "不带参数时列出**可选的对话模型**，并标出这条会话现在用的是哪一个"
            "（筛选口径与输入框右侧那个 ModelPicker 一致：供应商启用、能力为空或含 chat）。",
            "带参数时把**这条会话**换成它：模型 ID（形如 gpt-4o）或清单里那个 pk 都认，",
            "认不出来时把可选清单回给你。",
            "写的是会话记录里那一栏（`ConversationService.set_model`）——与在界面上换模型",
            "是同一条链路，不是另存一份。",
        ),
    ),
    CommandDef(
        name="plan",
        summary="切到计划档；带上描述就直接开始规划",
        usage="/plan [描述]",
        details=(
            "不带参数就是 `/mode plan` 的语义化入口：切到 plan 档，并在会话日志里记一条",
            "`mode/changed`（source=command）。这一档下没给出计划、对方没确认之前，",
            "会改动东西的工具一律不执行（只读的照跑，见 services/plan_gate.py）。",
            "带上描述时那一段描述**当作这一轮的提示**（与 /skill 同一条改写法）：",
            "模型先给计划、等你确认，所以这一轮照常过模型、也照常有回答。",
        ),
    ),
    CommandDef(
        name="skill",
        summary="把某个技能的正文注入这一轮（并可选地带上任务）",
        usage="/skill <技能名> [任务]",
        details=(
            "照 ZCode 的 `/skill [<name> [task]]`：它**强制先加载技能**，把正文当作",
            "这一轮的提示，所以还是要过一次模型、还是会留下回答。",
            "不给任务时让它按技能的流程开始（需要什么会先问你）。",
        ),
    ),
)
"""内置命令表。

``/model`` 与 ``/plan`` 是**补**进来的那两条（开发计划 §12.225 P1-2 点名、第一轮漏掉）：
``/model`` 照 QwenPaw 的 ``/model`` 与 ZCode 的 ``CommandUiSpec.popupSelect``
（"命令弹一个选择列表"→ 我们没有那层 UI 协议，等价物就是"不带参数列清单、带参数切"），
``/plan`` 照 QwenPaw 的 ``/plan``（``/mode plan`` 的语义化入口，顺带把描述当这一轮的提示）。
上一轮只落六条的理由是"`/mode plan` 已经覆盖了切计划档、选模型在 ModelPicker 里更好用"；
现在的结论是**它们不是重复**：少一次"先敲 `/mode plan` 再重新说一遍任务"的往返，
而且脚本/MCP 那条没有界面的路上，`/model` 是唯一能换模型的地方。
"""

#: 内置命令的名字。**常量一处定义**：协议层按名字分流（``/help`` 列什么、
#: ``/mode`` 怎么执行），散着写字符串就会出现"某处写成 mode、某处写成 modes"
#: 这种只有真调起来才发现对不上的错。
NAME_HELP = "help"
NAME_COMPACT = "compact"
NAME_NEW = "new"
NAME_STOP = "stop"
NAME_MODE = "mode"
NAME_MODEL = "model"
NAME_PLAN = "plan"
NAME_SKILL = "skill"

_BUILTIN_BY_NAME = {item.name: item for item in BUILTIN_COMMANDS}

#: ``/mode`` 能接受的取值。四档的**唯一来源**在 ``services/modes``，这里不另抄一份。
MODE_VALUES: tuple[str, ...] = MODES


def builtin_names() -> tuple[str, ...]:
    return tuple(item.name for item in BUILTIN_COMMANDS)


def is_builtin(name: str) -> bool:
    return name in _BUILTIN_BY_NAME


def modes_text() -> str:
    """四档的一句话清单（``/mode`` 不带参数时回给用户看）。"""
    return "\n".join(
        f"- {MODE_DEFS[name].label}（{name}）：{MODE_DEFS[name].hint}——{MODE_DEFS[name].detail}"
        for name in MODES
    )


# --------------------------------------------------------------------- 解析与渲染


def parse(text: str) -> ParsedCommand | None:
    """把一条输入解析成命令；**不是命令就返回 ``None``**。

    判定只有一条：**第一个词以 ``/`` 开头**。开头那个 ``/`` 之后的部分就是命令名
    （大小写不敏感，照 ZCode 的归一化：``/Help`` 与 ``/help`` 是同一条）。

    认不出的 ``/xxx`` **也返回命令**（``name="xxx"``），由调用方回一句"没有这个命令"
    ——DSH 那条「``/`` 行永不静默降级为普通 prompt」就是这个意思：静默发给模型的话，
    用户以为自己在用命令，而模型在猜他想说什么；两种体验差得远，而"那句话到底被谁读了"
    用户根本看不出来。

    只有一个孤零零的 ``/`` 时按 ``/help`` 处理（与各家终端里的补全一致）。

    **本函数不查命令表**（纯函数、无 IO）：解析与"存不存在"分开，是为了让
    "以 ``/`` 开头的输入一律走命令这条路"这个决定只写一次。
    """
    stripped = (text or "").lstrip()
    if not stripped.startswith("/"):
        return None
    head, _, rest = stripped[1:].partition(" ")
    name = head.strip().lower()
    if not name:
        return ParsedCommand(name="help", args="")
    return ParsedCommand(name=name, args=rest.strip())


def split_args(args: str) -> list[str]:
    """按空白切成位置参数（``$1``…``$N`` 用）。

    **不解析引号**：ZCode 的参数语义只有两条占位符、没有引号转义那一层，
    而多一层语法就多一类"为什么我的引号被吃掉了"。要带空格的整段就用 ``$ARGUMENTS``。
    """
    return [item for item in (args or "").split() if item]


def render(command: CommandDef, args: str) -> str:
    """把一条**自定义**命令渲染成这一轮的提示正文。

    三条照 ZCode 的规则，顺序不能换：

    1. ``$ARGUMENTS`` → 全部参数原样；
    2. ``$1``…``$N`` → 按空白切分的第 N 个（越界替成空串，不报错）；
    3. **一个占位符都没命中、但用户给了参数** → 末尾追加 ``用户参数：<原文>``
       （那个"命令没收到参数"的困惑就是靠它消掉的）。

    内置命令不走这里：``/skill`` 的正文由 ``ChatService.skill_prompt`` 渲染，
    其余五条的行为在协议层。
    """
    body = command.body or ""
    text = (args or "").strip()
    # "有没有占位符"必须**在替换之前**判断（替换之后 ``$ARGUMENTS`` 已经没了）
    used = "$ARGUMENTS" in body or re.search(r"\$\d", body) is not None
    if "$ARGUMENTS" in body:
        body = body.replace("$ARGUMENTS", text)
    if re.search(r"\$\d", body) is not None:
        pieces = split_args(text)

        def _substitute(match: re.Match[str]) -> str:
            index = int(match.group(1))
            return pieces[index - 1] if 1 <= index <= len(pieces) else ""

        body = re.sub(r"\$(\d+)", _substitute, body)
    if text and not used:
        body = f"{body.rstrip()}\n\n{USER_ARGUMENTS_LABEL}{text}"
    return body.strip()


# --------------------------------------------------------------------- 发现


def _repo_commands_dir() -> Path:
    """仓库自带的 ``commands/``（与 ``skills/`` 同级）。

    与 ``services/skills._repo_skills_dir`` 同一套推法：**按代码位置推**而不是按
    ``cwd``——后端可能从任何目录启动，而"自带的那批命令在哪"不该随启动目录变。
    """
    return Path(__file__).resolve().parents[3] / COMMANDS_DIR


class CommandService:
    """发现并渲染命令。**命令目录只读**：这个类不往里写任何东西。

    **无状态地扫盘**（与技能、插件同一条理由）：用户可能刚往里丢了一个 md 文件，
    所以每次调用重新扫；缓存要处理失效，为省这点开销不划算。
    """

    def __init__(
        self,
        data_dir: Path,
        *,
        builtin_dir: Path | None = None,
        conversations=None,  # type: ignore[no-untyped-def]
    ) -> None:
        self._data_dir = data_dir
        # 显式注入 > 按代码位置推。显式注入排最前是为了测试能指到临时目录
        # （断言的对象不该被"机器上恰好有什么"改掉），与技能那一档逐字一致。
        self._builtin_dir = builtin_dir if builtin_dir is not None else _repo_commands_dir()
        #: 只用来读"这条会话上一轮是哪一档"（模式观测的基线，见 ``ModeWatch``）。
        #: 可选：不给就退回"进程内见过的档"，脚本与单测不必为此造一个服务。
        self._conversations = conversations
        self.mode_watch = ModeWatch(self._baseline_mode)
        #: "谁在跑 / 谁被叫停了"（``/stop`` 用它，见 ``TurnControl``）。
        self.turns = TurnControl()

    # ------------------------------------------------------------------ 发现源

    @property
    def user_dir(self) -> Path:
        """用户级命令目录（``<data_dir>/commands/``）——放进来就是一个命令。"""
        return self._data_dir / COMMANDS_DIR

    @property
    def builtin_dir(self) -> Path:
        """随代码发布的 ``commands/``。**不存在就跳过**（空目录也是跳过，不是错误）。"""
        return self._builtin_dir

    # ------------------------------------------------------------------ 读

    def list(self) -> list[CommandDef]:
        """全部命令（含加载失败的与被遮蔽的）。顺序：内置在前，其余按名字。

        **first match wins**：同名时以先出现的那条为准——内置 > 用户 > 仓库
        （与技能那一档的"内置优先"同一条，与插件的"用户优先"相反；照 ZCode 的命令
        去重顺序改写，见模块头）。先到的那条留下，后来的那条**以 ``shadowed_by``
        留在列表里**（与"生效的那条"同名、排在它后面，界面据此显示"被谁遮蔽"）。
        """
        found: dict[str, CommandDef] = {}
        shadowed: list[CommandDef] = []
        sources = (
            BUILTIN_COMMANDS,
            self._load_dir(self.user_dir),
            self._load_dir(self.builtin_dir),
        )
        for candidates in sources:
            for record in candidates:
                current = found.get(record.name)
                if current is None:
                    found[record.name] = record
                    continue
                shadowed.append(_shadowed(record, by=current.name))
        return sorted(
            [*found.values(), *shadowed],
            # 同名的两条里**能用的那条排前面**（它才是 ``find`` 会给出来的那条）
            key=lambda item: (item.source != "builtin", item.name, bool(item.shadowed_by)),
        )

    def find(self, name: str) -> CommandDef | None:
        """按名字取**能用的**那一条（被遮蔽的与坏掉的取不到）。"""
        record = self.any_named(name)
        return record if record is not None and record.usable else None

    def any_named(self, name: str) -> CommandDef | None:
        """按名字取一条，**不分能不能用**（``/help`` 要能解释"它为什么没生效"）。

        同名的两条（生效的 + 被遮蔽的）里**优先给能用的那条**：``find`` 与 ``/help``
        要的都是"这条命令现在的样子"。
        """
        wanted = (name or "").strip().lower()
        if not wanted:
            return None
        matches = [item for item in self.list() if item.name == wanted]
        for item in matches:
            if item.usable:
                return item
        return matches[0] if matches else None

    def catalog(self) -> list[CommandDef]:
        """能用的那批（菜单与 ``/help`` 用），按名字排序。"""
        return sorted((item for item in self.list() if item.usable), key=lambda item: item.name)

    # ------------------------------------------------------------------ 内部

    def _load_dir(self, root: Path) -> list[CommandDef]:
        """扫一个目录下的 ``*.md``（**只扫一层**，照 ZCode 的"一个文件就是一条命令"）。"""
        if not root.is_dir():
            return []
        out: list[CommandDef] = []
        for path in sorted(root.iterdir()):
            if not path.is_file() or path.suffix.lower() != COMMAND_FILE_SUFFIX:
                continue
            if path.name.startswith((".", "_")):
                # 约定：``_`` 开头是模板/片段（不是命令），``.`` 开头是编辑器临时文件
                continue
            out.append(self._load(path))
        return out

    def _load(self, path: Path) -> CommandDef:
        """读一个命令文件。**坏文件不抛错**：一条命令写坏了不该让整个列表 500。

        处置与技能那一档一致：失败的那条**留在列表里**，带着原因。
        """
        name = path.stem.strip().lower()
        # 合法性判**原样的文件名**（照 ZCode 的那条正则：它约束的是文件名本身），
        # 命令名再归一成小写——所以 ``Bash_Tool.md`` 是"丢弃并记原因"，
        # 而不是被悄悄改成 ``bash_tool``（那种"改了名就生效"最难查）
        reason = _name_error(path.stem.strip())
        if reason:
            return self._failed(path, name=name, reason=reason)
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            # ``UnicodeDecodeError`` 是 ``ValueError`` 的子类、**不是 OSError**：
            # 只写 ``except OSError`` 会让它直接穿透（技能那一档真踩过）
            return self._failed(path, name=name, reason=f"读不到文件：{_read_reason(error)}")
        meta, body = parse_frontmatter(text)
        description = meta.get("description")
        hint = meta.get("argument-hint")
        model = meta.get("model")
        hint_text = hint.strip() if isinstance(hint, str) else ""
        return CommandDef(
            name=name,
            summary=(description.strip() if isinstance(description, str) else "")
            or _first_line(body)
            or "（这条命令没写 description）",
            usage=f"/{name}{' ' + hint_text if hint_text else ''}",
            source=self._source_of(path),
            argument_hint=hint_text,
            allowed_tools=_string_tuple(meta.get("allowed-tools")),
            model=model.strip() if isinstance(model, str) else "",
            body=body.strip(),
            path=str(path),
        )

    def _failed(self, path: Path, *, name: str, reason: str) -> CommandDef:
        """名字不合法时的那条记录：**留在列表里**（带原因），但调不到。"""
        return CommandDef(
            name=name,
            summary=reason,
            source=self._source_of(path),
            path=str(path),
            error=reason,
        )

    def _source_of(self, path: Path) -> str:
        return "user" if path.parent == self.user_dir else "repo"

    def _baseline_mode(self, conversation_id: str) -> str | None:
        """这条会话**上一次跑的时候**是哪一档（日志里没有记录就 ``None``）。

        读的是日志里最后一条 ``turn/start`` 的 ``mode``——那条事件是"这一轮以哪一档
        开跑"的权威记录（见 ``session_events.turn_start_draft``）。**一条会话只读一次**：
        ``ModeWatch`` 记住之后就不再问日志。
        """
        if self._conversations is None or not conversation_id:
            return None
        try:
            events = self._conversations.session_events(conversation_id, kinds=[KIND_TURN_START])
        except Exception:
            logger.warning("读会话上一轮的模式失败：%s", conversation_id, exc_info=True)
            return None
        for event in reversed(list(events)):
            mode = event.payload.get("mode")
            if isinstance(mode, str) and mode:
                return mode
        return None


def _shadowed(record: CommandDef, *, by: str) -> CommandDef:
    """把一条记录标成"被遮蔽"。

    dataclasses.replace 在这里不够用（要显式控制哪些字段跟着走），但**逐字段抄一份**
    也容易漏——所以这里只在末尾多写一个字段，其余原样带过去。
    """
    return CommandDef(
        name=record.name,
        summary=record.summary,
        usage=record.usage,
        details=record.details,
        source=record.source,
        argument_hint=record.argument_hint,
        allowed_tools=record.allowed_tools,
        model=record.model,
        body=record.body,
        path=record.path,
        shadowed_by=by,
        error=record.error,
    )


def _name_error(name: str) -> str:
    """文件名能不能当命令名（照 ZCode 的那条正则）。"""
    if not name:
        return "文件名不能当命令名（空）"
    if not COMMAND_NAME_RE.match(name):
        return (
            f"命令名 {name!r} 不合法（要求：小写字母或数字开头，之后只允许小写字母、"
            "数字、下划线、冒号、连字符，最长 64 个字符）"
        )
    return ""


def _string_tuple(raw: object) -> tuple[str, ...]:
    """frontmatter 里的列表字段：字符串按逗号切，列表逐项转字符串。

    与 ``memory_files._tags_of`` 同一套宽容口径——frontmatter 是手写的，
    ``allowed-tools: [read, write]`` 与 ``allowed-tools: read, write`` 都要认。
    """
    if isinstance(raw, str):
        parts = [part.strip() for part in raw.split(",")]
    elif isinstance(raw, list):
        parts = [str(part).strip() for part in raw]
    else:
        return ()
    return tuple(part for part in parts if part)


def _first_line(body: str) -> str:
    """正文第一行非空文字（没写 ``description`` 时拿它当摘要）。"""
    for line in (body or "").splitlines():
        text = line.strip().lstrip("#").strip()
        if text:
            return text[:120]
    return ""


def _read_reason(error: Exception) -> str:
    text = " ".join(str(error).split())
    return text[:200] if text else error.__class__.__name__


# --------------------------------------------------------------------- 模式观测


class ModeWatch:
    """**会话级的模式观测**：记一条会话上一次跑的是哪一档（P1-1 遗留第 6 条）。

    为什么需要它：我们的模式是**应用级配置**（``chat.mode``，见
    ``services/runtime_config``），而 ZCode 那条 ``SessionModeChanged`` 是**会话级**
    事件。设置页/输入框那个控件改档时手里没有会话，写不出事件；所以这里在每一轮开始时
    对照一下"这一轮是哪一档、上一轮是哪一档"，变了就补一条 ``mode/changed``
    （``source="settings"``）。**在会话里当场切的**（``/mode``）由协议层直接记
    （``source="command"``），并顺手 ``note`` 到这里，免得下一轮再补一条重复的。

    **进程内**（不持久化），基线在第一次遇到某条会话时从日志里读一次
    （见 ``CommandService._baseline_mode``）——重启之后也不会漏记第一条会话的那次切换。
    """

    def __init__(self, baseline: Callable[[str], str | None] | None = None) -> None:
        self._baseline = baseline or (lambda _conversation_id: None)
        self._seen: dict[str, str] = {}
        self._lock = threading.Lock()

    def observe(self, conversation_id: str, mode: str) -> str | None:
        """这一轮开跑前记一笔；**档变了就返回上一档**，没变（或无从比较）返回 ``None``。

        没有会话（脚本、无状态调用）时返回 ``None``：没有会话就没有可落的日志。
        ``None`` 也是"日志里查不到上一档"时唯一的答案——**宁可不记，也不写一个猜的
        previousMode**：审计日志里出现一个错的"上一档"，比缺一条难查得多。
        """
        if not conversation_id:
            return None
        with self._lock:
            previous = self._seen.get(conversation_id)
            if previous is None:
                previous = self._baseline(conversation_id)
                self._seen[conversation_id] = mode
                if previous is None or previous == mode:
                    return None
                return previous
            self._seen[conversation_id] = mode
            return previous if previous != mode else None

    def note(self, conversation_id: str, mode: str) -> None:
        """**不比较、只同步**：调用方已经自己记过这条切换了（``/mode`` 那条路）。"""
        if not conversation_id:
            return
        with self._lock:
            self._seen[conversation_id] = mode

    def forget(self, conversation_id: str) -> None:
        """忘掉一条会话（删除会话时调用；best-effort，留着只是多占一点内存）。"""
        with self._lock:
            self._seen.pop(conversation_id, None)


class TurnControl:
    """**哪条会话上正有一轮在跑**，以及"把它停掉"（P1-2 的 ``/stop``）。

    ``/stop`` 是三家共同的一条纪律（调研报告 §2.7 抄点第 5 条：「审批/停止也要是
    **一等命令**，没有前端按钮时仍能跑通」）。我们这边"这一轮"跑在**另一个请求**里
    （SSE 那条流，见 ``api/v1/chat.py``），所以这一层只做两件事：登记"谁在跑"、
    挂一个停止标记让那条流自己收工。

    **为什么不是直接杀线程**：那条流的线程可能正卡在一次工具调用里（抓网页、
    等模型），从外面掐掉它的结果是"这一轮没有任何收尾"——而后端要记的那条
    ``interrupted``（含"哪些调用没有结果"）恰恰是在收尾里写的。所以停止是**协作式**的：
    标记一下，那条流在两次事件之间自己看到、自己收尾。

    **进程内**（不持久化）：一轮的寿命就是这条流，进程重启之后本来也没有"在跑的一轮"了。
    """

    def __init__(self) -> None:
        self._active: set[str] = set()
        self._stopped: set[str] = set()
        self._lock = threading.Lock()

    def begin(self, conversation_id: str | None) -> None:
        """这一轮开始跑了（**清掉上一轮可能留下的停止标记**，否则新一轮一进来就被停）。"""
        if not conversation_id:
            return
        with self._lock:
            self._active.add(conversation_id)
            self._stopped.discard(conversation_id)

    def end(self, conversation_id: str | None) -> None:
        """这一轮收工了（无论成功、失败还是被停）。"""
        if not conversation_id:
            return
        with self._lock:
            self._active.discard(conversation_id)
            self._stopped.discard(conversation_id)

    def request_stop(self, conversation_id: str) -> bool:
        """请求停止；**返回"当时确实有一轮在跑"**（没有就是没有，不假装）。"""
        if not conversation_id:
            return False
        with self._lock:
            if conversation_id not in self._active:
                return False
            self._stopped.add(conversation_id)
            return True

    def stop_requested(self, conversation_id: str | None) -> bool:
        """这一轮该收工了吗（流在两次事件之间问它；**只读**）。

        非破坏性地读：一次停止请求对它之后的**每一次**检查都成立——流那边发现它之后
        还要走收尾（补事件、发 done），而收尾里又会看一眼，撕掉标记的话第二次就看不到了。
        标记由 ``begin`` / ``end`` 清。
        """
        if not conversation_id:
            return False
        with self._lock:
            return conversation_id in self._stopped

    def running(self, conversation_id: str | None) -> bool:
        """这条会话上有没有一轮在跑（界面/脚本查询用）。"""
        if not conversation_id:
            return False
        with self._lock:
            return conversation_id in self._active
