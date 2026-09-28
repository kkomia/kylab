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

**这一层现在**（P0–P3 都落了地）：检索是**两路**——词面（BM25 + 标题加权，
``memory_files.search``）与可选的语义（本地小索引 + RRF 融合，``memory_index``，
默认关见 ``memory.vector_enabled``）；整理是 ``dream`` / ``dream_all``，
写完之后还会补链（``_autolink``）。逐项的取舍与实测散在设计文档 §3.5。

**关着时一律明确报错，不返回空**：返回空会让模型以为"没有相关记忆"，
然后基于错误前提继续推理——那是比报错更坏的一种失败。（**开着时**返回空才是
真的"没有相关记忆"：那时检索确实在本地跑过了。）
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from app.core.exceptions import InvalidRequestError
from app.models.enums import TaskKind, TaskState
from app.services import memory_files, memory_index
from app.services.llm import ChatMessage, OpenAICompatChat
from app.services.memory_files import MemoryFile, MemoryFileDetail, MemoryGraph
from app.services.runtime_config import RuntimeConfigService
from app.storage.base import StoreBundle, TaskRecord

__all__ = [
    "CORE_MEMORY_FILE",
    "MAX_ENTRY_CHARS",
    "MAX_RECALL",
    "SOUL_FILE",
    "WRITABLE_PERSONA_FILES",
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

#: 默认注入的那几份、以及它们的顺序（= 上面那张表的顺序）。
#:
#: **它是可配的**（``memory.persona_files``，v0.51，照 QwenPaw 的
#: ``system_prompt_files``）：那几份文件每轮整份进 system prompt，而"哪几份、
#: 按什么顺序"是用户的设定，不该由代码钉死。
PERSONA_ORDER_DEFAULT = ",".join(name for name, _label in PERSONA_FILES)

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

*了解你在帮的人。边走边更新。**没填的就留空**——别写「待确认」「待补」这类占位词：
它们会被下一轮的你当成"还没做完的事"，于是每次都去追问对方（D26 实测踩过：
那天 17 条新会话里 14 条在问"怎么称呼你"，而问的正是这三行）。*

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
- 值得长期记住的事实用 `remember` 写进 `MEMORY.md` 的「核心长期记忆」一节
  （稳定偏好、长期约定、重要决定这类）；关于「我是谁、对方是谁」的写进
  `PROFILE.md`（整份改写用 `write_memory`，**先 `read_memory` 读一遍**）。
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

#: 一次捕获最多带多少轮对话（用户 + 助手两条算一轮）。
#:
#: **为什么要有上限**：整段 payload 要进 ``tasks`` 表的一行 JSON。一个中间一直
#: 没沉淀的会话（记忆关着、或连续失败）累积几百轮并不稀奇，而"把四百条消息塞进
#: 一行 JSON"是那种平时看不出、出事时很难查的形状。
#: 超出时**从头取**、水位线只推进到真正送出去的那一条：剩下的下一轮接着补，
#: 于是"落后很多"是逐渐追上的，不是静默丢掉的。
CAPTURE_BATCH_TURNS = 20

#: 会话笔记 ``summary`` 的长度上限（模型给的摘要，或用第一条兜底，见 ``_note_summary``）。
#: 它是列表与召回里显示的那一句，太长会把列表撑成一段话。
NOTE_SUMMARY_CHARS = 80

#: 会话笔记 ``title`` 的长度上限（v0.51，模型给的「主题」那行）。
#: 它进 frontmatter 的 ``title``，是**显示名**（``memory_files._title_of`` 优先取它），
#: 所以短一点：它是列表里的一行，不是正文标题。
NOTE_TITLE_CHARS = 40

#: 捕获只认对话的两侧。``ConversationService.append`` 也能写别的 role，
#: 那些不是"谁说了什么"，交给捕获只会污染提示词。
_CAPTURE_ROLES = ("user", "assistant")

#: 捕获水位线在 ``app_settings`` 里的键前缀（**每个会话一行**）。
#:
#: 与 ``document.<id>.original_path`` 那批同一个用法：按实体生成、由写入方
#: **直接**落库，不进运行期配置的已知键集合——进去了就会读到自己写的值被缓存
#: 延迟最多两秒的旧值（见 ``runtime_config`` 关于"哪些键可以缓存"的说明）。
_CAPTURED_KEY = "memory.captured."

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
#: 会被判成重复，而后者多出来的地址就**永远不落盘**了——捕获是"先落盘、后整理"这条
#: 链路的**入口**，在这里拦下来，后面的整理（``dream``）根本没有机会看到它。
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
    "输出格式：**先两行**——「主题：<这份笔记在讲什么，一个短句>」与"
    "「摘要：<一句话，以后靠它认这份笔记>」（这两行**能写就写**）；"
    "**然后**每条一行，以「- 」开头，一句话说清一件事（不超过 60 字）。"
    "没有值得记的就**什么也不要输出**，不要写「没有」这类说明。"
)

#: **整理**（Auto-Dream 的等价物）那一次的提示词。
#:
#: 为什么需要它（照 QwenPaw 的 ``dream/integrate.yaml`` 抄它的机制）：捕获把对话变成
#: **现场**——一天一条、按时间堆着、只增不并。现场越堆越长，而"以后要用的是结论，
#: 不是流水"。整理就是那个把现场沉淀成**按主题归并的长期知识**（``digest/``）的动作。
#:
#: **四类三桶都是照抄 QwenPaw 的**（``digest/{personal,procedure,wiki}`` 与
#: ``CREATE/CORROBORATE/REFINE/CORRECT``），因为那两处的划分经得起用：
#: 三个桶回答"这条是什么"，四个动作回答"拿它怎么办"。
#:
#: **一处刻意的偏离**：QwenPaw 把"挑出值得沉淀的单元"（extract）与"与已有知识整合"
#: （integrate，要带 node_search 召回）拆成两次模型调用，我们**合成一次**——
#: 现有长期知识的**目录**（路径 + 摘要）本来就不大，一次给全，模型自己挑目标。
#: 代价是它不能像 QwenPaw 那样对每个单元宽召回 20–30 条；在当前量级
#: （几份到几百份、几百 KB）目录本身就是那份"宽召回"。
_DREAM_SYSTEM = (
    "你在把一个人的**现场记忆**（每天从对话里沉淀下来的条目）整理成**长期知识**。\n"
    "现场是流水：一条一条按时间堆着。长期知识是**按主题归并**出来的——"
    "以后要用的是后者。\n\n"
    "## 三个类别\n"
    "- personal：偏好、关注范围、长期约定（「他喜欢先看结论」）\n"
    "- procedure：可复用的做法与步骤（「发布前先跑门禁脚本」）\n"
    "- wiki：概念、事实、原则、心智模型（「锂价下跌压低正极材料成本」）\n\n"
    "## 四个动作（每条只能说一个）\n"
    "- CREATE：现有长期知识里没有这一条，新建一条\n"
    "- CORROBORATE：已有那条又出现了一次——补一条来源就行，正文不用改\n"
    "- REFINE：已有那条要补前提、边界、失败模式或步骤\n"
    "- CORRECT：已有那条**错了**（顺序不对、缺关键步骤、结论被推翻）\n\n"
    "## 纪律\n"
    "- **只写以后还会用到的**。一次性的过程、寒暄、已经过时的进展，不要写。\n"
    "- **只写长期知识这一侧**：现场那几份文件一个字都不要动（也不在你的输出里）。\n"
    "- **同一个主题要归到同一条上**：别为它的每次出现都新建一条。要更新已有那条时，"
    "名字就用目录里那个名字。\n"
    "- 名字是**简短的中文短语**（它会被当成文件名）：不要带日期、不要带斜杠。\n"
    "- **绝不记录密码、令牌、密钥、证件号这类敏感信息**，哪怕现场里写着。\n\n"
    "## 输出格式（严格照这个来）\n"
    "每个条目长这样——以「=== 」开头的一行是头部，以单独一行「===」结束。"
    "下面这个块只是**格式示例**：里面的「动作」「类别」「名字」是**占位符**，"
    "不是要你原样输出的字。\n\n"
    "=== 动作｜类别｜名字\n"
    "摘要：一句话说清这条是什么\n"
    "关联：[[另一个主题的名字]]\n"
    "正文：\n"
    "这条的正文，可以多行\n"
    "===\n\n"
    "**只输出条目块**，此外一个字都不要写：不要解释你做了什么、"
    "不要复述这段格式说明、**不要写你的思考过程或自我检查**。\n"
    "「关联」那一行没有就留空。没有值得沉淀的就**什么也不要输出**。"
)

#: 一次整理最多处理几份"变了样的"现场文件（照 QwenPaw 的 ``max_units``）。
#: 超出的留到下一轮——与捕获的水位线同一个取舍：**逐渐追上，而不是一次做完**。
DREAM_MAX_FILES = 5

#: 送进整理提示词的单个现场文件上限（字符）。整理要看的是"这一天里有什么值得沉淀"，
#: 不需要逐字读完一份很长的流水。
DREAM_FILE_CHARS = 3000

#: 三个类别（照 QwenPaw 的 ``digest/{personal,procedure,wiki}``）。
DREAM_BUCKETS: tuple[str, ...] = ("personal", "procedure", "wiki")

#: 类别 → frontmatter 里的 ``kind``（照 QwenPaw 的约定：procedure→procedure、
#: personal→preference、wiki→concept）。它是给以后的检索与界面分类用的。
_DREAM_KINDS = {"personal": "preference", "procedure": "procedure", "wiki": "concept"}

#: 四个动作（照 QwenPaw 的 integrate 提示词）。
DREAM_ACTIONS: tuple[str, ...] = ("CREATE", "CORROBORATE", "REFINE", "CORRECT")

#: 整理水位线在 ``app_settings`` 里的键前缀（**每份工作区一行**）。
_DREAMED_KEY = "memory.dreamed."

#: 文件名里不许出现的字符（类别名与主题名都会进路径）。
_ILLEGAL_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

#: 现场文件在 ``digest/`` 那一侧的落点（照 QwenPaw 的目录名）。
_DIGEST_DIR_NAME = memory_files.DIGEST_DIR

#: **记忆指导**：告诉模型"你有长期记忆、什么样的问题该先去查"。
#:
#: 为什么必须有这一段（照 QwenPaw 的 ``MEMORY_GUIDANCE`` / ``MEMORY_SEARCH_GUIDANCE``
#: 抄，它是这一层最容易被漏掉的一块）：工具表里列着 ``recall``，而内置提示词只在
#: "问的是对方自己的东西（…长期记忆）→ 查这边"那一句里顺带提到它。模型据此完全
#: 可以整场对话一次都不查记忆——用户看到的现象就是「它有记忆，但从不使用」。
#: 把"什么时候先查记忆"单列成一段注入，缺的正是这一段。
#:
#: **三处刻意**：
#: 1. **只在启用时给出**（见 :meth:`MemoryService.guidance`）。关着时 ``recall``
#:    会明确报"未启用长期记忆"，还把它摆给模型看就是"每轮先查一次、再拿一句错误"
#:    ——与知识库那条 ``_KB_TOOLS`` 的教训同一个形状；
#: 2. **目录名从 ``memory_files`` 取**，不在这里写死：改了目录而提示词没跟上，
#:    模型就会去翻一个不存在的地方（这个仓库对"描述一个不存在的机制"零容忍）；
#: 3. **明说 ``recall`` 搜不到那四份核心文件**：它们每轮已经整份注入，再搜一遍
#:    既是白花一次调用，也容易让模型把同一段内容读两遍。
#:    片段可能被截断这件事也如实说——不写的话模型会把截断处当成"就记到这里"。
_GUIDANCE = (
    "【长期记忆：怎么用】\n"
    "- 你有一份长期记忆库：`{daily}/YYYY-MM-DD.md` 是每天从对话里自动沉淀下来的"
    "现场条目，`{digest}/` 是整理后的长期知识。\n"
    "- 问的是「我们之前怎么说的」「我的偏好是什么」「上次那个决定」这类事时，"
    "**先用 `recall` 检索它**；不要凭印象回答，也不要说「我记不住」。\n"
    "- `recall` 给的是**片段 + 文件路径与行号**，片段可能被截断；不够时用"
    " `read_memory` 按那个 path 与行号展开上下文，不要凭片段猜、也不要以为"
    "片段就是全文。\n"
    "- `recall` 只搜 `{daily}/` 与 `{digest}/`；`MEMORY.md` / `SOUL.md` / `PROFILE.md`"
    " / `AGENTS.md` **不在召回池里**，搜也搜不到——那四份是设定文件，不是记忆条目。\n"
    "- 要长期留下一条事实时用 `remember`，它写进 `MEMORY.md` 的「核心长期记忆」一节。"
)

#: Agent **可以自己整份改写**的人设文件（``write_memory`` 的白名单）。
#:
#: **v0.52 起只留 ``PROFILE.md`` 一份**（用户口径）：它是"**对方是谁**"——Agent 从
#: 对话里认识到的那些事实本来就该由它写下来，这也是首次引导能落地的前提。
#: 另外三份都是**用户自己的东西**，Agent 只读不写：
#:
#: - ``SOUL.md``（人格）与 ``AGENTS.md``（操作规程）原先也在白名单里（设计文档 §2.5
#:   写的是"由 Agent 自己进化"）。收掉的代价是"Agent 不能自己改自己的性子"，
#:   换来的是**这两份文件的内容一定是用户自己认可的**——它们每轮整份进上下文，
#:   而 Agent 改自己的人格这件事既难回滚、也难让用户察觉；想让它变，让它**说出来**，
#:   由用户改。
#: - ``MEMORY.md`` 从来不在名单里：那份的条目由 ``remember`` 增删（管去重、
#:   只替换「核心长期记忆」那一节、不碰别的段落），整份覆盖等于把"一条一条地维护"
#:   换成"一把梭"。
WRITABLE_PERSONA_FILES: tuple[str, ...] = (PROFILE_FILE,)

#: **首次引导**那一段：人设还是空模板时注入，让 Agent 先去认识对方。
#:
#: 为什么需要它（照 QwenPaw 的 ``BOOTSTRAP.md`` 抄它的做法）：``PROFILE.md`` 的
#: 模板里"名字："后面是空的，而**没有任何机制会让它被填上**——用户不会主动去改
#: 一个人设文件（他甚至不知道有这回事），Agent 也不会问。于是启动后提示词里确实
#: 进来了几千字，全是不认识对方的样板文；用户那边的体感就是"人设没生效"。
#: QwenPaw 的解法是首次跑一次"共同定义身份"的引导对话，我们照抄。
#:
#: **信号是"``PROFILE.md`` 还是模板"**（见 ``profile_is_untouched``），
#: 而不是某个 BOOTSTRAP.md 文件：QwenPaw 那份文件用完要删，而我们是每轮都跑一次
#: "补缺文件"的，删掉之后会被重新铺出来——引导会无限重启。
#: 用"对方资料还空着"当信号则**自己就会结束**：Agent 一写进去，下一轮它就不在了。
_BOOTSTRAP = (
    "【还没认识对方：这一轮该做一次开场】\n"
    "`PROFILE.md` 还是空的模板——也就是说**「对方是谁」这件事你还没写下来**。\n"
    "**这一轮就做这件事**，哪怕对方只是打了个招呼、或者只说了两个字。\n"
    "**不要用「我能做什么」开场**，也不要把你没被问到的能力列一遍"
    "（联网、笔记、工具、知识库这些）——那是自我介绍，不是认识人。\n"
    "**先看一眼记忆里已经知道的**（`MEMORY.md` 与 `recall`）：已经知道的那几件"
    "**别再问一遍**，直接写下去就行；剩下的再**在你的回答里自然地问他**"
    "（不用一次问完，也别像填表）。通常要弄清楚的是：\n"
    "- 他怎么称呼自己，以及他希望你怎么称呼他；\n"
    "- 他在做什么、关心什么；\n"
    "- 他希望你怎么说话（简洁还是详细、要不要先给结论）。\n"
    "拿到答案之后：**都写进 `PROFILE.md`**（身份、称呼、在做什么、希望你说话的风格；"
    "用 `write_memory` 整份替换——**先 `read_memory` 读一遍，别把里面已有的"
    "约定弄丢**）；稳定的偏好再用 `remember` 记一条。"
    "**`SOUL.md` 与 `AGENTS.md` 是对方自己的东西，你不要去改**——"
    "想让你的性子或规矩变，就说出来让他决定。"
    "做完**告诉对方你写了什么**——那是他的设定，他该知道。\n"
    "只要 `PROFILE.md` 还是空的，这一段每轮都会出现；填上之后它自己就没了。"
)

#: 新建**会话笔记**时的骨架。文件名是 ``daily/<日期>/<会话 slug>.md``
#: （见 ``memory_files.session_note_path``）——**一个会话一天一条**，同一天再
#: 沉淀就是更新这一条，而不是往一个平铺文件里继续追加。
#:
#: ``session_id`` 进 frontmatter 而**不是**写成 wikilink：它是我们认领"这份笔记
#: 属于哪次对话"的键（QwenPaw 的 Auto-Memory 正是用 ``session_id`` 精确匹配来判
#: "更新已有还是新建"），而链接形式会指向一个不存在的文件，把图谱的悬空链接数
#: 弄脏——这条纪律原先那个平铺文件就已经在守了。
#:
#: 日期**用本地日期**而不是 UTC：这是给人看的"今天的现场"，而人的日期感是本地
#: 时间（用 UTC 会让东八区早上 8 点前的对话记到"昨天"）。
_DAILY_TEMPLATE = """---
summary: "{summary}"
{title_line}session_id: "{session_id}"
---

# {date} 现场

{entries}

<!-- 来源会话：{session_id}（本文件由对话自动沉淀，只增不改） -->
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
    """记忆的实现。**内容全在本地**：读写的都是 ``data/memory/`` 下的 Markdown。

    两个动作会出网，都是**可选的**、都有开关：

    - 捕获时问一次对话模型（``capture``）——那不是"记忆服务"，而是我们自己的模型
      通道，模型没配好时它明确报错（见 ``_ask_model``）；
    - 向量那一路（``memory.vector_enabled``）把记忆块嵌入一次做本地索引
      （``sync_index`` / ``memory_index``）——默认关，关着时检索完全走词面那一路。
    """

    def __init__(
        self,
        runtime: RuntimeConfigService,
        data_dir: Path,
        *,
        stores: StoreBundle | None = None,
        ask: Callable[[list[ChatMessage]], str] | None = None,
        embed: memory_index.EmbeddingSource | None = None,
    ) -> None:
        self._runtime = runtime
        self._data_dir = data_dir
        #: 存储（可选）：**只有入队捕获任务时才需要**。不给它也能用——
        #: recall / remember / 注入都不碰数据库，测试与脚本因此可以轻量构造。
        self._stores = stores
        #: 问模型的能力（可选）：不给就用运行期配置里绑定的对话模型（见 ``_ask_model``）。
        #: 测试注入它来跑"捕获"这条链路，不必真连一个模型。
        self._ask = ask
        #: 嵌入能力（可选）：不给就没有向量那一路（词面那一路本来就是完整的）。
        self._embed = embed

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
                memory_files.invalidate(path)
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
            memory_files.invalidate(path)
        except OSError:
            logger.warning("人设模板升级失败：%s", path, exc_info=True)
            return False
        logger.info("人设模板已升级（这份文件一直是初始模板，没有人改过）：%s", path.name)
        return True

    def persona_order(self) -> tuple[str, ...]:
        """这一轮**注入哪几份人设文件、按什么顺序**（``memory.persona_files``）。

        照 QwenPaw 的 ``system_prompt_files``：那几份文件每轮整份进 system prompt，
        所以"哪几份、什么顺序"是用户的设定。三条口径：

        - 取值是**逗号分隔的文件名**，按写的顺序注入；
        - **只认那四份核心文件**（``memory_files.CORE_FILES``）：别的一律丢掉并记日志
          ——让任意路径进 system prompt 等于绕过"哪些是设定、哪些是被召回的现场"
          这条分界（想让别的内容每轮都在，写进 ``AGENTS.md`` 就是那条正当的路）；
        - **空值/全不认识 → 回到默认顺序**（不写就是默认，不是"一份都不注入"）。
          这与"未配置时取 ``DEFAULTS``"那条口径一致，也让测试替身的未配置状态
          （假 runtime 取不到值）落到同一个结果上。

        **一处与 QwenPaw 的默认不同，如实记着**：它默认**不注入** ``MEMORY.md``
        （那份是它的长期记忆索引页，很大，只靠按需召回）；我们默认注入，因为我们的
        ``MEMORY.md`` 是 ``remember`` 逐条维护的小文件、而且"最近的约定"靠它才稳定。
        现在这个差异**由用户自己决定**——把 ``MEMORY.md`` 从这一行删掉就是 QwenPaw 的形态。
        """
        raw = (self._runtime.get("memory.persona_files") or "").strip()
        if not raw:
            return tuple(name for name, _label in PERSONA_FILES)
        wanted: list[str] = []
        for item in raw.replace("，", ",").split(","):
            name = item.strip()
            if not name:
                continue
            if name not in memory_files.CORE_FILES:
                logger.warning("人设文件清单里有不认识的文件名，已忽略：%s", name)
                continue
            if name not in wanted:
                wanted.append(name)
        return tuple(wanted) or tuple(name for name, _label in PERSONA_FILES)

    def persona_texts(self, user_id: str | None = None) -> list[tuple[str, str]]:
        """``[(文件名, 正文)]``，按 :meth:`persona_order` 的顺序，空的跳过。

        **不在这里拼字符串**：拼装交给 `services/prompt.py` 的贡献者——
        那里才知道"这一轮是工具循环还是检索链路""要不要带摘要"。
        """
        found: list[tuple[str, str]] = []
        for name in self.persona_order():
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

    def guidance(self) -> str:
        """要注入 system prompt 的「长期记忆怎么用」那一段；**未启用时是空串**。

        空串而不是"关着时也说明一下"：关着时 ``recall`` 会明确报错，把"什么时候
        该去查记忆"讲给模型听，只会换来每轮一次无效调用加一句错误——与知识库
        那一侧的教训同源（见 ``agent_tools._KB_TOOLS``：给了又拒，白花两个来回）。

        而 ``MEMORY.md`` 的写入指导不受这道闸影响：它走 ``remember``，不看开关，
        也已经写在 ``AGENTS.md`` 模板的工具那一节里了。
        """
        if not self.enabled:
            return ""
        return _GUIDANCE.format(
            daily=memory_files.DAILY_DIR, digest=memory_files.DIGEST_DIR
        )

    def profile_is_untouched(self, user_id: str | None = None) -> bool:
        """对方的资料是不是**一个字都没动过**（还是我们当初写下去的模板）。

        判据是**逐字节相同**，与 ``_upgrade_untouched_template`` 同一套口径：
        差一个字节就不算"没填过"。它是"要不要做首次引导"的信号，所以宁可漏判
        （用户已经动过一点就不再引导）也不要误判——对着一个写了半天资料的人
        问"你是谁"是很糟的体验。

        旧版模板也认（那些实例还没被 ``seed_persona`` 升级过），否则它们的
        引导会一直不出现。
        """
        known = {_PROFILE_TEMPLATE, _LEGACY_TEMPLATES.get(PROFILE_FILE, "")}
        known.discard("")
        try:
            text = (self.workspace_for(user_id) / PROFILE_FILE).read_text(encoding="utf-8")
        except OSError:
            return False
        return text in known

    def bootstrap_block(self, user_id: str | None = None) -> str:
        """首次引导那一段；对方资料已经被填过时是空串。

        **不看 ``memory.enabled``**：人设文件的注入与编辑本来就不受那道闸管
        （见模块头与 ``remember`` 的说明）——"你还不认识对方"与"过去的对话会不会
        被召回"是两回事，把它挂在记忆开关上会让关着记忆的实例永远不做引导。
        """
        return _BOOTSTRAP if self.profile_is_untouched(user_id) else ""

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

        打分与命中判据都在 ``memory_files.search``（读那一处的说明）；
        **向量那一路开着时**再走 ``memory_index.search_hybrid``（词面 + 语义，
        RRF 融合）——两条路各自完整，关掉向量就是纯词面，不是"降级"。
        顺链给出的邻接边是**免费附带的**：wikilink 就在正文里，
        命中文件一出链就顺出来了，不需要第二次检索。
        """
        self._require_enabled()
        text = query.strip()
        if not text:
            raise InvalidRequestError("缺少参数：query")
        count = max(1, min(int(limit or DEFAULT_RECALL), MAX_RECALL))

        space = self.workspace_for(user_id)
        embed = self._embed if self._vector_on() else None
        if embed is None:
            hits = memory_files.search(space, text, limit=count)
        else:
            hits = memory_index.search_hybrid(
                space,
                text,
                source=embed,
                limit=count,
                min_score=self._runtime.get_float("memory.vector_min_score"),
            )
        links = [
            MemoryLink(path=path, direction=direction, name=name)
            for path, direction, name in memory_files.links_of(
                self.files(user_id), [item.path for item in hits]
            )
        ]
        return hits, links

    def _vector_on(self) -> bool:
        """向量那一路开着吗：**开关 + 有没有嵌入能力**，两样都要。

        没接嵌入能力（比如 MCP 那条只读通道）时不算开着——那种情形下报"开关打开了
        但没有嵌入模型"没有意义，词面那一路本来就是完整的。
        """
        return self._embed is not None and self._runtime.get_bool("memory.vector_enabled")

    # ------------------------------------------------------------------ 向量索引

    def sync_index(
        self, user_id: str | None = None, *, force: bool = False
    ) -> dict[str, Any]:
        """让向量索引与当前块对齐（嵌入**只在内容真的变了时**才发生）。

        挂在 worker 的空闲分支上（见 ``core/services.py`` 的 ``_maintain``），
        **不在召回路径上**：嵌入是一次网络调用，放进召回就等于让每次检索都赌一次
        上游的延迟。代价是索引可能落后一轮——所以查询时只认当前确实存在的块
        （见 ``memory_index`` 的说明第 1 条）。
        """
        if self._embed is None:
            return {"skipped": "没有嵌入能力"}
        if not force and not self._runtime.get_bool("memory.vector_enabled"):
            return {"skipped": "向量那一路关着"}
        space = self.workspace_for(user_id)
        if not space.is_dir():
            return {"skipped": "工作区不存在"}
        return memory_index.sync(space, self._embed)

    def sync_index_all(self, *, force: bool = False) -> dict[str, Any]:
        """每一份工作区都对齐一遍（**给 worker 的空档维护用的**）。

        一份失败不影响别的：挨个 try，与 ``dream_all`` 同一条取舍。
        """
        done: dict[str, Any] = {}
        for user_id in self.workspaces():
            try:
                result = self.sync_index(user_id, force=force)
            except Exception:
                logger.warning("对齐记忆向量索引失败，跳过：%s", user_id or "共享桶", exc_info=True)
                continue
            if result.get("embedded") or result.get("dropped"):
                done[user_id or "-"] = result
        return done

    # ------------------------------------------------------------------ 捕获

    def capture(
        self, messages: list[dict[str, str]], *, session_id: str, user_id: str | None = None
    ) -> dict[str, Any]:
        """把一轮对话沉淀成记忆条目（**我们自己的实现**，v0.46 起）。

        三步：让对话模型挑出"值得长期留下"的条目 → 与工作区里已有的条目去重
        → 写进**这个会话当天的那一条笔记**（``daily/<日期>/<会话>.md``），
        并刷新当天的索引页。

        **为什么一个会话一天一条，而不是往一个平铺的当天文件里追加**（本轮改的
        结构）：一个会话一天会沉淀很多次，平铺文件里既分不清哪些条目属于哪次
        对话、也没有地方可以"更新"——于是只能越堆越长，而"记忆只增不并"正是
        那么来的。照 QwenPaw 的 Auto-Memory：**按 ``session_id`` 认领笔记**，
        命中就续写那一条。

        为什么落 daily 而不是 ``MEMORY.md``（设计文档 §1 的两层分工）：
        ``MEMORY.md`` 是那几份**每轮整份注入上下文**的核心文件，自动沉淀直接写进去
        等于机器替人决定"什么该长期占着上下文窗口"；而 daily 是按需召回的现场，
        只增不并——**整理是另一件事**（``dream``，v0.49 落地）：它按节拍把现场
        沉淀成 ``digest/`` 里的长期知识，而现场那份永远不改。

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
        title, summary = _capture_headline(raw)
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

        path = self._write_capture(
            space, fresh, session_id=session_id, title=title, summary=summary
        )
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

        **关掉思考**（``enable_thinking=False``）：``llm.py`` 的模块注释里就写着这条
        ——抽取类任务要显式关。实测（真模型 + 真数据，2026-09-27）开着思考时模型的
        **推理过程会混进正文**：那次的整理输出里中英文夹着"等等，第二个条目没有内容，
        不应该输出…Let me reconsider and produce clean output"，于是解析器只认得出半条。
        记忆沉淀是"从一段话里挑出事实"，不是推理题，那些 token 只会添乱。
        """
        if self._ask is not None:
            return self._ask(messages)
        config = self._runtime.llm()
        if not config.is_configured:
            raise InvalidRequestError(
                "没有配置对话模型，记忆沉淀需要一个能用的对话模型（设置 → 模型）"
            )
        return OpenAICompatChat(replace(config, enable_thinking=False)).complete(messages)

    def _write_capture(
        self,
        space: Path,
        entries: list[str],
        *,
        session_id: str,
        title: str = "",
        summary: str = "",
    ) -> str:
        """把条目写进**这个会话当天的那一条笔记**，并刷新当天索引页。

        **三个纪律**：

        - 落到谁的目录由调用方给（``space``），文件里不留任何跨账号信息；
        - 来源会话写成一行 HTML 注释（``<!-- 来源会话 conv_x -->``）：
          渲染出来看不见（不打扰正文），又能回答"这条是哪次对话来的"。
          不写成 wikilink——那会连到不存在的文件上，把图谱的悬空链接数弄脏；
        - **同一天同一会话写进同一份笔记**：认领的键是 ``session_id``（写进了
          frontmatter，所以下一次沉淀找得回来），而不是靠内容相似度去猜。
        """
        day = datetime.now().strftime("%Y-%m-%d")
        relative = memory_files.session_note_path(session_id, day=day)
        # 路径由我们自己拼，但仍然过一遍同一套安全解析：文件名里带着会话 id，
        # 而"绝不会越界"这件事该有唯一一处判据，不该靠"这个 id 是我们生成的"。
        target = memory_files.safe_path(space, relative)
        block = "\n".join(f"- {entry}" for entry in entries)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                body = target.read_bytes().decode("utf-8", errors="replace").rstrip("\n")
                content = f"{body}\n{block}\n{_source_note(session_id)}\n"
            else:
                content = _DAILY_TEMPLATE.format(
                    summary=_frontmatter_value(summary or _note_summary(entries)),
                    title_line=(
                        f'title: "{_frontmatter_value(title)}"\n' if title.strip() else ""
                    ),
                    session_id=_frontmatter_value(session_id),
                    date=day,
                    entries=block,
                )
            # 按字节写：``write_text`` 在 Windows 上把 ``\n`` 翻成 ``\r\n``
            # （与 memory_files 同一处坑），而这份文件用户也会用别的编辑器改
            target.write_bytes(content.encode("utf-8"))
            # 我们自己写的要显式失效（理由见 `memory_files.invalidate`）：捕获落的
            # 就是召回池里的东西，不能等 mtime 那一层——网络文件系统的时间戳
            # 精度可能只有一秒上下。
            memory_files.invalidate(target)
        except OSError as exc:
            raise InvalidRequestError(f"写不了当天的记忆笔记：{exc}") from exc
        try:
            memory_files.refresh_day_index(space, day=day)
        except InvalidRequestError:
            # 索引页是**派生物**：刷不出来只是"当天目录少一行"，笔记本身已经落盘。
            # 不让它把一次成功的沉淀变成失败——下一次沉淀会再刷一遍。
            logger.warning("当天记忆索引页刷不出来：%s", day, exc_info=True)
        return relative

    # ------------------------------------------------------------------ 整理
    #
    # 捕获把对话变成**现场**（``daily/``），整理把现场沉淀成**长期知识**（``digest/``）。
    # 这一节是 QwenPaw 的 Auto-Dream 在 KYLAB 的落点，第一条纪律与它一致：
    # **只写 digest/，绝不回头改现场**——现场是"当时到底发生了什么"的不可变记录。

    def workspaces(self) -> list[str | None]:
        """所有记忆工作区：共享桶（``None``）与每个账号一份。

        判据是**这个目录里有那四份核心文件里的至少一份**（``seed_persona`` 会铺它们）：
        ``daily/`` / ``digest/`` 这些子目录不会命中，所以不必另立一张
        "哪些账号有工作区"的表——工作区本来就是目录。
        """
        root = self.workspace_for(None)
        out: list[str | None] = [None]
        try:
            children = sorted(item for item in root.iterdir() if item.is_dir())
        except OSError:
            return out
        for child in children:
            if any((child / name).exists() for name in memory_files.CORE_FILES):
                out.append(child.name)
        return out

    def dream(self, user_id: str | None = None, *, force: bool = False) -> dict[str, Any]:
        """跑一次**整理**：把变了样的现场沉淀进 ``digest/``。

        **不看第二个开关**（设计文档 §2.3 那条纪律：记忆的开关只能有一个判据）：
        整理是"记忆开着"这件事的一部分，节拍由 ``memory.dream_after_hours`` 定，
        调成 0 就是不做——不另立一个"启用整理"。

        三道闸按代价从低到高，**先便宜的先过**：

        1. 开关与节拍（读配置，几微秒）；
        2. **有没有变了样的现场**（读目录 mtime）——没有就**一次模型都不调**
           （照 QwenPaw 的"No changed dream input"提前返回）；
        3. 都没有才问模型。

        ``force`` 给测试与手工触发用：跳过开关与节拍，但**仍然只看"有没有变化"**
        ——没有变化还去调模型，那是白花钱。
        """
        if self._stores is None:
            return {"skipped": "没有接存储"}
        if not force:
            if not self.enabled:
                return {"skipped": "未启用长期记忆"}
            hours = self._runtime.get_int("memory.dream_after_hours")
            if hours <= 0:
                return {"skipped": "整理已关闭（节拍为 0）"}
            if not _dream_due(self._dream_state(user_id), hours):
                return {"skipped": "还没到节拍"}
        space = self.workspace_for(user_id)
        if not space.is_dir():
            return {"skipped": "工作区不存在"}
        state = self._dream_state(user_id)
        changed = self._changed_daily(space, state)
        if not changed:
            # 没有变化：不调模型，但把时间往前推，免得每一轮空档都重新扫一遍
            self._save_dream_state(
                user_id, {"at": datetime.now(UTC).isoformat(), "files": state.get("files") or {}}
            )
            return {"skipped": "现场没有变化", "units": 0}
        picked = changed[:DREAM_MAX_FILES]
        messages = [
            ChatMessage(role="system", content=_DREAM_SYSTEM),
            ChatMessage(
                role="user",
                content=_dream_prompt(
                    [(path, body) for path, body, _stamp in picked], self._digest_index(space)
                ),
            ),
        ]
        raw = self._ask_model(messages)
        units = _parse_dream(raw)
        if raw.strip() and not units:
            # 模型**说了话，但我们一条都认不出来**：这不是"没有值得沉淀的"，
            # 是这一轮没成事。此时**绝不能推进水位线**——推了那份现场就永远不会
            # 再被整理，而且**不会报错**。真跑（2026-09-27）两次都栽在这里：
            # 一次把格式里的占位符原样吐回来，一次把推理过程写进了正文。
            logger.warning(
                "整理输出一条都认不出来，这一批现场留到下一轮：%r", raw[:200]
            )
            # **时钟走、内容不记**：``at`` 往前推（免得每个空闲周期都去问一次模型，
            # 那是拿钱换一个已知会失败的结果），``files`` 一个都不记（那份现场
            # 下一轮还会出现在"变了样的"里面）。
            self._save_dream_state(
                user_id,
                {"at": datetime.now(UTC).isoformat(), "files": state.get("files") or {}},
            )
            return {
                "units": 0,
                "created": [],
                "updated": [],
                "failed": [],
                "skipped": "模型输出认不出来",
            }
        applied = self._apply_dream(
            space,
            units,
            sources=[path for path, _body, _stamp in picked],
            day=datetime.now().strftime("%Y-%m-%d"),
        )
        files = {
            path: stamp
            for path, stamp in (state.get("files") or {}).items()
            if (space / path).exists()
        }
        # **只有这一批全落盘了才写回水位线**（QwenPaw 的 dream catalog 那条规矩：
        # 失败路径绝不回写 checkpoint，否则那份现场**永远不会再被整理**，
        # 而且不会报错）。一条没落盘就整批留到下一轮——重试是安全的，
        # 因为 `_append_dream` 对"正文已经在里面了"是幂等的（见它自己的说明）。
        if applied["failed"]:
            logger.warning(
                "整理里有 %d 条没落盘，这一批现场留到下一轮重试：%s",
                len(applied["failed"]),
                applied["failed"],
            )
        else:
            for path, _body, stamp in picked:
                files[path] = stamp
        self._save_dream_state(user_id, {"at": datetime.now(UTC).isoformat(), "files": files})
        return {"units": len(units), **applied}

    def dream_all(self, *, force: bool = False) -> dict[str, Any]:
        """**给 worker 的空档维护用的**：每一份工作区都看一遍。

        为什么挂在空档而不是上 cron（QwenPaw 用 apscheduler 的 ``0 23 * * *``）：
        KYLAB 没有常驻调度器，而 worker 已经有一个"没活可干时"的分支（补文档摘要
        就挂在那里）。节拍由 ``memory.dream_after_hours`` 定，实际精度就是那个空闲
        间隔——对"整理"这件事够用，而**少一个依赖**。

        **一份工作区失败不影响别的**：挨个 try，与"补摘要失败不该带走消费者"同一条取舍。
        """
        done: dict[str, Any] = {}
        for user_id in self.workspaces():
            try:
                result = self.dream(user_id, force=force)
            except Exception:
                logger.warning("整理工作区失败，跳过：%s", user_id or "共享桶", exc_info=True)
                continue
            if result.get("created") or result.get("updated"):
                done[user_id or "-"] = result
        return done

    def _dream_state(self, user_id: str | None) -> dict[str, Any]:
        """整理的水位线：``{"at": 上次跑的时间, "files": {相对路径: mtime_ns}}``。

        存成一行 JSON（``app_settings`` 是文本仓，与 ``memory.captured.*`` 同一个用法）。
        """
        if self._stores is None:
            return {}
        raw = self._stores.meta.get_setting(_DREAMED_KEY + (user_id or "-"))
        if not raw:
            return {}
        try:
            data = json.loads(raw)
        except ValueError:
            logger.warning("整理水位线读不动，当成没有：%s", user_id or "共享桶")
            return {}
        return data if isinstance(data, dict) else {}

    def _save_dream_state(self, user_id: str | None, state: dict[str, Any]) -> None:
        if self._stores is None:
            return
        try:
            self._stores.meta.set_setting(
                _DREAMED_KEY + (user_id or "-"), json.dumps(state, ensure_ascii=False)
            )
        except Exception:
            # 水位线写不进去只是下一轮重做一次整理（结果一样），不该让这一轮失败
            logger.warning("整理水位线写不进去：%s", user_id or "共享桶", exc_info=True)

    def _changed_daily(self, space: Path, state: dict[str, Any]) -> list[tuple[str, str, int]]:
        """**变了样的**现场文件：``[(相对路径, 正文, mtime_ns)]``。

        只认 ``daily/``——整理只吃现场，``digest/`` 是自己写的那一侧（改它的是
        用户和 ``write_memory``）。判据是 mtime 与水位线里记的那一份不同，缺的也算变了。
        """
        known = state.get("files") or {}
        directory = space / memory_files.DAILY_DIR
        out: list[tuple[str, str, int]] = []
        if not directory.is_dir():
            return out
        for target in sorted(directory.rglob("*.md")):
            try:
                stamp = target.stat().st_mtime_ns
                rel = memory_files.to_relative(space, target)
                text = target.read_bytes().decode("utf-8", errors="replace")
            except (OSError, ValueError):
                logger.warning("读现场文件失败，跳过：%s", target, exc_info=True)
                continue
            if known.get(rel) == stamp:
                continue
            out.append((rel, text[:DREAM_FILE_CHARS], stamp))
        return out

    def _digest_index(self, space: Path) -> str:
        """现有长期知识的目录：``- 路径：摘要``，给模型挑"这条该并到哪一份上"。

        只给**路径与摘要**、不给正文：给正文会让这次调用的成本跟着长期知识的规模
        一起涨。QwenPaw 那侧靠向量宽召回挑候选（``node_search``，limit=20–30），
        我们靠"目录本来就不大"——量级是几份到几百份，整份目录仍然比召回的预算小。
        摘要缺了就退回标题：**一行也不能空着**，模型会以为那份文件是空的。
        """
        lines: list[str] = []
        for entry in memory_files.scan(space):
            if entry.kind != memory_files.DIGEST_KIND:
                continue
            lines.append(f"- {entry.path}：{entry.summary or entry.title}")
        return "\n".join(lines)

    def _apply_dream(
        self,
        space: Path,
        units: list[_DreamUnit],
        *,
        sources: list[str],
        day: str,
    ) -> dict[str, Any]:
        """把整理结果写进 ``digest/``。**只写这一侧，绝不回头改现场。**

        - ``CREATE`` 落 ``digest/<类别>/<名字>.md``；名字撞上已有文件时**当成更新**
          （模型说 CREATE 而那个主题已经在了，并进去比重建它安全）；
        - ``CORROBORATE`` / ``REFINE`` / ``CORRECT`` 找**已有那一份**：三个类别目录里
          按名字找（照 QwenPaw 的"UPDATE may target any bucket"）——模型给类别时未必
          和当初建那条时选的一样，而"同一个主题"比"同一个类别"重要。找不到就退回新建：
          那说明模型把动作说错了，而"新建"是可恢复的，覆盖不是。
        """
        created: list[str] = []
        updated: list[str] = []
        failed: list[str] = []
        for unit in units:
            slug = _dream_slug(unit.name)
            rel = self._find_digest(space, slug) or (
                f"{_DIGEST_DIR_NAME}/{unit.bucket}/{slug}.md"
            )
            body = _with_links(unit.body, unit.links)
            existing = ""
            if (space / rel).exists():
                try:
                    existing = (space / rel).read_bytes().decode("utf-8", errors="replace")
                except OSError:
                    logger.warning("读不了那份长期知识，跳过这一条：%s", rel, exc_info=True)
                    failed.append(rel)
                    continue
            if existing.strip():
                text = _append_dream(existing, body=body, sources=sources, day=day)
                if text == existing:
                    # 幂等：这一条已经在里面了（上一轮其实写成功过），这次是重试
                    continue
                landed = updated
            else:
                text = _compose_dream(
                    unit.name,
                    summary=unit.summary,
                    kind=_DREAM_KINDS[unit.bucket],
                    body=body,
                    sources=sources,
                )
                landed = created
            try:
                memory_files.write_file(space, rel, text)
            except InvalidRequestError:
                # 写不进去（超长、被占）只跳过这一条：其余条目照常落盘，
                # 而这一批现场**整批**留在"变了样的"里面，下一轮重试
                logger.warning("整理结果写不进去，跳过这一条：%s", rel, exc_info=True)
                failed.append(rel)
                continue
            if rel not in landed:
                landed.append(rel)
        # **Auto-Link 的另一半**：模型只在写入那一刻给它知道的关联；两份长期知识
        # 之间的边要等它们都存在之后才看得出来。放在这一层（而不是提示词里）是因为
        # 它**不用再问一次模型**——用同一套词面判据就能找同类主题。
        linked = self._autolink(space, [*created, *updated])
        return {"created": created, "updated": updated, "failed": failed, "linked": linked}

    def _autolink(self, space: Path, touched: list[str]) -> dict[str, list[str]]:
        """给刚碰过的那几份长期知识补「另见」（Auto-Link 的另一半）。

        QwenPaw 的 Auto-Link 在整合那一步里顺带做（同一次模型调用里让模型给关联名字）；
        我们**不调模型**：用与召回同一套词面判据找同类主题，只是判据更严
        （``LINK_MIN_COVERAGE``）——一条错链接会被用户当成"这两件事有关"，而一次
        召回的误命中只是多给一条参考。

        **双向**：A 补一条指向 B 时，B 也补一条指向 A（QwenPaw 的 backlink）。
        图谱的"入链"那一半因此才有东西可显示。
        """
        if not touched:
            return {}
        entries = {item.path: item for item in memory_files.scan(space)}
        digest = {
            path for path, item in entries.items() if item.kind == memory_files.DIGEST_KIND
        }
        added: dict[str, list[str]] = {}
        for rel in dict.fromkeys(touched):
            if rel not in digest:
                continue
            title = entries[rel].title.strip()
            if not title:
                continue
            peers: list[tuple[str, str]] = []
            for hit in memory_files.search(space, title, limit=10, per_file=1):
                if hit.path == rel or hit.path not in digest or hit.coverage < LINK_MIN_COVERAGE:
                    continue
                peers.append((hit.path, Path(hit.path).stem))
                if len(peers) >= LINK_MAX:
                    break
            mine = Path(rel).stem
            for peer_path, peer_name in peers:
                if self._link_up(space, rel, [peer_name]):
                    added.setdefault(rel, []).append(peer_name)
                if self._link_up(space, peer_path, [mine]):
                    added.setdefault(peer_path, []).append(mine)
        return added

    def _link_up(self, space: Path, rel: str, names: list[str]) -> bool:
        """往一份长期知识里补「另见」；返回**是否真的改了它**。"""
        try:
            text = memory_files.safe_path(space, rel).read_bytes().decode("utf-8", "replace")
        except OSError:
            logger.warning("读不了那份长期知识，跳过补链：%s", rel, exc_info=True)
            return False
        updated = _append_see_also(text, names)
        if updated == text:
            return False
        try:
            memory_files.write_file(space, rel, updated)
        except InvalidRequestError:
            logger.warning("补链写不进去，跳过：%s", rel, exc_info=True)
            return False
        return True

    def _find_digest(self, space: Path, slug: str) -> str | None:
        """三个类别目录里找这个名字那份；没有就 ``None``。"""
        for bucket in DREAM_BUCKETS:
            rel = f"{_DIGEST_DIR_NAME}/{bucket}/{slug}.md"
            if (space / rel).exists():
                return rel
        return None

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

        它只负责"把**给定的这些**消息排进队列"，不负责挑消息——一轮问答收尾时
        该走的是 :meth:`capture_turn`（它知道该送哪一段）。
        """
        stores = self._stores
        if stores is None or not self._capture_due(turn_count):
            return False
        self._enqueue(stores, messages, session_id=session_id, user_id=user_id)
        return True

    def _capture_due(self, turn_count: int) -> bool:
        """这一轮该不该沉淀（开关 + 节流）。**规则只在这一处判。**

        存储那一条不在里面：它是"能不能写"、不是"该不该做"，由调用方各自
        先取 ``self._stores`` 再判（那样才不用 ``assert`` 去收窄类型，
        而 ``S101`` 在本仓只对测试放行）。
        """
        if not self.enabled:
            return False
        every = self._runtime.get_int("memory.capture_every") or DEFAULT_CAPTURE_EVERY
        every = max(1, every)
        return turn_count > 0 and turn_count % every == 0

    def capture_due(self, turn_count: int) -> bool:
        """这一轮**会不会真的入队**（开关 + 存储 + 节流）。

        与 ``_capture_due`` 分开，是为了让"要不要给用户看那一步"能问**同一处判据**
        （见 ``api/v1/chat._memory_handoff_step``）：两处各算一遍的话，迟早会漂成
        "界面上说会沉淀、其实不会"——而那种不一致不会报错，只会让人不再信它。
        """
        return self._stores is not None and self._capture_due(turn_count)

    def _enqueue(
        self,
        stores: StoreBundle,
        messages: list[dict[str, str]],
        *,
        session_id: str,
        user_id: str | None,
    ) -> None:
        stores.meta.enqueue_task(
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

    def capture_turn(
        self,
        conversation_id: str,
        *,
        turn_count: int = 0,
        user_id: str | None = None,
        force: bool = False,
    ) -> bool:
        """一轮问答收尾时该做的事：凑够节流就把**上次以来累积的**对话排进队列。

        **为什么不再只送当轮那两条**（这是本轮修的漏）：节流是"每 N 个用户回合
        沉淀一次"，而原先每次只把**当轮**交出去——两者相乘的结果是**每 N 轮里
        只有 1 轮被看过一眼，其余 N-1 轮永远不进入记忆**。用户那边看到的现象
        就是"我明明说过，它就是不记得"。
        改法照 QwenPaw 的 Auto-Memory：它处理的也是"上次以来累积的对话"，
        而不是当前这一轮。

        水位线**在入队成功之后**才推进。payload 自带那一整段对话，队列失败会按
        重试语义把同一份 payload 再跑一遍（``capture`` 抛的是
        ``InvalidRequestError``，它不在 ``NON_RETRYABLE`` 里），所以推进了也不会丢。

        ``force`` 绕过节流，用于**上下文压缩**那一刻（照 QwenPaw 把 ``compact``
        当第三个触发源）：被折进摘要的消息从此不再进模型视野，而记忆要是还没记过
        它们，用户在下一轮问"刚才说的那个"就会两头都查不到——原文已经成了摘要、
        ``recall`` 里也还没有。这一步就是为那个窗口做的。
        """
        stores = self._stores
        if stores is None or not self.enabled:
            return False
        if not force and not self.capture_due(turn_count):
            return False
        backlog, upto = self._backlog(stores, conversation_id)
        if not backlog:
            return False
        self._enqueue(stores, backlog, session_id=conversation_id, user_id=user_id)
        if upto:
            try:
                stores.meta.set_setting(f"{_CAPTURED_KEY}{conversation_id}", upto)
            except Exception:
                # 水位线记不上只是下一轮多送一次（捕获自身的去重会兜住），
                # 不该反过来让"这一次已经排进队列"变成失败。
                logger.warning("记忆水位线写不进去：%s", conversation_id, exc_info=True)
        return True

    def _backlog(
        self, stores: StoreBundle, conversation_id: str
    ) -> tuple[list[dict[str, str]], str]:
        """上次捕获以来的对话（按时间序）；返回 ``(消息, 最后一条的 id)``。

        三条判断：

        1. **水位线以后的部分**才算新的。水位线是一条消息 id，存在 ``app_settings``
           里（见 ``_CAPTURED_KEY``）。用 id 而不是"第几条"：``/rewind`` 会删消息，
           序号会整体前移，而 id 不会。
        2. **水位线找不到**（那一条被 rewind 删掉了，或换了会话）时取**最近**
           ``CAPTURE_BATCH_TURNS`` 轮、而不是从头：从头等于把整段会话重记一遍，
           而其中绝大部分早就记过了。取最近这一段，重复的部分由捕获自身的去重兜住。
        3. **条数上限** ``CAPTURE_BATCH_TURNS``（理由见那个常量）。超限时从头取，
           水位线只推进到真正送出去的这一条，剩下的下一轮接着补。
        """
        records = stores.meta.list_messages(conversation_id)
        marker = stores.meta.get_setting(f"{_CAPTURED_KEY}{conversation_id}")
        start = 0
        if marker:
            ids = [item.id for item in records]
            start = (
                ids.index(marker) + 1
                if marker in ids
                else max(0, len(records) - CAPTURE_BATCH_TURNS * 2)
            )
        window = records[start : start + CAPTURE_BATCH_TURNS * 2]
        backlog = [
            {"role": item.role, "content": item.content}
            for item in window
            if item.role in _CAPTURE_ROLES and item.content.strip()
        ]
        # 推进到**窗口的最后一条**（哪怕它的正文是空的）：不推进的话，
        # 一条空消息会把水位线永久卡住，后面每一轮都从它重新往后送。
        return backlog, (window[-1].id if window else "")

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
        core = self.core_file_for(user_id)
        core.write_bytes(body.encode("utf-8"))
        # 显式失效：`remember` 写的是核心记忆，而它可能刚被读过（见 `invalidate`）
        memory_files.invalidate(core)


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


def _note_summary(entries: list[str]) -> str:
    """新笔记的 ``summary`` 兜底：**取第一条**（截到一句话的量）。

    从 v0.51 起它只是**兜底**：提示词会先让模型产出「主题」与「摘要」两行
    （照 QwenPaw 抽取那一步的 ``name`` 与 ``description``），模型给了就用模型给的。
    留着兜底是因为模型不一定照格式来——而"没有摘要"比"摘要是第一条条目"更糟
    （界面上那一列会空着）。
    """
    return entries[0][:NOTE_SUMMARY_CHARS] if entries else ""


def _capture_headline(raw: str) -> tuple[str, str]:
    """从捕获输出里取「主题」与「摘要」两行（v0.51）。

    它们是**这份笔记**的名字与一句话说明（照 QwenPaw 抽取那一步的 ``name`` 与
    ``description``）：界面列表、召回时的标题加权都用它。在此之前摘要只能取第一条
    条目——那处降级写在 ``_note_summary`` 里。

    **宽容到"认不出就当没有"**：冒号全角半角都认、标签前有项目符号也认、
    近义说法（标题/描述）也认。这两行本来就是可选的，模型不写不该让条目落不了盘。
    要求**必须带冒号**：不然 `- 主题是深色` 这种条目会被当成标题行读走。
    """
    title = ""
    summary = ""
    for raw_line in raw.splitlines():
        line = raw_line.strip().lstrip("-*# ").strip()
        for label in ("主题", "标题", "题目"):
            value = _after_label(line, label)
            if value and not title:
                title = value[:NOTE_TITLE_CHARS]
        for label in ("摘要", "描述", "概要"):
            value = _after_label(line, label)
            if value and not summary:
                summary = value[:NOTE_SUMMARY_CHARS]
    return title, summary


def _after_label(line: str, label: str) -> str:
    """``主题：xxx`` / ``主题: xxx`` → ``xxx``；不是这一行就返回空串。"""
    for colon in ("：", ":"):
        prefix = f"{label}{colon}"
        if line.startswith(prefix):
            return line[len(prefix) :].strip().strip("「」\"'")
    return ""


def _source_note(session_id: str) -> str:
    """来源会话那一行：**HTML 注释**，不是 wikilink（理由见 ``_DAILY_TEMPLATE``）。"""
    return f"<!-- 来源会话：{session_id} -->"


def _frontmatter_value(text: str) -> str:
    """放进 frontmatter 双引号里的安全形式。

    **必须转义**：``summary`` 取自模型产出的第一条，里面可能有引号、反斜杠或
    换行。不转义就会写出一份 YAML 坏掉的 frontmatter——而 ``parse_frontmatter``
    对坏 YAML 的处理是"退回空 frontmatter"，于是这份笔记在列表里没有摘要、
    也读不到 ``session_id``，下一次沉淀就认不出它、**再建一条新的**。
    """
    flat = " ".join((text or "").split())
    return flat.replace("\\", "\\\\").replace('"', '\\"')


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


# --------------------------------------------------------------- 整理的纯函数
#
# 与"捕获的纯函数"同一层意思：输入 → 输出，不碰文件、不连模型。整理这条链路上
# **最容易出错的是解析**（模型给的格式随时会飘一点），所以把它单独拎出来测。


@dataclass(frozen=True, slots=True)
class _DreamUnit:
    """模型给出的一个整理单元（格式见 ``_DREAM_SYSTEM``）。"""

    action: str
    bucket: str
    name: str
    summary: str
    body: str
    links: tuple[str, ...]


def _dream_due(state: dict[str, Any], hours: int) -> bool:
    """距上次整理够久了吗。**读不动的时间戳一律算"够久"**：宁可多整理一次，
    也不要因为一行坏 JSON 让整理永远不再发生（那种坏法是查不出来的）。"""
    at = state.get("at")
    if not isinstance(at, str) or not at:
        return True
    try:
        last = datetime.fromisoformat(at)
    except ValueError:
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=UTC)
    return (datetime.now(UTC) - last) >= timedelta(hours=hours)


def _dream_prompt(changed: list[tuple[str, str]], index: str) -> str:
    """这一次整理要看的东西：**变了样的现场** + **现有长期知识的目录**。"""
    parts = [
        "## 现有长期知识（目录：路径与摘要）",
        index or "（还没有长期知识：全部走 CREATE）",
        "## 现场（变了样的那一部分）",
    ]
    parts.extend(f"### {path}\n\n{body}" for path, body in changed)
    parts.append("请按系统提示词里那个格式输出。")
    return "\n\n".join(parts)


def _parse_dream(raw: str) -> list[_DreamUnit]:
    """把整理提示词的输出解析成单元。**认不出的一律丢掉并记日志**，不猜。

    **宽容读取、严格校验**：模型多写一句解释、少一个字段，都不该让整份输出作废；
    但动作或类别认不出来就丢掉那一条——写进 ``digest/`` 的东西是要长期留着的，
    宁少一条也不错一条。``正文`` 那个标记缺失时，把剩下的行都当正文
    （模型偶尔会漏掉标记，而漏掉的那部分恰恰是内容）。
    """
    out: list[_DreamUnit] = []
    header: str | None = None
    lines: list[str] = []

    def flush() -> None:
        nonlocal header, lines
        if header is not None:
            unit = _dream_unit_of(header, lines)
            if unit is not None:
                out.append(unit)
        header, lines = None, []

    for raw_line in raw.splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("```"):
            continue  # 模型爱把输出包在围栏里
        if stripped.startswith("==="):
            rest = stripped.lstrip("=").strip()
            flush()
            if rest:
                header = rest
            continue
        if header is not None:
            lines.append(raw_line.rstrip())
    flush()
    return out


def _dream_unit_of(header: str, lines: list[str]) -> _DreamUnit | None:
    """一条的头 + 它的若干行 → 单元；不合法就 ``None``（并记一条日志说明为什么）。"""
    parts = [item.strip() for item in re.split(r"[|｜]", header)]
    if len(parts) != 3:
        logger.warning("整理输出里认不出头部，跳过：%r", header[:60])
        return None
    action, bucket, name = parts[0].upper(), parts[1].lower(), parts[2]
    if action not in DREAM_ACTIONS or bucket not in DREAM_BUCKETS or not name:
        logger.warning("整理输出里的动作/类别/名字不合法，跳过：%r", header[:60])
        return None
    summary = ""
    links: tuple[str, ...] = ()
    body_lines: list[str] = []
    in_body = False
    for line in lines:
        stripped = line.strip()
        if not in_body and re.match(r"^摘要[：:]", stripped):
            summary = re.sub(r"^摘要[：:]\s*", "", stripped)
            continue
        if not in_body and re.match(r"^关联[：:]", stripped):
            links = tuple(re.findall(r"\[\[([^\]]+)\]\]", stripped))
            continue
        if not in_body and re.match(r"^正文[：:]?", stripped):
            in_body = True
            rest = re.sub(r"^正文[：:]\s*", "", stripped)
            if rest:
                body_lines.append(rest)
            continue
        body_lines.append(line)
    body = "\n".join(body_lines).strip()
    if not body:
        logger.warning("整理输出里这一条没有正文，跳过：%r", name[:40])
        return None
    return _DreamUnit(
        action=action,
        bucket=bucket,
        name=name,
        summary=summary or body.splitlines()[0][:NOTE_SUMMARY_CHARS],
        body=body,
        links=links,
    )


def _dream_slug(name: str) -> str:
    """主题名 → 文件名主干。

    三件事同时要成立：能在 ``[[...]]`` 里被链上、在 Windows 上合法、
    **同名就是同一个主题**（那正是 CORROBORATE/REFINE 的意思）。
    所以这里**不缀哈希**——与捕获那边按 ``session_id`` 命名刻意相反：那里同名是撞车，
    这里同名是"同一件事该并到一起"。

    **顺序要紧**：先抹掉模型可能给出的路径前缀（``digest/wiki/x.md`` 或 ``wiki/x.md``）、
    再删非法字符。反过来的话，``/`` 会先被删掉、前缀就再也认不出来，
    于是文件会叫「digestwiki锂价敏感性」。
    """
    clean = name.strip()
    clean = re.sub(rf"^{_DIGEST_DIR_NAME}/[^/]+/", "", clean)
    clean = re.sub(rf"^({'|'.join(DREAM_BUCKETS)})/", "", clean)
    clean = re.sub(r"\.md$", "", clean, flags=re.IGNORECASE)
    clean = _ILLEGAL_NAME.sub("", clean).strip().strip(".")
    return re.sub(r"\s+", "-", clean)[:60] or "未命名"


def _with_links(body: str, links: tuple[str, ...]) -> str:
    """把模型给的关联接成正文末尾的一句话。

    **不能让它变成裸链接行**（照 QwenPaw 的硬规定）：裸的 ``[[x]]`` 在这个仓库的
    别处被当成"关系字段"，而正文里孤零零一行链接读起来像一句没写完的话。
    收成"另见 A、B。"既保住链接、又是人话。
    """
    clean = body.strip()
    if not links:
        return clean
    return f"{clean}\n\n另见 " + "、".join(f"[[{item}]]" for item in links) + "。"


def _compose_dream(
    name: str, *, summary: str, kind: str, body: str, sources: list[str]
) -> str:
    """新建一份长期知识。

    ``## Sources`` 指回**现场**，它有两个作用：回答"这条是从哪次对话来的"，
    以及让那份现场在 ``_with_consolidation`` 眼里变成"已整合"——界面上那枚
    「待整合」标记因此才真的在说事（在此之前它永远只是涨）。
    """
    text = (
        "---\n"
        f'summary: "{_frontmatter_value(summary)}"\n'
        f"kind: {kind}\n"
        "---\n\n"
        f"# {name}\n\n{body}\n"
    )
    if sources:
        text += "\n## Sources\n" + "".join(f"\n- [[{item}]]" for item in sources) + "\n"
    return text


def _append_dream(existing: str, *, body: str, sources: list[str], day: str) -> str:
    """并进已有那份长期知识。

    **只增**：新的正文作为一节插在 ``## Sources`` **之前**（来源那节始终在末尾），
    来源里已有的链接不重复加。**不做模型驱动的分节重写**——那要第二次模型调用，
    代价与收益我判断不划算（与捕获那边"机械比对而不是再问一次模型"同一取舍），
    所以这里如实写着：它能追加与改错，但不会把旧内容重写成一篇。

    **幂等**：正文已经在里面了就原样返回。这是重试安全的前提——上一轮有一条没落盘时
    整批现场会留到下一轮，而那一轮里已经写成功过的条目会再被算一次。
    """
    if body.strip() and body.strip() in existing:
        return existing
    text = existing.rstrip("\n")
    section = f"## 更新（{day}）\n\n{body.strip()}"
    marker = "\n## Sources"
    if marker in text:
        head, _, tail = text.partition(marker)
        kept = [line for line in tail.splitlines() if line.strip()]
        known = set(re.findall(r"\[\[([^\]]+)\]\]", tail))
        for item in sources:
            if item not in known:
                kept.append(f"- [[{item}]]")
                known.add(item)
        return f"{head.rstrip()}\n\n{section}\n\n## Sources\n" + "\n".join(kept) + "\n"
    lines = "".join(f"\n- [[{item}]]" for item in sources)
    tail = f"\n\n## Sources{lines}\n" if sources else "\n"
    return f"{text}\n\n{section}{tail}"


#: 「另见」最多**自动**加几条（照 QwenPaw 的克制：链接多了等于没链接）。
#: 它只管自动补的那些；模型自己在 ``关联：`` 里给的链接不占这个额度。
LINK_MAX = 2

#: 自动补链的判据：**比召回更严**。召回错了只是多给一条参考；链接错了是在图谱上
#: 写下一句"这两件事有关"，而用户会信它。所以复用同一套覆盖率判据
#: （``memory_files.MIN_TERM_COVERAGE`` 是 1/3），这里要 0.5。
LINK_MIN_COVERAGE = 0.5

#: 「另见」那一行的前缀（``_with_links`` 与 ``_append_see_also`` 必须同一个）。
SEE_ALSO_PREFIX = "另见 "


def _append_see_also(existing: str, names: list[str]) -> str:
    """把 ``names`` 并进这份长期知识的「另见」那一行（没有就新起一行）。

    **并进已有的那一行**而不是再起一行：``_with_links`` 在写入时就会给一条
    「另见 A。」，``_append_dream`` 的更新节也可能以它收尾——一文件里堆出三行
    「另见」读起来像三份不同的文档拼在一起。

    只在**正文末尾**那一行上动（``## Sources`` 之前）：来源那一节是"这条从哪来的"，
    而「另见」是"还该看什么"，两者不是一回事。

    幂等：已经在那一行里的名字不会重复出现——重试（上一轮有一条没落盘时整批留到
    下一轮）因此是安全的。
    """
    clean = [name.strip() for name in names if name.strip()]
    if not clean:
        return existing
    marker = "\n## Sources"
    head, sep, tail = existing.partition(marker)
    lines = head.rstrip("\n").split("\n")
    # 从末尾往前找那一行「另见 …」：它可能是上一轮写下的，也可能在更新节里
    at = len(lines) - 1
    while at >= 0 and not lines[at].strip():
        at -= 1
    if at >= 0 and lines[at].strip().startswith(SEE_ALSO_PREFIX):
        known = re.findall(r"\[\[([^\]]+)\]\]", lines[at])
        fresh = [name for name in clean if name not in known]
        if not fresh:
            return existing
        merged = [*known, *fresh[:LINK_MAX]]
        lines[at] = SEE_ALSO_PREFIX + "、".join(f"[[{name}]]" for name in merged) + "。"
    else:
        fresh = clean[:LINK_MAX]
        lines.append(SEE_ALSO_PREFIX + "、".join(f"[[{name}]]" for name in fresh) + "。")
    rebuilt = "\n".join(lines)
    # ``sep`` 那一节连着它自己的空行与正文一起原样接回去：**来源那节的位置与格式
    # 不该因为补了一条链接而变**（它是机器维护的，用户也可能手改过）
    return f"{rebuilt}\n\n## Sources{tail}" if sep else f"{rebuilt}\n"


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
