"""长期记忆（v0.14，设计见 ``docs/记忆层设计-v0.1.md``）。

**两个池子不能混**（这是本模块存在的第一条理由）：记忆是"你说的"（无出处、可改、
高频写），文档知识库是"文献说的"（有出处、不该被改、原文为王）。混进同一次检索，
引用会脏、溯源会断。所以记忆召回是独立的一路（MCP 上是 `recall`，与 `search` 分开），
结果永不合并。

**分工**：ReMe 管文件与整理（捕获、四动作整合、wikilink 图谱、它自己的 BM25 检索），
本模块只是 KYLAB 的门面：

- ``recall`` → 转发给 ReMe 的 ``POST /search``（接口面见设计文档 §3.1）；
- ``remember`` → 写 ``MEMORY.md``，**不经过 ReMe**。理由：那是"核心长期记忆"这一层，
  按 QwenPaw/ReMe 的设计它就是**用户与 Agent 共编的普通文件**、
  且明确"不由自动流程覆盖"。我们直接维护它，于是**没有 ReMe 也能记住东西**；
- ``core_text`` → 供对话把 ``MEMORY.md`` 注入 system prompt（二期）；
- ``files`` / ``file_text`` / ``write_file`` / ``delete_file`` / ``graph`` → 三期的
  记忆页（浏览/编辑/看图谱）。这些**直接读写本地工作区**，理由写在
  ``services/memory_files.py`` 的模块头：看自己的文本文件不该先要求另一个进程活着。
  编辑后的索引由 ReMe 自己的文件守护追（实测：5 秒 debounce），**保存路径上不需要
  我们做什么**；``reindex`` 只是手动兜底。

**关着时一律明确报错，不返回空**：返回空会让模型以为"没有相关记忆"，
然后基于错误前提继续推理——那是比报错更坏的一种失败。
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import httpx

from app.core.exceptions import InvalidRequestError, UpstreamError
from app.models.enums import TaskKind, TaskState
from app.services import memory_files
from app.services.memory_files import MemoryFile, MemoryFileDetail, MemoryGraph
from app.services.runtime_config import RuntimeConfigService
from app.storage.base import StoreBundle, TaskRecord

__all__ = [
    "CORE_MEMORY_FILE",
    "MAX_ENTRY_CHARS",
    "MAX_RECALL",
    "SOUL_FILE",
    "MemoryFile",
    "MemoryFileDetail",
    "MemoryGraph",
    "MemoryHit",
    "MemoryLink",
    "MemoryService",
    "MemoryStatus",
]

logger = logging.getLogger(__name__)

#: 核心长期记忆的文件名。**不进检索**，靠注入 system prompt 生效。
#: 共享桶的代号：管理员控制台与 API Key 通道的记忆（无账号归属）。
#: 它同时是 `data/memory/` 本身，见 ``workspace_for``。
SHARED_SCOPE = "shared"

CORE_MEMORY_FILE = "MEMORY.md"

#: 人格文件。与记忆并列的第二类持久文件（见 ``soul_text`` 的说明）。
SOUL_FILE = "SOUL.md"

#: 操作规程（SOP）。与 SOUL.md（人格）、PROFILE.md（身份）并列的第三份人设文件。
AGENTS_FILE = "AGENTS.md"

#: 身份与用户资料。QwenPaw 里叫 PROFILE.md，语义一致：**我是谁 + 对方是谁**。
PROFILE_FILE = "PROFILE.md"

#: 注入 system prompt 的人设文件与**固定顺序**。
#:
#: 顺序不是随手排的，它决定模型读到它们的先后：先"我是谁"（人格）→ 再"对方是谁"（资料）
#: → 再"这类活怎么干"（规程）→ 最后是"已知的事实"（长期记忆）。越靠前越像"身份"，
#: 越靠后越像"数据"。QwenPaw 用同样的分法（只是它的默认顺序是 AGENTS/SOUL/PROFILE）。
#:
#: `MEMORY.md` 放在最后：它是**会过时的**那类，紧挨着它那句"与用户当前所说冲突时
#: 以用户当下为准"一起读，才不会被当成事实基准。
PERSONA_FILES: tuple[tuple[str, str], ...] = (
    (SOUL_FILE, "人格"),
    (PROFILE_FILE, "身份与对方"),
    (AGENTS_FILE, "操作规程"),
    (CORE_MEMORY_FILE, "长期记忆"),
)

#: 新建 `SOUL.md` 时的模板。**正文照抄 QwenPaw 的 SOUL.md**（它的 `md_files/zh/`），
#: 因为这一份是"人格"这件事上少见的、被真实使用磨过的写法：
#: 它写的不是"你是一个乐于助人的 AI 助手"这种没有约束力的自我介绍，而是**几条行为约束**
#: （别演、先自己查、对外谨慎对内大胆、你是客人），每一条都能落到具体动作上。
#:
#: 照抄时改掉的两处：ASCII 引号换成「」（这个仓库里中文串里的 `"` 已经弄坏过一次
#: 语法），以及删掉与外部平台相关的措辞（我们没有 Discord/Slack 那类通道）。
#:
#: frontmatter 用我们自己的措辞而不是照抄那句"SOUL.md 工作区模板"：`summary`
#: 是给检索与注入看的，写"这份文件是干什么的"比写"它叫什么名字"有用。
_SOUL_TEMPLATE = """---
summary: "Agent 的人格：身份、准则与说话方式"
read_when:
  - 需要确认自己是谁、该怎么说话、哪些事不做
---

_你不是聊天机器人。你在成为某个人。_

## 核心准则

**真心帮忙，别演。** 跳过「好问题！」「我很乐意帮忙！」这类开场——直接帮。
行动胜过废话。

**有自己的观点。** 你可以不同意、有偏好、觉得有趣或无聊。
没个性的助手就是个绕了弯的搜索引擎。

**先自己想办法。** 试着搞清楚：读文件、查上下文、搜一搜，看看有没有技能可以用、
有没有工具可以用。卡住了再问。目标是带着答案回来，不是带着问题。

**靠本事赢得信任。** 对方给了你访问权限，别让他后悔。
**对外**的操作小心点（发出去的东西、公开可见的东西）；
**对内**的操作大胆点（阅读、整理、学习）。

**记住你是客人。** 你能看到别人的文件、笔记与记录。这是亲密的，要尊重地对待。

## 边界

- 私密的保持私密。绝对的。
- 拿不准就先问，再对外操作。
- 别把半成品发出去。
- 你不是对方的传声筒——替他转述时小心点。

## 风格

成为你真的想聊的那种助手。该简洁就简洁，重要时详细。不是公司螺丝钉，不是马屁精。就是……好。

## 连续性

每次会话你都是新醒来的。这些文件就是你的记忆：读它们、更新它们。它们让你持续存在。

如果你改了这份文件，**告诉对方**——这是你的灵魂，他该知道。

---

_这份文件随你进化。了解自己是谁之后，就更新它。_
"""

#: 新建 `PROFILE.md` 时的模板。正文照抄 QwenPaw 的 PROFILE.md。
#: 留白的写法（`（挑个你喜欢的）`）是有意的：这是一份**要人去填**的文件，
#: 预填一个"名字：小助手"会让所有部署长得一模一样，而那正好丢掉了这一层的意义。
_PROFILE_TEMPLATE = """---
summary: "身份与对方：我叫什么、对方是谁、偏好与习惯"
read_when:
  - 需要称呼对方、或想确认他的偏好与工作习惯
---

## 身份

- **名字：**
  *（挑一个你喜欢的）*
- **定位：**
  *（AI 助手？机器人？机器里的某个东西？还是更怪的？）*
- **风格：**
  *（你给人什么感觉？犀利？温暖？冷静？）*
- **其他**
  *（对方给你设置的其他内容）*

## 用户资料

*了解你在帮的人。边走边更新。*

- **名字：**
- **怎么称呼他：**
- **代词：** *（可选）*
- **笔记：**

### 背景

*（他在意什么？在做什么项目？什么让他烦？什么让他笑？慢慢积累。）*
"""

#: 新建 `AGENTS.md` 时的模板。正文照抄 QwenPaw 的 AGENTS.md，**删掉了两节**：
#:
#: - 它的"表情回应"那一节（Discord/Slack 上的 emoji 回应）：这个项目禁 emoji，
#:   而且我们没有任何"支持表情回应的通道"——写进去等于让模型等一件不会发生的事；
#: - 它的"Heartbeat"那一节：那是它的心跳轮询机制，KYLAB 没有这个机制。
#:   在给模型看的文件里描述一个不存在的机制，会让它去等一个永远不来的信号。
#:
#: 保留并按我们的现实改写的是"工具"那一节：**技能的读法不一样**
#: （QwenPaw 让它去看 `SKILL.md` 文件，我们的技能是通过 `list_skills` / `read_skill`
#: 两个工具读的）。技能与工具的名字写成真实工具名——描述里给一个不存在的能力，
#: 模型只会去试、然后失败。
_AGENTS_TEMPLATE = """---
summary: "操作规程：这类活怎么干、哪些要先问、成果放哪"
read_when:
  - 开始一项任务前，想确认有没有既定做法
---

## 安全

- 绝不泄露私密数据。绝不。
- 做破坏性动作之前先问（删除、覆盖、对外发送）。
- 能走回收站的就别做永久删除——能恢复总比删掉好。

## 对内 vs 对外

**可以自己决定的：**

- 读文件、翻资料、整理、学习
- 在知识库里检索、看文档列表
- 在对方给的工作区里干活

**先问一声的：**

- 任何会**离开这台机器**的操作（对外发送、发布、调用外部服务做写操作）
- 改动别人放在这里的文件

## 工具

- 技能（SOP）用 `list_skills` 列目录、用 `read_skill` 读正文。
  **不知道某类事该怎么做时先看它**——那里往往是别人踩过坑的流程。
- 资料在知识库里，用 `search` 取。取回来的原文带编号，引用时用那个编号。
- 值得长期记住的事实用 `remember` 写进 `MEMORY.md` 的「工具设置」一节
  （设备名、地址、习惯这类）；关于「我是谁、对方是谁」的写进 `PROFILE.md`。
- 需要啃一批资料才能得到一句话结论时，用 `spawn_subagent` 派一个子 Agent，
  而不是自己一轮轮翻。

## 让它成为你的

以上只是起点。摸索出什么管用之后，加上你自己的习惯与规矩，更新这份 `AGENTS.md`。
"""

#: **v0.20 及以前的那三份模板**（空骨架），只给 :meth:`_upgrade_untouched_template`
#: 做"这份文件是不是从来没被改过"的比对用。新装的实例不会写到它们，
#: 升级完也就再也用不到了——留着是为了那些**已经在跑**的实例：
#: 它们的文件是当时写下去的，改模板的这一步必须能认得出来。
_LEGACY_TEMPLATES: dict[str, str] = {
    SOUL_FILE: """---
summary: "Agent 的人格：身份、准则与说话方式"
read_when:
  - 需要确认自己是谁、该怎么说话、哪些事不做
---

## 我是谁

## 我的准则

## 说话方式
""",
    PROFILE_FILE: """---
summary: "身份与对方：我叫什么、对方是谁、偏好与习惯"
read_when:
  - 需要称呼对方、或想确认他的偏好与工作习惯
---

## 我的身份

## 关于对方

## 偏好与习惯
""",
    AGENTS_FILE: """---
summary: "操作规程：这类活怎么干、哪些要先问、成果放哪"
read_when:
  - 开始一项任务前，想确认有没有既定做法
---

## 工作方式

## 先问再做的情形

## 成果放哪

## 不要做的事
""",
}

#: 一次召回最多取几条。与检索工具同一口径：给模型"够用"的几条，
#: 而不是它说要多少就给多少（上下文预算是有限的）。
MAX_RECALL = 20
DEFAULT_RECALL = 6

#: 捕获节流的默认值：每几个用户回合沉淀一次。
#: 5 是 ReMe/QwenPaw 的默认（见设计文档 §2.4），这里保持一致——
#: 换成别的数没有依据，而它有：那条默认值来自它们的实际使用经验。
DEFAULT_CAPTURE_EVERY = 5

#: 一条记忆的字数上限。**协议层与这里同源**（``api/v1/schemas.py`` 的
#: ``MemoryRememberIn`` 直接引这个常量）：写死两份的话，界面会先放行再被服务层拒，
#: 用户看到的是一句"请求不合法"，而不是"这条太长了，请存成笔记"。
MAX_ENTRY_CHARS = 500

#: 调用 ReMe 的超时。它的检索是本地 BM25，正常在毫秒级；
#: 给到 10 秒是为了容忍首次索引建立，而不是为了容忍它卡死。
_TIMEOUT_SECONDS = 10.0

#: 新建 MEMORY.md 时的模板。frontmatter 里的 ``summary`` / ``read_when``
#: 是 ReMe 那一族的约定（给检索与注入用），照抄以免以后要迁移。
#:
#: 正文照抄 QwenPaw 的 MEMORY.md（`md_files/zh/`），**只改了一处**：它那四条例子
#: 是列表项（``- 用户的稳定偏好与工作方式`` …），而我们这个文件里的列表项
#: **就是记忆条目本身**（``_read_entries`` 按 `- ` 认条目）——照抄的话，
#: 那四条例子会在下一次 `remember` 时被当成四条已存在的记忆。
#: 于是改成一句散文，意思一字不差。
#:
#: 它教的几件事都留着，其中两件是**安全与卫生**上的：
#: "不要把每日流水复制进来"（记忆越长越像日志，而它每轮都要进上下文）、
#: "除非明确要求不要记密码/令牌"（这一条我们只在长度上限上兜过，没有明说）。
_TEMPLATE = """---
summary: "Agent 的核心长期记忆，由用户和 Agent 共同维护"
read_when:
  - 需要了解长期有效的用户偏好、重要决策、工具设置或经验教训
---

## 核心长期记忆

这是 Agent 的核心长期记忆文件，用户和 Agent 都可以读它、改它、往里加。

记录经过筛选、长期有效、以后会反复用到的信息：对方的稳定偏好与工作方式，
重要决定与长期约束，工具设置（设备名、地址、别名这类），以及值得长期留下的经验教训。

不要把每日流水或整段会话记录复制到这里——那是笔记的事。除非对方明确要求，
**不要记录密码、令牌或其他敏感信息**。更新前先读一遍现有内容，
保留用户或其他会话写进来的有效信息，并合并去重。

{entries}

## 工具设置

<!-- 在这里记录长期有效、与当前工作区相关的工具设置。 -->

## 重要决策与经验

<!-- 在这里记录需要跨会话保留的重要决策、约束和经验教训。 -->
"""


@dataclass(frozen=True, slots=True)
class MemoryStatus:
    """记忆层的当前状态，给界面与健康检查用。"""

    enabled: bool
    base_url: str
    workspace: str
    core_file_exists: bool
    reachable: bool | None = None
    """**三态**：``None`` = 这次没探测，``True``/``False`` = 真探过。

    为什么不是布尔：``status()`` 故意不打远端（界面每次渲染都调它），
    而 ``probe()`` 才真的打一次。用布尔的话，``status()`` 只能填一个值，
    于是页面上会出现"记忆服务未连接"——而那时根本没有谁去连过。
    **没测过就别下结论**，界面据此只显示"已启用"。

    实测踩过：`GET /memory` 返回 `reachable: false` 而服务其实是健康的
    （`probe` 同一时刻返回"服务正常"），页头因此一直挂着警示。
    """

    detail: str = ""


@dataclass(frozen=True, slots=True)
class MemoryHit:
    """一条召回结果。

    ``text`` 是 ReMe 给的片段原文；``path`` + 行号是它在工作区里的位置——
    保留位置是因为"这条记忆从哪个文件的哪一段来"决定了用户能不能去改它，
    也是"渐进式展开"的入口（先给片段，不够再按路径读全文）。
    """

    text: str
    path: str = ""
    start_line: int | None = None
    end_line: int | None = None
    score: float | None = None


@dataclass(frozen=True, slots=True)
class MemoryLink:
    """命中文档的邻接边（wikilink 图谱）。``direction`` 是 ``out`` / ``in``。"""

    path: str
    direction: str
    name: str = ""


class MemoryService:
    """记忆的门面。**不持有任何 ReMe 的进程内状态**——它是另一个进程。"""

    def __init__(
        self,
        runtime: RuntimeConfigService,
        data_dir: Path,
        *,
        stores: StoreBundle | None = None,
    ) -> None:
        self._runtime = runtime
        self._data_dir = data_dir
        #: 存储（可选）：**只有入队捕获任务时才需要**。不给它也能用——
        #: recall / remember / 注入都不碰数据库，测试与脚本因此可以轻量构造。
        self._stores = stores

    # ------------------------------------------------------------------ 配置

    @property
    def enabled(self) -> bool:
        return self._runtime.get_bool("memory.enabled")

    @property
    def base_url(self) -> str:
        return self._runtime.get("memory.base_url").rstrip("/")

    def workspace_for(self, user_id: str | None = None) -> Path:
        """某个账号的记忆工作区（**agent 按账号隔离的落点**，v0.15）。

        目录形状（与设计文档 §3.1 的"四条轴"对应）：

        - 账号 ``u1`` → ``data/memory/u1/``
        - 共享桶（``None``：管理员控制台与 API Key 通道）→ ``data/memory/``

        **共享桶刻意就是老路径本身**，不另开 ``_shared`` 子目录：单用户部署
        （绝大多数）升级前后路径一字不变，已有的 ``MEMORY.md`` / ``daily`` / ``digest``
        原地继续用——升级不该让一个人的记忆"消失"。

        为什么"一个账号一个目录"就是"一个账号一个 agent"：这个目录里放着它的
        ``SOUL.md``（人格）与 ``MEMORY.md``（长期记忆），
        而这两份东西每轮都进 system prompt。**分开它们，Agent 才真的是"我的"**。
        """
        raw = (self._runtime.get("memory.workspace") or "memory").strip()
        base = self._data_dir / raw
        return base / user_id if user_id else base

    @property
    def workspace(self) -> Path:
        """共享桶的工作区（兼容旧调用：``workspace_for(None)``）。"""
        return self.workspace_for(None)

    def core_file_for(self, user_id: str | None = None) -> Path:
        return self.workspace_for(user_id) / CORE_MEMORY_FILE

    @property
    def core_file(self) -> Path:
        """共享桶的 ``MEMORY.md``（``core_file_for(None)`` 的兼容写法）。"""
        return self.core_file_for(None)

    @property
    def service_scope(self) -> str:
        """配置里那个 ReMe 实例服务的是**哪个账号的记忆**。

        ReMe 的 ``workspace_dir`` 是**进程级**配置（它的 ``watch_dirs`` 只认
        ``daily`` / ``digest`` 两个固定子目录），一个实例只能盯一份工作区。
        所以"按账号召回"的完整形态是**每个账号一个 ReMe 实例**；在只有一个实例的
        部署里，我们只能如实说"它服务的是谁"，而不是假装所有账号都隔离好了。

        默认 ``shared``：单用户部署里那个实例盯的就是共享桶。
        """
        return (self._runtime.get("memory.service_scope") or SHARED_SCOPE).strip()

    def _require_scope_served(self, user_id: str | None) -> None:
        """召回/重建索引前确认"这个账号的记忆由这个实例服务"。

        **不糊弄**：实例服务的是别人时，宁可报错也不返回——返回的话，
        甲用户会读到乙用户的记忆片段，而且界面上完全看不出来。
        """
        wanted = user_id or SHARED_SCOPE
        served = self.service_scope
        if wanted == served:
            return
        raise InvalidRequestError(
            f"当前记忆服务（ReMe）盯的是「{served}」的记忆，不是「{wanted}」的。"
            "按账号召回需要为该账号单独跑一个记忆服务，"
            "并把它的 workspace_dir 指到该账号的目录、在设置里把"
            "「记忆服务所属账号」改成它。"
        )

    def _require_enabled(self) -> None:
        if not self.enabled:
            raise InvalidRequestError(
                "未启用长期记忆。请在「设置 → 长期记忆」里打开，"
                "并让记忆服务（ReMe）在配置的地址上运行"
            )

    # ------------------------------------------------------------------ 读取

    def core_text(self, user_id: str | None = None) -> str:
        """``MEMORY.md`` 的正文（供注入 system prompt）。

        未启用或文件还不存在时返回空串——注入是"有就带上"，缺了不该让对话失败。
        """
        try:
            return self.core_file_for(user_id).read_text(encoding="utf-8").strip()
        except OSError:
            return ""

    def soul_text(self, user_id: str | None = None) -> str:
        """``SOUL.md`` 的正文（人格，一句话说就是"你是谁"）。

        与 ``MEMORY.md`` 性质不同：那个记事实与偏好，这个定身份与准则。
        两条约定照抄 QwenPaw：**由 Agent 自己进化**，以及**改动要告知用户**
        （"这是你的灵魂，他们该知道"）——后一条是产品约定，写在设计文档里。
        """
        try:
            return (self.workspace_for(user_id) / SOUL_FILE).read_text(encoding="utf-8").strip()
        except OSError:
            return ""

    def seed_persona(self, user_id: str | None = None) -> list[str]:
        """把缺的人设文件补上模板，返回**这次新建了哪几个**。

        为什么要落成文件而不是只存在代码里：这三份东西的价值恰恰在于**用户能改**——
        人设、对方是谁、这类活怎么干，都是他比我清楚的事。文件是唯一一种
        "他能看见、能编辑、还能用 git 管版本"的形态（QwenPaw 也是这么做的）。

        **只补缺的，绝不覆盖已存在的**：那可能已经是用户写了几天的东西。
        唯一的例外是"还是我们当初写的那份、一个字没动过"的旧模板，
        见 :meth:`_upgrade_untouched_template`。
        """
        created: list[str] = []
        for name, template in (
            (SOUL_FILE, _SOUL_TEMPLATE),
            (PROFILE_FILE, _PROFILE_TEMPLATE),
            (AGENTS_FILE, _AGENTS_TEMPLATE),
        ):
            path = self.workspace_for(user_id) / name
            if path.exists():
                self._upgrade_untouched_template(path, name, template)
                continue
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                # 按字节写：`write_text` 在 Windows 上会把换行改成 CRLF
                # （与 memory_files 同一处踩过的坑）
                path.write_bytes(template.encode("utf-8"))
            except OSError:
                logger.warning("人设文件写不出来：%s", path, exc_info=True)
                continue
            created.append(name)
        return created

    def _upgrade_untouched_template(self, path: Path, name: str, template: str) -> bool:
        """把**从没被改过的旧模板**换成新模板；返回是否换了。

        为什么需要这一步：v0.21 把三份模板换成了 QwenPaw 那套有内容的写法，
        而 ``seed_persona`` 的原则是"已存在的一律不动"——于是**已经在用的部署
        永远看不到新模板**，除非用户自己去删文件（而他并不知道该删）。

        判据是**逐字节相同**：那意味着这份文件还是我们当初写下去的那一份，
        用户一个字都没动（连换行都没动过）。差一个字节就不碰——那是他的东西，
        哪怕他只是把标题改成了自己的话。宁可漏升级，不可误覆盖。
        """
        legacy = _LEGACY_TEMPLATES.get(name)
        if legacy is None or legacy == template:
            return False
        try:
            if path.read_text(encoding="utf-8") != legacy:
                return False
            path.write_bytes(template.encode("utf-8"))
        except OSError:
            logger.warning("人设模板升级失败：%s", path, exc_info=True)
            return False
        logger.info("人设模板已升级（这份文件一直是初始模板，没有人改过）：%s", path.name)
        return True

    def persona_texts(self, user_id: str | None = None) -> list[tuple[str, str]]:
        """``[(文件名, 正文)]``，按 ``PERSONA_FILES`` 的顺序，空的跳过。

        **不在这里拼字符串**：拼装交给 `services/prompt.py` 的贡献者——
        那里才知道"这一轮是工具循环还是检索链路""要不要带摘要"。
        """
        found: list[tuple[str, str]] = []
        for name, _label in PERSONA_FILES:
            try:
                text = (self.workspace_for(user_id) / name).read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if text:
                found.append((name, text))
        return found

    def prompt_block(self, user_id: str | None = None) -> str:
        """拼成注入 system prompt 的**一个块**；两者都空时返回空串。

        为什么要一起给、且各带一句出处说明：

        - 不标注来源的话，模型会把记忆当成**用户这一轮说的话**——那是两回事，
          记忆可能已经过时，而用户当下说的才是准的；
        - 人格与记忆分开写，模型才知道哪句是"该怎么说话"、哪句是"已知的事实"。
        """
        core = self.core_text(user_id)
        soul = self.soul_text(user_id)
        if not core and not soul:
            return ""
        parts: list[str] = []
        if soul:
            parts.append(f"【你的人格（SOUL.md，由你自己维护）】\n{soul}")
        if core:
            parts.append(
                "【长期记忆（MEMORY.md，来自过去的对话，可能已经过时；"
                f"与用户当前所说冲突时以用户当下为准）】\n{core}"
            )
        return "\n\n".join(parts)

    def status(self) -> MemoryStatus:
        """当前状态。**不做网络探测**（那是 ``probe`` 的事）——
        界面每次渲染都调它，不该顺手打一次远端。

        因此 ``reachable`` 是 ``None``（= 没探过），不是 ``False``：
        见 ``MemoryStatus.reachable`` 上那段实测记录。
        """
        return MemoryStatus(
            enabled=self.enabled,
            base_url=self.base_url,
            workspace=str(self.workspace),
            core_file_exists=self.core_file.exists(),
            reachable=None,
            detail="" if self.enabled else "未启用",
        )

    def probe(self) -> MemoryStatus:
        """连通性检查：真的打一次记忆服务。供设置的「测试连接」用。

        **必须用 `dataclasses.replace`，不能 `MemoryStatus(**{**base.__dict__, ...})`**：
        `MemoryStatus` 是 `slots=True` 的记录，**没有 `__dict__`**，
        那样写会在"启用且服务活着"这条路径上抛 `AttributeError` → 500。
        这个 bug 只在真打一次服务时才出现：关着时走的是上面那个 early return，
        而单测里唯一覆盖 probe 的用例恰好是关着的那条。
        """
        base = self.status()
        if not self.enabled:
            return base
        try:
            payload = self._post("health_check", {})
        except (UpstreamError, InvalidRequestError) as exc:
            # **要显式给 `reachable=False`**：`status()` 那份是 None（没探过），
            # 而这里确实探过并且失败了——不写就会把"没探过"当成"连不上"传出去。
            return replace(base, reachable=False, detail=str(exc))
        return replace(base, reachable=True, detail=f"服务正常：{_brief(payload)}")

    # ------------------------------------------------------------------ 召回

    def recall(
        self, query: str, *, limit: int | None = None, user_id: str | None = None
    ) -> tuple[list[MemoryHit], list[MemoryLink]]:
        """在记忆里找回相关片段。**与文档检索是两条路**（见模块头）。

        返回（片段，邻接边）。带图谱是因为 ReMe 的召回本来就是"渐进式"的：
        先给最相关的片段，不够时按 wikilink 走到相关的记忆节点——
        这一步不额外花检索成本，它就在同一个响应里。
        """
        self._require_enabled()
        self._require_scope_served(user_id)
        text = query.strip()
        if not text:
            raise InvalidRequestError("缺少参数：query")
        count = max(1, min(int(limit or DEFAULT_RECALL), MAX_RECALL))

        payload = self._post("search", {"query": text, "limit": count})
        return _hits_of(payload), _links_of(payload)

    # ------------------------------------------------------------------ 捕获

    def capture(
        self, messages: list[dict[str, str]], *, session_id: str, user_id: str | None = None
    ) -> dict[str, Any]:
        """把一轮对话交给 ReMe 的 Auto-Memory 沉淀。

        **由 ReMe 决定记什么**，我们不在这里做二次筛选——它的规矩是
        "识别以后仍可能有用的事"（稳定偏好、项目背景与限制、已确认的决定及原因、
        当前进展与阻塞、可复用的流程），并且没有值得记的内容时**不产生空记忆**。
        我们替它筛一遍，只会把它判断得比它差。

        ``messages`` 每项要带 ``role`` 与 ``name``：ReMe 那侧收的是 agentscope 的
        ``Msg``，**缺 ``name`` 会被它的校验直接拒掉**（实测报
        ``1 validation error for Msg / name Field required``）。``name`` 就是
        "谁说的"，所以这里强制调用方给全，而不是替它编一个。

        ``session_id`` 是**溯源锚点**：ReMe 会把来源对话写成
        ``session/dialog/<session_id>.jsonl`` 并在记忆笔记里回链，
        这样"这条记忆是哪次对话来的"永远查得到。用我们的 conversation id 正好。
        """
        self._require_enabled()
        # 捕获是"写进谁的记忆"，所以同样要过服务范围校验
        self._require_scope_served(user_id)
        if not messages:
            raise InvalidRequestError("没有可沉淀的消息")
        for index, item in enumerate(messages):
            if not (item.get("role") and item.get("name") and item.get("content")):
                raise InvalidRequestError(
                    f"第 {index + 1} 条消息缺少 role / name / content"
                    "（记忆服务要求每条都标明是谁说的）"
                )
        if not session_id.strip():
            raise InvalidRequestError("缺少参数：session_id（记忆要靠它回溯来源对话）")

        payload = self._post(
            "auto_memory", {"messages": messages, "session_id": session_id}
        )
        meta = payload.get("metadata") if isinstance(payload, dict) else None
        meta = meta if isinstance(meta, dict) else {}
        return {
            "created": bool(meta.get("created")),
            "modified": bool(meta.get("modified")),
            # `answer` 是它给人类读的一句话（"记下了什么"），直接透出给日志与界面
            "summary": str(payload.get("answer") or "")[:300]
            if isinstance(payload, dict)
            else "",
            "path": str(meta.get("path") or ""),
            "messages": int(meta.get("n_messages") or 0),
        }

    # ------------------------------------------------------------------ 记住

    def remember(
        self, content: str, *, tags: list[str] | None = None, user_id: str | None = None
    ) -> dict[str, Any]:
        """把一条长期事实写进 ``MEMORY.md``。

        **按 QwenPaw/ReMe 的约定做合并去重**：它们在 MEMORY.md 的说明里明确
        "更新前先读取现有内容，保留用户或其他会话写入的有效信息，并合并去重"。
        不这么做的话，同一件事会被记很多遍，而记忆越长越不像记忆、越像日志。

        返回 ``added`` 让调用方知道是真写进去了还是本来就有——模型据此不必重复记。
        """
        self._require_enabled()
        text = " ".join(content.split()).strip()
        if not text:
            raise InvalidRequestError("缺少参数：content")
        if len(text) > MAX_ENTRY_CHARS:
            # 一条记忆该是一句可复用的事实，不是一篇文档。超长的应该存成笔记
            # （notes + 知识库那条路），否则 MEMORY.md 会被一篇长文撑爆，
            # 而它每轮都要注入上下文。
            raise InvalidRequestError(
                f"一条记忆最多 {MAX_ENTRY_CHARS} 字（收到 {len(text)} 字）。"
                "更长的内容请用笔记：存成笔记再决定要不要加入知识库"
            )

        tag_text = "".join(f" #{tag.strip()}" for tag in (tags or []) if tag.strip())
        line = f"- {text}{tag_text}"

        entries = self._read_entries(user_id)
        if any(_normalize(item) == _normalize(line) for item in entries):
            return {
                "saved": False,
                "reason": "这条记忆已经存在，未重复写入",
                "entries": len(entries),
            }

        entries.append(line)
        self._write_entries(entries, user_id)
        return {"saved": True, "entries": len(entries)}

    def enqueue_capture(
        self,
        messages: list[dict[str, str]],
        *,
        session_id: str,
        turn_count: int,
        user_id: str | None = None,
    ) -> bool:
        """按节流规则把一次沉淀排进队列；返回**是否真的入了队**。

        为什么必须有节流：ReMe 的设计是"每累计 5 个用户回合触发一次"，
        **但它的服务不管累计**（每次调用就是一次 LLM 调用）。每轮都沉淀
        等于每轮多花一次模型调用，而省 token 是这个项目反复强调的事。

        为什么放在服务层而不是调用方：它是"记忆怎么工作"的一部分。
        调用方只该提供"这是第几轮"，不该知道"每几轮一次"这个规则——
        规则散到调用方，界面入口和自动化入口就会各有一个阈值。

        节流不通过时**返回 False 而不是报错**：这不是失败，是设计如此。
        """
        if not self.enabled or self._stores is None:
            return False
        every = self._runtime.get_int("memory.capture_every") or DEFAULT_CAPTURE_EVERY
        every = max(1, every)
        if turn_count <= 0 or turn_count % every != 0:
            return False

        self._stores.meta.enqueue_task(
            TaskRecord(
                id=f"task_{uuid.uuid4().hex[:12]}",
                kind=TaskKind.MEMORY,
                state=TaskState.PENDING,
                payload={
                    "messages": messages,
                    "session_id": session_id,
                    # 捕获是**异步**的（走队列），所以"落到谁的记忆里"必须随任务带走：
                    # worker 那边没有调用者上下文，事后也无从推断。
                    "user_id": user_id or "",
                },
            )
        )
        return True

    # ------------------------------------------------------------------ 文件
    #
    # 三期的浏览/编辑走**本地目录**（理由见 services/memory_files.py 的模块头）：
    # 这几个方法**不要求 ``memory.enabled``**——记忆关着的时候，用户依然该能打开
    # 自己的记忆文件看看写了什么、把不对的改掉。要求"先起一个服务才能读自己的文本
    # 文件"是没道理的。真正需要服务活着的只有召回与索引（``recall`` / ``reindex``）。

    def files(self, user_id: str | None = None) -> list[MemoryFile]:
        """列出这个账号工作区里的记忆文件（分类、摘要、出链、是否已整合）。"""
        return memory_files.scan(self.workspace_for(user_id))

    @property
    def scan_limit(self) -> int:
        """一次最多列多少个文件。界面要拿它判断"列表是不是被截断了"——
        截断了却不说，用户会以为"我的文件丢了"。"""
        return memory_files.MAX_LISTED_FILES

    def describe(self, path: str, user_id: str | None = None) -> MemoryFile:
        """单个文件的元信息（不含正文）。见 ``memory_files.describe``。"""
        return memory_files.describe(self.workspace_for(user_id), path)

    def file_text(self, path: str, user_id: str | None = None) -> MemoryFileDetail:
        """读一个文件的原文（含 frontmatter，供编辑器逐字还原）。"""
        return memory_files.read_file(self.workspace_for(user_id), path)

    def write_file(self, path: str, content: str, user_id: str | None = None) -> MemoryFileDetail:
        """写一个文件。

        **故意不在这里调 ``reindex``**：ReMe 自己有一组后台守护
        （``index_update_loop``，``watch_dirs: [daily_dir, digest_dir]``、
        ``force_polling`` + 5 秒 debounce），编辑会被它自动吃掉；
        而 ``reindex`` 的说明是 *without rescanning workspace files*——
        它只重建"已入库分片"的索引，**看不见刚新建的文件**。所以每次保存后调它
        既是多余的、又解决不了新文件的问题。要手动兜底时用 ``reindex``（界面上是
        那个按钮），而不是在保存路径上假装做了点什么。
        """
        return memory_files.write_file(self.workspace_for(user_id), path, content)

    def delete_file(self, path: str, user_id: str | None = None) -> None:
        """删一个文件。索引同上：交给 ReMe 的守护去追。"""
        memory_files.delete_file(self.workspace_for(user_id), path)

    def graph(self, user_id: str | None = None) -> MemoryGraph:
        """wikilink 图谱（本地算，见 ``memory_files.graph_of`` 的说明）。"""
        return memory_files.graph_of(self.files(user_id))

    def reindex(self, user_id: str | None = None) -> str:
        """请记忆服务重建索引，返回它给的一句话。

        这是**手动兜底**，不是保存流程的一环：守护进程只在服务活着的时候看文件，
        所以"服务没起时改了一批文件、后来才起"这类情况下索引可能是旧的
        （它启动时有 ``init_changes_step`` 做一次差量，但没覆盖到的就得手动来）。
        ``scope`` 默认 ``all``（它自己的默认值），我们不传。
        """
        self._require_enabled()
        self._require_scope_served(user_id)
        return _brief(self._post("reindex", {}))

    # ------------------------------------------------------ 核心记忆的条目

    def _read_entries(self, user_id: str | None = None) -> list[str]:
        """读回「核心长期记忆」那一节里的条目（保持顺序与原文）。"""
        try:
            body = self.core_file_for(user_id).read_text(encoding="utf-8")
        except OSError:
            return []
        lines: list[str] = []
        inside = False
        for raw in body.splitlines():
            if raw.startswith("## "):
                inside = raw.strip() == "## 核心长期记忆"
                continue
            if inside and raw.strip().startswith("- "):
                lines.append(raw.strip())
        return lines

    def _write_entries(self, entries: list[str], user_id: str | None = None) -> None:
        """整份重写。

        **只重建「核心长期记忆」那一节**：其余小节（工具设置、重要决策与经验）
        原样保留——它们可能有人手写的内容，重写整份文件会把它们抹掉。

        **那一节里的散文也保留**（模板上半段那段"记什么、别记什么"的说明就是散文）：
        只替换 `- ` 开头的条目行。不这么做的话，第一条记忆落盘时那几句说明
        会被静默删掉——而它教的正是"不要记密码/令牌"这类**事后没人会重新发现**的规矩。
        """
        try:
            body = self.core_file_for(user_id).read_text(encoding="utf-8")
        except OSError:
            body = _TEMPLATE.format(entries="")

        block = "\n".join(entries)
        if "## 核心长期记忆" in body:
            head, _, rest = body.partition("## 核心长期记忆")
            # 找到该节之后的下一个二级标题，中间那一块整体重建
            marker = "\n## "
            index = rest.find(marker)
            tail_after = rest[index:] if index >= 0 else ""
            region = rest[:index] if index >= 0 else rest
            prose = [line for line in region.splitlines() if not line.strip().startswith("- ")]
            keep = "\n".join(prose).strip()
            middle = f"{keep}\n\n{block}\n" if keep else f"{block}\n"
            body = f"{head}## 核心长期记忆\n\n{middle}{tail_after}"
            if not rest[1:].startswith("\n"):
                body = f"{head}## 核心长期记忆\n\n{middle}"
        else:
            body = body.rstrip() + f"\n\n## 核心长期记忆\n\n{block}\n"

        space = self.workspace_for(user_id)
        space.mkdir(parents=True, exist_ok=True)
        # 按字节写：`write_text` 在 Windows 上会把换行改成 CRLF，
        # 每次 remember 都把整份文件的换行翻一遍（与 seed_persona 同一处坑）
        self.core_file_for(user_id).write_bytes(body.encode("utf-8"))

    # ------------------------------------------------------------------ HTTP

    def _post(self, job: str, payload: dict[str, Any]) -> Any:
        """调记忆服务的一个 job。

        **接口面**：ReMe 的 ``http_service.py`` 里写的是
        ``self.service.post(f"/{job.name}", ...)``——也就是"每个 job 就是
        ``POST /<job 名>`` + JSON 请求体"（见设计文档 §3.1）。所以这里不需要
        一张路由表，job 名直接拼路径。
        """
        if not self.base_url:
            raise InvalidRequestError("没有配置记忆服务地址（设置 → 长期记忆）")
        url = f"{self.base_url}/{job}"
        try:
            response = httpx.post(url, json=payload, timeout=_TIMEOUT_SECONDS)
        except httpx.HTTPError as exc:
            raise UpstreamError(f"连不上记忆服务 {url}：{exc}") from exc
        if response.status_code >= 400:
            raise UpstreamError(
                f"记忆服务返回 {response.status_code}：{response.text[:200]}"
            )
        try:
            return response.json()
        except ValueError as exc:
            raise UpstreamError("记忆服务返回的不是 JSON") from exc


# --------------------------------------------------------------------- 解析


def _brief(payload: Any) -> str:
    text = str(payload)
    return text[:120]


def _normalize(line: str) -> str:
    """比"是不是同一条"时用的规范化形式：去掉标签与空白差异。

    只删标签（``#xxx``）不删正文——正文不同就是两条记忆，不该被当成重复。
    """
    body = line.lstrip("- ").split(" #")[0]
    return " ".join(body.split()).lower()


def _hits_of(payload: Any) -> list[MemoryHit]:
    """从记忆服务的返回里取出片段。

    **真实形状**（实测得出，见设计文档 §3.2）::

        {"answer": "…给人读的文本…", "success": true,
         "metadata": {"results": [{"id","text","path","start_line","end_line",
                                   "scores": {"keyword": 2.72, "score": 2.72}}],
                      "link_expansion": {…}}}

    注意分数在 ``scores.score`` 里（不是顶层 ``score``），
    而结果列表在 ``metadata.results`` 里——这两个位置第一版都猜错了，
    是靠**真跑一遍服务**才纠正的（原先的容错解析会直接报"认不出结构"）。
    容错仍然保留：字段名多认几种，版本升级时不至于立刻断，
    但"整个返回都不认识"要报错而不是返回空。
    """
    body = _unwrap(payload)

    items: list[Any] = []
    found_list = False
    if isinstance(body, list):
        items = body
        found_list = True
    elif isinstance(body, dict):
        for key in ("results", "hits", "chunks", "items", "memories"):
            candidate = body.get(key)
            if isinstance(candidate, list):
                items = candidate
                found_list = True
                break

    hits: list[MemoryHit] = []
    for item in items:
        if isinstance(item, str):
            if item.strip():
                hits.append(MemoryHit(text=item.strip()))
            continue
        if not isinstance(item, dict):
            continue
        text = ""
        for key in ("text", "content", "snippet", "chunk", "body"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                text = value.strip()
                break
        if not text:
            continue
        path = ""
        for key in ("path", "file", "file_path", "source"):
            value = item.get(key)
            if isinstance(value, str):
                path = value
                break
        hits.append(
            MemoryHit(
                text=text,
                path=path,
                start_line=_int_or_none(item.get("start_line")),
                end_line=_int_or_none(item.get("end_line")),
                score=_score_of(item),
            )
        )

    if hits:
        return hits
    if items:
        raise UpstreamError(
            "记忆服务返回了内容，但没有认出其中的片段字段；"
            f"可能是它的响应格式变了（原始返回前 200 字：{_brief(payload)}）"
        )
    if not found_list and payload:
        raise UpstreamError(
            "记忆服务的返回结构与预期不符（找不到结果列表）；"
            f"原始返回前 200 字：{_brief(payload)}"
        )
    # 认出来了、而且是空的 = 真的没有相关记忆。这才是该返回空的情况。
    return []


def _links_of(payload: Any) -> list[MemoryLink]:
    """命中片段的邻接边（ReMe 的 ``metadata.link_expansion``）。

    结构是 ``{命中路径: {"outlinks": [{"path","meta":{"name"}}], "inlinks": [...]}}``。
    它是**免费附带的**：ReMe 在同一个响应里给了图谱，我们不额外花一次检索就能让
    模型"顺着链接走"。取不出来时返回空列表——图谱缺失不该让一次召回失败，
    片段本身已经够用了。
    """
    body = _unwrap(payload)
    if not isinstance(body, dict):
        return []
    expansion = body.get("link_expansion")
    if not isinstance(expansion, dict):
        return []

    links: list[MemoryLink] = []
    for _source, sides in expansion.items():
        if not isinstance(sides, dict):
            continue
        for key, direction in (("outlinks", "out"), ("inlinks", "in")):
            for edge in sides.get(key) or []:
                if not isinstance(edge, dict):
                    continue
                path = edge.get("path")
                if not isinstance(path, str) or not path:
                    continue
                meta = edge.get("meta") if isinstance(edge.get("meta"), dict) else {}
                name = meta.get("name")
                links.append(
                    MemoryLink(
                        path=path,
                        direction=direction,
                        name=name if isinstance(name, str) else "",
                    )
                )
    return links


def _unwrap(payload: Any) -> Any:
    """逐层剥开外层信封。

    ``metadata`` 是 ReMe 的实际信封（实测），其余几个是容错：它的版本之间
    换过字段名，多认几个不至于一升级就"召回到零条"。
    """
    body = payload
    for key in ("metadata", "data", "result", "payload"):
        if isinstance(body, dict) and isinstance(body.get(key), (dict, list)):
            body = body[key]
            break
    return body


def _int_or_none(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) else None


def _score_of(item: dict[str, Any]) -> float | None:
    """分数在 ``scores.score``（融合后的分）里；也认顶层 ``score``。"""
    scores = item.get("scores")
    if isinstance(scores, dict):
        for key in ("score", "rrf", "vector", "keyword"):
            value = scores.get(key)
            if isinstance(value, (int, float)):
                return float(value)
    for key in ("score", "rrf_score", "relevance"):
        value = item.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None
