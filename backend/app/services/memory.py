"""长期记忆（v0.14，设计见 ``docs/设计/记忆层设计-v0.1.md``）。

**两个池子不能混**（这是本模块存在的第一条理由）：记忆是"你说的"（无出处、可改、
高频写），文档知识库是"文献说的"（有出处、不该被改、原文为王）。混进同一次检索，
引用会脏、溯源会断。所以记忆召回是独立的一路（MCP 上是 `recall`，与 `search` 分开），
结果永不合并——而且**两条路连索引都不共用**：文档走 pgvector + 全文，
记忆走 `memory_files.search` 对本工作区 Markdown 的一次扫描。

**记忆在我们自己的进程里**（v0.46 起）。原先这一层是 ReMe 的 HTTP 门面
（`base_url` + `POST /search`、`/auto_memory`、`/health_check`），得先有第二个进程
活着——而它并进同一个进程又做不到：`reme-ai[as]` 会带来 agentscope，后者钉
`mcp<2.0.0`，与我们的 `mcp>=2` 互斥（实测见设计文档 §3.5）。于是三件事都改成 native：

- ``recall`` → :func:`memory_files.search`（本地按块打分，带文件与行号）；
- ``capture`` → 我们自己的捕获：让对话模型挑出值得长期留下的条目，
  去重后追加到当天的 ``daily/`` 文件（**沿用队列与重试语义**，见 ``enqueue_capture``）；
- ``status`` → 纯本地状态（几份文件、可召回几条、上次更新时间），**不探测任何东西**。

**哪些没做**（如实写在这里，也写在设计文档 §3.5）：ReMe 的 Auto-Dream 四动作整理
（CREATE/CORROBORATE/REFINE/CORRECT）这一轮不做，所以记忆**只增不并**——
daily 里的条目不会被自动折叠进 ``digest/``；它的 BM25 质量也不追求（我们只做
词面命中 + 标题加权，规模上够用，见 ``memory_files.search``）。

**关着时一律明确报错，不返回空**：返回空会让模型以为"没有相关记忆"，
然后基于错误前提继续推理——那是比报错更坏的一种失败。（**开着时**返回空才是
真的"没有相关记忆"：那时检索确实在本地跑过了。）
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from app.core.exceptions import InvalidRequestError
from app.models.enums import TaskKind, TaskState
from app.services import memory_files
from app.services.llm import ChatMessage, OpenAICompatChat
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
#: （QwenPaw 让它去看 `SKILL.md` 文件，我们是**目录进提示词 + `read_skill` 读正文**）。
#: 技能与工具的名字写成真实工具名——描述里给一个不存在的能力，模型只会去试、然后失败。
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

- 技能（SOP）的**目录已经在你的系统提示词里**（名字 + 何时用 + 路径）：
  **不知道某类事该怎么做时先看一眼那份目录**，要用哪条就 `read_skill` 读它的正文。
  （v0.43 起目录每轮都注入，所以不必先 `list_skills`——那是给"想看全部字段"用的。）
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
#: 服务层不另立一个默认值：默认条数只在文件层定一次（少一处会对不上的数）。
DEFAULT_RECALL = memory_files.DEFAULT_RECALL

#: 捕获节流的默认值：每几个用户回合沉淀一次。
#: 5 是 ReMe/QwenPaw 的默认（见设计文档 §2.4），这里保持一致——
#: 换成别的数没有依据，而它有：那条默认值来自它们的实际使用经验。
#: **理由现在更硬了**：一次捕获就是一次模型调用，而省 token 是这个项目反复强调的事。
DEFAULT_CAPTURE_EVERY = 5

#: 一条记忆的字数上限。**协议层与这里同源**（``api/v1/schemas.py`` 的
#: ``MemoryRememberIn`` 直接引这个常量）：写死两份的话，界面会先放行再被服务层拒，
#: 用户看到的是一句"请求不合法"，而不是"这条太长了，请存成笔记"。
MAX_ENTRY_CHARS = 500

#: 一次捕获最多写几条。一轮对话能沉淀出的"长期事实"通常一到两条，
#: 5 是护栏：模型偶尔会把整段对话拆成十条"事实"，而记忆不是流水账。
MAX_CAPTURED_ITEMS = 5

#: 送进捕获提示词的"已经记过的条目"条数上限（取最近的这些条）。
#: 不设上限的话，这个提示词会随着记忆增长越来越贵——而它每次捕获都要发一遍。
KNOWN_ENTRIES_IN_PROMPT = 60

#: 单条消息送进捕获提示词的字数上限。一轮对话里助手的回答可能很长，
#: 但"值得长期记"的决定与结论通常首尾都有，所以取头也取尾（见 ``_transcript``）。
CAPTURE_MESSAGE_CHARS = 2000

#: 去重判据：去掉空白与标点后的**字符二元组重合度**下限（Jaccard）。
#:
#: 阈值定得偏高（0.7）是**故意偏保守**：漏过一条改写（写重了一条记忆）是看得见的，
#: 用户扫一眼文件就能删；而误判"新事实与旧条目是同一件事"会静默丢掉一条真事实。
#: 两者不对等，所以宁可少拦。另外两条更硬的判据在 ``_similar`` 里：
#: 指纹相同（只差标点空白），以及"短的那条是长的那条的整段、且只多出几个字"。
DUP_SIMILARITY = 0.7

#: 包含关系算重复时，长的那条最多能比短的多几个字（见 ``_similar``）。
#:
#: **为什么要有个数**：没有它，"设备名是 nas"与"设备名是 nas，地址是 192.168.1.10"
#: 会被判成重复，而后者多出来的地址就**永远不落盘**了——这一轮没有整理机制
#: （Auto-Dream 不做），我们没法把新信息并进旧条目，所以拦下来等于丢信息。
#: 只差几个字的才是"同一句话的标点级改写"，那才该拦。
CONTAINMENT_SLACK = 6

#: 指纹用：去重比对前把空白与标点抹掉（只留字与数字）。
#: ``\w`` 在 Python 3 里按 Unicode 匹配，汉字也算字，所以中文不受影响。
_NON_WORD = re.compile(r"[\W_]+", re.UNICODE)
#: 数字串（判"数字变了 = 不是同一件事"用，见 ``_similar``）。
_DIGIT_RUN = re.compile(r"\d+")
#: 模型输出里认得出是"一条"的行：项目符号或编号开头。
_ENTRY_LINE = re.compile(r"^\s*(?:[-*+•]|\d+[.、)])\s*")
#: 代码围栏（模型爱把输出包起来）。
_FENCE = re.compile(r"^\s*```")

#: 捕获用的系统提示词。**留的是 ReMe/QwenPaw 那份"什么值得记"的清单**
#: （设计文档 §2.4 抄下来的那几条），因为那是这一层最见功力的地方：
#: 写"识别以后仍可能有用的事"，模型就会把整轮对话都抄下来。
#:
#: 最后两条是安全与卫生，且必须写在提示词里：**敏感信息不进记忆**是
#: MEMORY.md 模板里就有的约定，而这里是我们唯一会"自动写入"的入口。
_CAPTURE_SYSTEM = (
    "你在把一轮对话里**值得长期留下的事**挑出来，写进这个人的长期记忆。\n"
    "值得记的：稳定的偏好与工作方式、项目背景与长期约束、已经确认的决定（连同原因）、"
    "当前进展与阻塞、可复用的做法。\n"
    "不值得记的：一次性的问答内容、从资料里查到的知识（那是知识库的事）、"
    "寒暄与客套、与已有条目重复的内容。\n"
    "**绝不记录密码、令牌、密钥、证件号这类敏感信息**，哪怕对话里提到了。\n"
    "输出格式：每条一行，以「- 」开头，一句话说清一件事（不超过 60 字）；"
    "没有值得记的就**什么也不要输出**，不要写「没有」这类说明。"
)

#: 新建当日现场文件时的骨架。日期**用本地日期**而不是 UTC：这是给人看的
#: "今天的现场"，而人的日期感是本地时间（用 UTC 会让东八区早上 8 点前的
#: 对话记到"昨天"）。
_DAILY_TEMPLATE = """---
summary: "{date} 的现场记忆（对话里自动沉淀下来的条目）"
---

# {date}

{entries}
"""


@dataclass(frozen=True, slots=True)
class MemoryStatus:
    """记忆层的当前状态，给界面用。

    **没有任何"连通性"字段**（v0.46 起）：记忆是我们自己进程内的一路检索，
    没有第二个进程可连，也就没有"连不上"这种状态。原先那个三态 ``reachable``
    （``None`` = 没探过）是给探测端点用的，随 ReMe 一起删了。
    """

    enabled: bool
    workspace: str
    core_file_exists: bool
    file_count: int = 0
    """工作区里的记忆文件份数。"""

    retrievable_count: int = 0
    """其中进入召回池的份数（``daily/`` 与 ``digest/``）。"""

    entry_count: int = 0
    """可召回的**条数**：召回池那些文件切出来的块数（与召回同源，见 ``memory_files.stats``）。"""

    last_changed_at: str = ""
    """记忆内容最后一次改动的时间（ISO，UTC）。没有索引也就没有"索引时间"，
    这里的含义就是"上次更新"。"""

    detail: str = ""


#: 召回结果的记录类型**直接用文件层那一个**：片段与出处本来就是在那里算出来的，
#: 服务层只转发——再拷一层就多一处"字段对不上"的机会。
MemoryHit = memory_files.MemoryMatch


@dataclass(frozen=True, slots=True)
class MemoryLink:
    """命中文档的邻接边（wikilink 图谱）。``direction`` 是 ``out`` / ``in``。"""

    path: str
    direction: str
    name: str = ""


class MemoryService:
    """记忆的实现。**全在本地**：读写的都是 ``data/memory/`` 下的 Markdown。

    唯一会出网的动作是**捕获时问一次对话模型**（``capture``）——那不是"记忆服务"，
    而是我们自己的模型通道，模型没配好时它明确报错（见 ``_ask_model``）。
    """

    def __init__(
        self,
        runtime: RuntimeConfigService,
        data_dir: Path,
        *,
        stores: StoreBundle | None = None,
        ask: Callable[[list[ChatMessage]], str] | None = None,
    ) -> None:
        self._runtime = runtime
        self._data_dir = data_dir
        #: 存储（可选）：**只有入队捕获任务时才需要**。不给它也能用——
        #: recall / remember / 注入都不碰数据库，测试与脚本因此可以轻量构造。
        self._stores = stores
        #: 问模型的能力（可选）：不给就用运行期配置里绑定的对话模型（见 ``_ask_model``）。
        #: 测试注入它来跑"捕获"这条链路，不必真连一个模型。
        self._ask = ask

    # ------------------------------------------------------------------ 配置

    @property
    def enabled(self) -> bool:
        return self._runtime.get_bool("memory.enabled")

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

        **native 之后这条隔离是精确的**：召回只扫"这个账号自己的目录"，
        不存在"一个记忆服务只能盯一份工作区"那种进程级限制
        （原先 ``memory.service_scope`` 就是为了如实说明那件事，随 ReMe 一起删了）。
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

    def _require_enabled(self) -> None:
        """召回与自动沉淀的那道闸。

        报错文案里**不提任何服务**（v0.46）：本地实现没有"要去把某个进程拉起来"
        这回事，能做的动作只有一件——去设置里打开它。
        """
        if not self.enabled:
            raise InvalidRequestError(
                "未启用长期记忆。请在「设置 → 长期记忆」里打开（在记忆页可以直接打开）"
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
        """把缺的人设/记忆文件补上模板，返回**这次新建了哪几个**。

        为什么要落成文件而不是只存在代码里：这几份东西的价值恰恰在于**用户能改**——
        人格、对方是谁、这类活怎么干、什么值得长期留下，都是他比我清楚的事。
        文件是唯一一种"他能看见、能编辑、还能用 git 管版本"的形态
        （QwenPaw 也是这么做的）。

        **只补缺的，绝不覆盖已存在的**：那可能已经是用户写了几天的东西。
        唯一的例外是"还是我们当初写的那份、一个字没动过"的旧模板，
        见 :meth:`_upgrade_untouched_template`。

        ``MEMORY.md`` 也在这四份里（v0.1.1）：它原先只在第一次 ``remember`` 时
        才被写出来，于是新部署的「记忆」页上看不到它、也没法先去编辑它——
        而它恰恰是这一层最该被用户看见的那份文件（容器里尤其明显：
        新实例还没对话过，页面就该有东西可看）。写它用的是 ``_TEMPLATE`` 的
        空条目版本，与 ``_write_entries`` 在"文件不存在"时的兜底**逐字一致**，
        所以第一条记忆落盘时不会因为"文件长什么样"而走另一条分支。
        """
        created: list[str] = []
        for name, template in (
            (SOUL_FILE, _SOUL_TEMPLATE),
            (PROFILE_FILE, _PROFILE_TEMPLATE),
            (AGENTS_FILE, _AGENTS_TEMPLATE),
            (CORE_MEMORY_FILE, _TEMPLATE.format(entries="")),
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

    def status(self, user_id: str | None = None) -> MemoryStatus:
        """当前状态：**数一遍工作区，不连任何东西**。

        为什么连计数都在这里算（而不是让界面 filter）：这些数字的含义都压在
        "召回池是哪几个目录""什么算一条"这些判断上，而它们只在这一层知道。
        界面只该显示数字。

        成本：一次目录遍历 + 读召回池那几个文件。这是"个人长期记忆"的量级
        （几份到几百份、几百 KB），所以不另做缓存——不缓存就没有"缓存过期"
        这个新问题。
        """
        space = self.workspace_for(user_id)
        stats = memory_files.stats(space)
        return MemoryStatus(
            enabled=self.enabled,
            workspace=str(space),
            core_file_exists=self.core_file_for(user_id).exists(),
            file_count=stats.file_count,
            retrievable_count=stats.retrievable_count,
            entry_count=stats.entry_count,
            last_changed_at=stats.last_changed_at,
            detail="" if self.enabled else "未启用：过去的对话不会被召回，也不会自动沉淀",
        )

    # ------------------------------------------------------------------ 召回

    def recall(
        self, query: str, *, limit: int | None = None, user_id: str | None = None
    ) -> tuple[list[MemoryHit], list[MemoryLink]]:
        """在记忆里找回相关片段。**与文档检索是两条路**（见模块头）。

        打分与命中判据都在 ``memory_files.search``（读那一处的说明）。
        顺链给出的邻接边是**免费附带的**：wikilink 就在正文里，
        命中文件一出链就顺出来了，不需要第二次检索。
        """
        self._require_enabled()
        text = query.strip()
        if not text:
            raise InvalidRequestError("缺少参数：query")
        count = max(1, min(int(limit or DEFAULT_RECALL), MAX_RECALL))

        space = self.workspace_for(user_id)
        hits = memory_files.search(space, text, limit=count)
        links = [
            MemoryLink(path=path, direction=direction, name=name)
            for path, direction, name in memory_files.links_of(
                self.files(user_id), [item.path for item in hits]
            )
        ]
        return hits, links

    # ------------------------------------------------------------------ 捕获

    def capture(
        self, messages: list[dict[str, str]], *, session_id: str, user_id: str | None = None
    ) -> dict[str, Any]:
        """把一轮对话沉淀成记忆条目（**我们自己的实现**，v0.46 起）。

        三步：让对话模型挑出"值得长期留下"的条目 → 与工作区里已有的条目去重
        → 追加到**当天的 ``daily/`` 文件**。

        为什么落 daily 而不是 ``MEMORY.md``（设计文档 §1 的两层分工）：
        ``MEMORY.md`` 是那几份**每轮整份注入上下文**的核心文件，自动沉淀直接写进去
        等于机器替人决定"什么该长期占着上下文窗口"；而 daily 是按需召回的现场，
        只增不并。**这一轮没有整理机制**（Auto-Dream 不做），所以 daily 会一直长，
        这一点如实写在设计文档里，不藏着。

        去重有两道：提示词里把那句话说出来（模型自己先别重复），以及
        机械比对（``_similar``）兜底——模型并不总是听话。

        失败一律抛出去：它跑在队列上（``TaskKind.MEMORY``），由 worker 按重试语义
        处置；在这里吞掉的话，"记忆开着却什么都没记住"会变成一个查不出原因的现象。
        """
        self._require_enabled()
        if not messages:
            raise InvalidRequestError("没有可沉淀的消息")
        for index, item in enumerate(messages):
            if not (item.get("role") and item.get("content")):
                raise InvalidRequestError(f"第 {index + 1} 条消息缺少 role / content")
        if not session_id.strip():
            raise InvalidRequestError("缺少参数：session_id（记忆要靠它回溯来源对话）")

        space = self.workspace_for(user_id)
        known = memory_files.entry_texts(space)
        raw = self._ask_model(_capture_prompt(messages, known))
        fresh = _select_new(raw, known)
        if not fresh:
            # 没有值得记的**也是一次正常结果**（ReMe 那边同样不产生空记忆）：
            # 返回 created=false 而不是报错，调用方据此不必报告"记下了"。
            return {
                "created": False,
                "path": "",
                "entries": [],
                "summary": "这一轮没有值得新记的内容",
                "messages": len(messages),
            }

        path = self._append_daily(space, fresh, session_id=session_id)
        return {
            "created": True,
            "path": path,
            "entries": fresh,
            "summary": f"记下了 {len(fresh)} 条：" + "；".join(fresh)[:200],
            "messages": len(messages),
        }

    def _ask_model(self, messages: list[ChatMessage]) -> str:
        """问一次对话模型。

        用的是运行期配置里**绑定给「对话生成」的那个模型**（与对话同一条模型通道），
        而不是另配一套：记忆沉淀是对话的副产品，没有理由让它用别的模型。
        没绑定时报可读错误（同 ``ChatService`` 的口径），由队列去重试。
        """
        if self._ask is not None:
            return self._ask(messages)
        config = self._runtime.llm()
        if not config.is_configured:
            raise InvalidRequestError(
                "没有配置对话模型，记忆沉淀需要一个能用的对话模型（设置 → 模型）"
            )
        return OpenAICompatChat(config).complete(messages)

    def _append_daily(self, space: Path, entries: list[str], *, session_id: str) -> str:
        """把条目追加到当天的现场文件，返回它的相对路径。

        **两个纪律**：

        - 落到谁的目录由调用方给（``space``），文件里不留任何跨账号信息；
        - 来源会话写成一行 HTML 注释（``<!-- 来源会话 conv_x -->``）：
          渲染出来看不见（不打扰正文），又能回答"这条是哪次对话来的"。
          不写成 wikilink——那会连到不存在的文件上，把图谱的悬空链接数弄脏。
        """
        day = datetime.now().strftime("%Y-%m-%d")
        target = space / "daily" / f"{day}.md"
        block = "\n".join(f"- {entry}" for entry in entries)
        note = f"<!-- 来源会话 {session_id} -->"
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                body = target.read_bytes().decode("utf-8", errors="replace").rstrip("\n")
                content = f"{body}\n{block}\n{note}\n"
            else:
                content = _DAILY_TEMPLATE.format(date=day, entries=f"{block}\n{note}")
            # 按字节写：``write_text`` 在 Windows 上把 ``\n`` 翻成 ``\r\n``
            # （与 memory_files 同一处坑），而这份文件用户也会用别的编辑器改
            target.write_bytes(content.encode("utf-8"))
        except OSError as exc:
            raise InvalidRequestError(f"写不了当天的记忆文件：{exc}") from exc
        return f"daily/{day}.md"

    # ------------------------------------------------------------------ 记住

    def remember(
        self, content: str, *, tags: list[str] | None = None, user_id: str | None = None
    ) -> dict[str, Any]:
        """把一条长期事实写进 ``MEMORY.md``。

        **合并去重**是这个文件的约定（QwenPaw/ReMe 那份说明里写着"更新前先读一遍
        现有内容，保留别人写进来的有效信息，并合并去重"）：不这么做的话，
        同一件事会被记很多遍，而记忆越长越不像记忆、越像日志。

        返回 ``added`` 让调用方知道是真写进去了还是本来就有——模型据此不必重复记。

        **不看 ``memory.enabled`` 那道闸**（v0.22 起，与那四份人设文件同一理由）：
        它写的是 ``MEMORY.md``，而那份文件由我们直接读写、并且**无论开关如何都会注入
        提示词**——也就是说写进去立即就有效。闸管的是另一半：过去的对话会不会被
        召回（``recall``）、会不会自动沉淀（``capture``）。
        """
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

        为什么必须有节流：一次捕获就是**一次模型调用**（见 ``capture``），
        每轮都沉淀等于每轮多花一次调用，而省 token 是这个项目反复强调的事。
        节流值默认 5（``DEFAULT_CAPTURE_EVERY``，与 ReMe/QwenPaw 的默认一致）。

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
    # 浏览/编辑走**本地目录**：这几个方法**不要求 ``memory.enabled``**——
    # 记忆关着的时候，用户依然该能打开自己的记忆文件看看写了什么、把不对的改掉。
    # 要求"先打开一个开关才能读自己的文本文件"是没道理的。

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

        **保存路径上什么都不做**（v0.46 之后连"什么都不做"都不必解释了）：
        召回是每次按需扫工作区，改完下一句问话就能搜到——原先这里要交代
        ReMe 的文件守护会不会跟上、``reindex`` 为什么是白调（见设计文档 §3.3），
        那类问题随第二个进程一起消失了。
        """
        return memory_files.write_file(self.workspace_for(user_id), path, content)

    def delete_file(self, path: str, user_id: str | None = None) -> None:
        """删一个文件。索引同上：没有索引要追。"""
        memory_files.delete_file(self.workspace_for(user_id), path)

    def graph(self, user_id: str | None = None) -> MemoryGraph:
        """wikilink 图谱（本地算，见 ``memory_files.graph_of`` 的说明）。"""
        return memory_files.graph_of(self.files(user_id))

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


# --------------------------------------------------------------- 捕获的纯函数
#
# 下面这些都是纯的（输入 → 输出，不碰文件、不连模型），所以"模型输出怎么解析"
# 与"什么算重复"这两件最容易出错的事可以单独测。


def _capture_prompt(messages: list[dict[str, str]], known: list[str]) -> list[ChatMessage]:
    """拼捕获用的两条消息。

    **把已有的条目给模型看一份**（只给最近的 ``KNOWN_ENTRIES_IN_PROMPT`` 条）：
    这是我们能做的最省的去重——让模型自己就别重复。全给不行：条目会一直长，
    那这个提示词会越来越贵，而它每次捕获都要发一遍。机械去重仍然兜底（``_select_new``）。

    ``name`` 可选：缺省按 role 说"用户／助手"。原先它是**必须**的，
    因为 ReMe 收的是 agentscope 的 ``Msg``、缺 ``name`` 会被它自己的校验拒掉；
    那个校验随 ReMe 一起没了，我们只需要"谁说的"——``role`` 已经给了。
    """
    transcript = "\n".join(
        f"{item.get('name') or ('用户' if item['role'] == 'user' else '助手')}："
        f"{_one_line(item['content'])}"
        for item in messages
    )
    body = f"这一轮的对话：\n\n{transcript}\n"
    if known:
        recent = known[-KNOWN_ENTRIES_IN_PROMPT:]
        listed = "\n".join(f"- {item}" for item in recent)
        body += f"\n已经记过的内容（不要重复）：\n{listed}\n"
    body += "\n请只输出值得新记的条目。"
    return [
        ChatMessage(role="system", content=_CAPTURE_SYSTEM),
        ChatMessage(role="user", content=body),
    ]


def _one_line(text: str) -> str:
    """一条消息压成一段：长回答**掐中间留两头**（结论与决定常常在首尾）。"""
    flat = " ".join((text or "").split())
    if len(flat) <= CAPTURE_MESSAGE_CHARS:
        return flat
    head = CAPTURE_MESSAGE_CHARS * 3 // 5
    tail = CAPTURE_MESSAGE_CHARS - head
    return f"{flat[:head]}……{flat[-tail:]}"


def _select_new(raw: str, known: list[str]) -> list[str]:
    """从模型的输出里取出**值得新写**的条目（解析 + 去重 + 上限）。

    只认**带项目符号或编号的行**：模型偶尔会回一句散文（"这轮没有值得记的"），
    把它当成一条记忆写进去是最坏的结果——而"什么都没解析到"正好等于它的本意。
    """
    fresh: list[str] = []
    for line in (raw or "").splitlines():
        if _FENCE.match(line):
            continue
        if not _ENTRY_LINE.match(line):
            continue
        entry = " ".join(_ENTRY_LINE.sub("", line).split())
        if not entry or len(entry) > MAX_ENTRY_CHARS:
            # 超过上限的丢掉而不是截断：半条记忆比没有更糟（它会被当成完整事实读）
            continue
        if any(_similar(entry, old) for old in known):
            continue
        if any(_similar(entry, other) for other in fresh):
            continue
        fresh.append(entry)
        if len(fresh) >= MAX_CAPTURED_ITEMS:
            break
    return fresh


def _fingerprint(text: str) -> str:
    """去重比对用的指纹：大小写、空白、标点、标签都不参与比较。"""
    return _NON_WORD.sub("", _normalize(text))


def _loose(text: str) -> str:
    """比"包含关系"用的形态：大小写归一、空白压成一个空格，**标点留着**。

    标点在这里是**词边界**：中文没有空格，「用户偏好简短回答，不要长篇大论」
    只有在逗号处才算"补了半句"；把标点也抹掉的指纹做不到这件事。
    """
    return " ".join(_normalize(text).split())


def _contains(shorter: str, longer: str) -> bool:
    """``shorter`` 整段出现在 ``longer`` 里，且**两端都落在词边界上**。

    边界这一条是给 ASCII 词留的：「项目代号叫 kylab」是「项目代号叫 kylab2 代」
    的子串，但那说的是另一个版本，不是同一件事——"kylab" 后面紧跟"2"，
    不算边界。
    """
    start = longer.find(shorter)
    while start >= 0:
        end = start + len(shorter)
        before = longer[start - 1] if start else " "
        after = longer[end] if end < len(longer) else " "
        if not (before.isalnum() or after.isalnum()):
            return True
        start = longer.find(shorter, start + 1)
    return False


def _similar(one: str, other: str) -> bool:
    """两条记忆是不是**同一件事**（见 ``DUP_SIMILARITY`` 那段取舍）。

    三条判据，从硬到软：

    1. **指纹相同**：只差大小写、标点、空白（「设备名是 nas。」与「设备名是nas」）；
    2. **整段包含且只多出几个字**（``CONTAINMENT_SLACK``）：同一句话的标点级改写，
       多出来的那几个字不足以让拦下来变成丢信息；
    3. **字符二元组重合度够高**：接住"换了词的同一句话"与语序调换。

    两条**否决**（先于上面第 2、3 条）：

    - **数字不同就不是同一件事**：版本号、地址、数量、日期都是数字，数字变了
      就是变了（「代号叫 kylab」与「代号叫 kylab2」不能被当成重复）。
      没有这一条，短句上"只差两个字"的相似度天然很高，新版本会被静默丢掉；
    - 其中一条是空的（没有可比的内容）。

    这一层**拦得住**：完全一样、只差标点空白、语序调换、同一句话补几个字、
    数字不变的近似改写。**拦不住**：换了说法的同一件事——实测
    「发布顺序固定为：先跑门禁 → 再打标签 → 最后推镜像。」与
    「发布顺序是门禁、打标签、推镜像」的二元组重合度只有 0.33，判不出来。
    那种情况靠的是**提示词那一侧的纪律**（把已有条目给模型看，让它自己别重复，
    实测有效），以及以后若做了整理机制，由它去合并同类条目。
    机械化地判"两句话说的是不是一回事"要的是语义，不是字面——那正是这一层不做的事。
    """
    first, second = _fingerprint(one), _fingerprint(other)
    if not first or not second:
        return False
    if first == second:
        return True
    if _DIGIT_RUN.findall(first) != _DIGIT_RUN.findall(second):
        return False
    loose_one, loose_two = _loose(one), _loose(other)
    shorter, longer = sorted((loose_one, loose_two), key=len)
    if (
        shorter
        and len(longer) - len(shorter) <= CONTAINMENT_SLACK
        and _contains(shorter, longer)
    ):
        return True
    grams_first = {first[index : index + 2] for index in range(len(first) - 1)}
    grams_second = {second[index : index + 2] for index in range(len(second) - 1)}
    if not grams_first or not grams_second:
        return False
    return len(grams_first & grams_second) / len(grams_first | grams_second) >= DUP_SIMILARITY


def _normalize(line: str) -> str:
    """比"是不是同一条"时用的规范化形式：去掉标签与空白差异。

    只删标签（``#xxx``）不删正文——正文不同就是两条记忆，不该被当成重复。
    """
    body = line.lstrip("- ").split(" #")[0]
    return " ".join(body.split()).lower()


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
