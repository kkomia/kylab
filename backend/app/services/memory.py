"""长期记忆：**mem0 之上的本机事实库**（v0.57 起，档案制已被取代）。

**两个池子不能混**（这是本模块存在的第一条理由）：记忆是"你说的"（无出处、可改、
高频写），文档知识库是"文献说的"（有出处、不该被改、原文为王）。混进同一次检索，
引用会脏、溯源会断。所以记忆召回是独立的一路（工具上是 `recall`，与 `search` 分开），
结果永不合并——**两条路连索引都不共用**。

**这一层现在的形状**：

- **存储**（D1）：mem0（``mem0ai``）建在 ``<数据目录>/memory/<账号>/mem0/`` 下——
  qdrant 用 **path 本地模式**（进程内、sqlite 落盘、Windows 可跑）落 ``qdrant/``，
  历史落 ``history.db``。账号：本机主人（``user_id`` 为 ``None``）用字面量
  ``local``，成员用自己的 id。**一条记忆一条记录**，带 id（界面上按 id 改删）。
- **模型通道**（D2）：``memory_providers`` 把 mem0 的两个通道接到我们的模型注册表上
  ——对话走注册表的「对话生成」目标（**恒定关思考**），向量走「向量化」目标；
  **没配嵌入模型时退回开发用的确定性嵌入**（无语义的词面哈希），
  ``status().development`` 据此让界面说清"检索质量是兜底"。
- **写**（D3）：显式的 ``remember`` 用 ``infer=False``（零模型调用，原样入库），
  写前用 :func:`classify_action` 在 ``get_all(top_k=200)`` 上**机械查重**
  （保留 added/replaced/existing 三种回执）；打开 ``memory.infer`` 时改用
  ``infer=True``，由 mem0 自己抽取——那是这条链上**唯一会花钱的开关**。
  另一条自动写入路（`capture_implicit` / `memory.capture`）2026-10-09 **整族删除**：
  它当时已经没有任何生产调用者（问模型的那一跳没人触发），留着一个永远不跑的
  开关只会让人以为"记忆会自动记"。
- **注入**（D4）：每轮 ``get_all(top_k=200)`` **全量渲染** + 硬顶（``memory.inject_limit_chars``，
  默认 6000 字），**不做每轮 search**——挑选会引入一个"这轮该看哪几条"的判定，
  它既费模型，又让用户无法预测助手到底知道什么。
- **查**：``recall`` = mem0 的 ``search``（按意思查库），与知识库检索不合并；
  受 ``memory.enabled`` 门控（关着时**明确报错**，不返回空——返回空会让模型以为
  "没有相关记忆"，然后基于错误前提继续推理）。

**旧档案文件**（``PROFILE.md`` / ``changes.md`` / ``MEMORY.md``）**原地保留、一字不动**
（D11）：它们不再注入、不再写入，也不是记忆的本体。``POST /memory/import-legacy``
（:meth:`MemoryService.import_legacy`）把 ``PROFILE.md`` 四区条目**一次性**搬进新库，
水位落在 ``<账号>/mem0/imported.json``，可重跑且净改动为零。人设文件
（``SOUL.md`` / ``AGENTS.md``）**照旧每轮注入**，与记忆无关。

**这一层还剩哪些自研逻辑**（其余都交给 mem0 了）：机械查重、敏感信息否决、
按内容归区、回执文案、注入块的渲染与硬顶、**兜底嵌入下的字面过滤**
（:func:`_lexical_only`——兜底嵌入是词面哈希，没有语义，它给任意两段文本的相似度是
随机的，不加这道过滤就会出现"任何查询都翻得出几条"）。它们都在这个文件里，各自带理由。
"""

from __future__ import annotations

import gc
import json
import logging
import re
import shutil
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from app.core.exceptions import InvalidRequestError, NotFoundError
from app.services import memory_files, memory_migration, memory_providers
from app.services.embedding import build_embedder
from app.services.embedding.base import EmbeddingNotConfiguredError, EmbeddingProvider
from app.services.embedding.deterministic import DEFAULT_DEV_DIM, DeterministicEmbedder
from app.services.llm import ChatMessage, OpenAICompatChat
from app.services.runtime_config import RuntimeConfigService

__all__ = [
    "AGENTS_FILE",
    "DEFAULT_RECALL",
    "MAX_ENTRY_CHARS",
    "MAX_RECALL",
    "PERSONA_FILES",
    "PROFILE_FILE",
    "RECEIPT_ADDED",
    "RECEIPT_AMBIGUOUS",
    "RECEIPT_EXISTING",
    "RECEIPT_FORGOTTEN",
    "RECEIPT_MISSING",
    "RECEIPT_REPLACED",
    "RECEIPT_SENSITIVE",
    "RECEIPT_TOO_LONG",
    "RECEIPT_UNCHANGED",
    "SECTIONS",
    "SOUL_FILE",
    "SOURCE_EXPLICIT",
    "SOURCE_MIGRATION",
    "SOURCE_UI",
    "ImportReport",
    "ItemHistory",
    "Match",
    "MemoryItem",
    "MemoryService",
    "MemoryStatus",
    "WriteResult",
    "classify_action",
    "classify_text",
    "is_sensitive",
    "normalize_entry",
    "render_items",
]

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------- 文件

#: 人格文件（**仍每轮注入**，与记忆无关）。
SOUL_FILE = "SOUL.md"

#: 操作规程（SOP）。与 ``SOUL.md`` 并列的第二份人设文件。
AGENTS_FILE = "AGENTS.md"

#: **旧档案文件**（v0.56 的四区档案）。v0.57 起它不再是记忆本体：
#: 不再注入、不再写入，只作为 ``import-legacy`` 的迁移来源与界面上的一份只读原文
#: 留在盘上（D11：旧文件一字不动）。
PROFILE_FILE = "PROFILE.md"

#: 每轮注入 system prompt 的人设文件与固定顺序。
#:
#: ``memory.persona_files`` 那个运行期默认值（``"SOUL.md,AGENTS.md"``）住在
#: ``runtime_config.DEFAULTS`` 里，**两份都要改**：这里这份决定"没配时注入哪几份"
#: （:meth:`MemoryService.persona_order` 认不出来就回落到它），那份只决定设置页上
#: 输入框的初始文字。这里原先有一个 ``PERSONA_ORDER_DEFAULT`` 想把两者绑起来，
#: 但 ``runtime_config`` 不能反向 import 这个模块（会成环），于是它谁也没接到
#: ——2026-10-09 删掉。
PERSONA_FILES: tuple[tuple[str, str], ...] = (
    (SOUL_FILE, "人格"),
    (AGENTS_FILE, "操作规程"),
)

#: 本机主人那个账号的字面名（D1、D5）。mem0 的 ``user_id`` 与存储目录名都用它。
LOCAL_ACCOUNT = "local"

#: mem0 那一份存储在账号目录下的子目录：``<数据>/memory/<账号>/mem0/``（D1）。
MEM0_DIRNAME = "mem0"

#: 落盘记下"这个库是按几维建的"的那个小标记（与 qdrant/ 同级）。
#: **它是必须的**：向量维度只在建集合那一刻定死，而进程重启之后我们没有任何别的
#: 地方能知道它——不知道就会在用户换了一个不同维度的嵌入模型之后撞上
#: qdrant 的 ``Vector dimension error``（那是写入时才炸的错）。
STORE_MARKER = "store.json"

# --------------------------------------------------------------------- 取值口径

#: 一次注入 / 一次状态读数最多取几条（D4 的 ``get_all(top_k=200)``）。
MAX_ITEMS = 200

#: 一次召回最多取几条。
MAX_RECALL = 20
#: 默认取几条。
DEFAULT_RECALL = 6

#: ``remember`` 这条通道的**传输上限**（协议层与这里同源：``api/v1/schemas.py``
#: 的 ``MemoryRememberIn`` 直接引这个常量）。超过它属于笔记或知识库，
#: 让它在协议层就 422，别白读一遍再拒。
MAX_ENTRY_CHARS = 500

#: 一条记忆的来源标注（进 metadata，界面上做来源小字）。
SOURCE_EXPLICIT = "显式"
SOURCE_UI = "界面"
SOURCE_MIGRATION = "迁移"

# --------------------------------------------------------------------- 分区

SECTION_IDENTITY = "身份与称呼"
SECTION_PREFERENCES = "长期偏好与风格"
SECTION_PROJECTS = "进行中的项目"
SECTION_TOOLS = "工具与环境"

#: 四个分区的**固定顺序**：归区、渲染、注入都按它。
#:
#: 它现在是**metadata 里的一个标签**（mem0 没有分区这个概念），语义与档案制时期一致：
#: 条目按"说的是什么"归类，注入时按这个顺序排，用户看到的顺序 = 模型看到的顺序。
SECTIONS: tuple[str, ...] = (
    SECTION_IDENTITY,
    SECTION_PREFERENCES,
    SECTION_PROJECTS,
    SECTION_TOOLS,
)

# --------------------------------------------------------------------- 回执
#
# 只有一个来源（§4.4 那条纪律继续有效）：模型从工具听到的与人在界面上看到的
# **必须是同一句**。v0.57 改掉的两处措辞都因为原话已经不再成立：
# "可还原"——档案制的还原端点随变更流一起退场了，历史还在但没有一条写回的路。

RECEIPT_ADDED = "记下了：{text}"
RECEIPT_REPLACED = "改成：{text}（旧的留在历史里）"
RECEIPT_EXISTING = "记忆里已经有了：{text}"
RECEIPT_UNCHANGED = "没有新增：{text}（模型判定不用再记一遍）"
RECEIPT_SENSITIVE = "这条含密码、令牌、密钥或证件号这类信息，不进记忆。"
RECEIPT_TOO_LONG = "一条最多 {limit} 字（这条 {current} 字）。请拆成两条，或写进 AGENTS.md。"
RECEIPT_FORGOTTEN = "忘掉了：{text}。"
RECEIPT_MISSING = "记忆里没有这一条：{text}"
RECEIPT_AMBIGUOUS = "记忆里有 {count} 条对得上「{topic}」的：{items}。请把要忘掉的那条原样给我。"

# --------------------------------------------------------------------- 机械判据

#: 字符二元组重合度（Jaccard）下限。
DUP_SIMILARITY = 0.7
#: 兜底嵌入下，查询的二元组至少要有多少比例在条目里出现过才算"字面命中"
#: （见 ``_lexical_only``）。与旧实现那句"覆盖 ≥ 1/3 算命中"同一量级。
MIN_LEXICAL_COVERAGE = 1 / 3
#: 包含关系算同一件事时，长的那条最多能比短的多几个字。
CONTAINMENT_SLACK = 6

#: 动作常量（对外的 ``WriteResult.action`` 值）。
ACT_ADD = "add"
ACT_REPLACE = "replace"
ACT_EXISTING = "existing"

#: 比对用：去掉全部非字母数字（``\w`` 在 Python 3 里含汉字与下划线，下划线单独去掉）。
_NON_ALNUM = re.compile(r"[\W_]+", re.UNICODE)
#: 数字串。**"数字不同就不是同一件事"**这条否决靠它——版本号、地址、数量、日期都是数字。
_DIGIT_RUN = re.compile(r"\d+")
#: 条目行前面的记号（用户从旧档案里抄过来时可能带着）。
_BULLET = re.compile(r"^\s*(?:[-*+•]|\d+[.、)])\s*")

#: 敏感信息的**凭据词**：命中即否决。
#:
#: 宁可误伤一句"用户的密码策略是 12 位"（它讲的是策略，不是凭据），
#: 也不放一条真凭据进每轮注入的上下文——那是每轮都发出去的。
_SENSITIVE_WORDS: tuple[str, ...] = (
    "密码",
    "口令",
    "令牌",
    "密钥",
    "私钥",
    "passwd",
    "password",
    "secret",
    "token",
    "apikey",
    "api key",
    "api_key",
    "access key",
    "private key",
    "证件号",
    "身份证号",
    "护照号",
    "银行卡号",
    "信用卡号",
)
#: 敏感信息的**凭据形状**。
_SENSITIVE_SHAPES: tuple[re.Pattern[str], ...] = (
    # OpenAI 一族
    re.compile(r"\bsk-[A-Za-z0-9_-]{10,}"),
    # GitHub 令牌
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}"),
    # AWS access key id
    re.compile(r"\bAKIA[0-9A-Z]{12,}"),
    # 长十六进制串（私钥/摘要/哈希里最像凭据的那一类）
    re.compile(r"\b[A-Fa-f0-9]{32,}\b"),
    # 身份证号（15/18 位，末位可能是 X）
    re.compile(r"(?<!\d)\d{15,19}[Xx]?(?!\d)"),
)

# --------------------------------------------------------------------- 注入

#: **记忆块的两句边界话**（D4）。
#:
#: 为什么必须有：记忆条目**每轮整份进上下文**，而模型对"一整块关于对方的话"有两种典型
#: 误读——把它当**文献依据**引用（"根据记忆记载…"），或者把它当**这一轮的任务**
#: 逐条念出来。第一句挡住前者，第二句挡住后者。
#: 后两句守住"过时"与"缺失"：冲突以对方此刻为准；没写的就当不知道，不要为了补全去追问
#: （D26 实测：那份旧档案里写着「待确认」的字段，让模型每轮都去问"怎么称呼你"）。
_MEMORY_LEAD = (
    "以下是长期记忆里关于对方的事实条目：说的是对方是谁、他在意什么，不是文献依据；"
    "与当前问题无关时不要主动提它。\n"
    "记忆是过去写下的记录，与对方此刻所说的冲突时，以他此刻说的为准。\n"
    "记忆里没有的就当不知道：不要为了补全它去追问对方。"
)

#: 超限声明（D4）：**必须在提示词里说出来**。静默截断会让用户以为助手看到了全部记忆。
_MEMORY_TRUNCATED = "（记忆超出上限，以下为前 {count} 条；请到记忆页清理）"

#: **记忆指导**：告诉模型"这一层现在长什么样、什么时候用哪个工具"。
#:
#: 三件事必须说清（每一件都是"不说模型就会做错"的那种）：
#:
#: 1. **条目已经全量注入**了，不要再试图去"检索一遍"——那会白花一次调用，
#:    还会把同一段内容读两遍；
#: 2. **`recall` 是在库里按意思检索**（不再是"变更流"）：它用来找"哪一条里有那个说法"，
#:    而"没搜到"只有一个含义——库里确实没有相关的话；
#: 3. **更正是一次调用**（`replaces`），不是"先删再记"；一条只记一句，
#:    写不下的是 `AGENTS.md` 的内容。
#:
#: **只在启用时给出**（见 :meth:`MemoryService.guidance`）：关着时 `recall` 会明确
#: 报"未启用长期记忆"，还把它摆给模型看就是"每轮先查一次、再拿一句错误"。
_GUIDANCE = (
    "【长期记忆：怎么用】\n"
    "- 上面那些**记忆条目**是**全量**给你的，所以不必再去检索一遍——直接用；"
    "与当前问题无关时不必提。\n"
    "- 要长期留下一条事实时用 `remember`；**更正**旧条目就在同一次调用里带上 "
    "`replaces`（填你要改掉的那句原话，不要先删再记）；要忘掉某条用 `forget`。\n"
    "- `recall` 是在**记忆库里按意思检索**，用来找「哪一条里有那个说法」。"
    "它搜不到只有一个含义：库里确实没有相关的话。\n"
    "- **一条只记一句话**：成篇的内容属于 `AGENTS.md` 或笔记，不是记忆。\n"
    "- **绝不记**密码、令牌、密钥、证件号：记忆每轮都进上下文。"
)

#: **首次引导**那一段：库里一条记忆都没有时注入，让 Agent 先去认识对方。
#:
#: 判据（D4）是**"库里一条都没有"**（不再是"PROFILE.md 还是模板"）：Agent 一记下
#: 第一条，这一段下一轮自己就没了，不需要任何"用过就删"的簿记。
_BOOTSTRAP = (
    "【还没认识对方：这一轮该做一次开场】\n"
    "记忆库里**一条都没有**——也就是说「对方是谁」这件事你还没写下来。\n"
    "**这一轮就做这件事**，哪怕对方只是打了个招呼、或者只说了两个字。\n"
    "**不要用「我能做什么」开场**，也不要把你没被问到的能力列一遍"
    "（联网、笔记、工具、知识库这些）——那是自我介绍，不是认识人。\n"
    "**先看一眼已经知道的**（`recall` 可以查）：已经知道的那几件**别再问一遍**；"
    "剩下的**在你的回答里自然地问他**（不用一次问完，也别像填表）：\n"
    "- 他怎么称呼自己，以及他希望你怎么称呼他（→「身份与称呼」）；\n"
    "- 他在做什么、关心什么（→「进行中的项目」）；\n"
    "- 他希望你怎么说话（简洁还是详细、要不要先给结论）（→「长期偏好与风格」）。\n"
    "拿到答案之后：**一条一句用 `remember` 记下来**（`section` 给上面那个分区名；"
    "**只记他自己说过的**，别写你的推断）。"
    "**`SOUL.md` 与 `AGENTS.md` 是对方自己的东西，你不要去改**——"
    "想让你的性子或规矩变，就说出来让他决定。"
    "做完**告诉对方你记下了什么**——那是他的记忆，他该知道。\n"
    "只要库里还是空的，这一段每轮都会出现；写进第一条之后它自己就没了。"
)

# --------------------------------------------------------------------- 归区词表
#
# 它是启发式，不是判据：说错了只是分区标签不对，条目本身照样在库里、照样被注入。

_PROJECT_WORDS = (
    "项目",
    "目标",
    "交付",
    "需求",
    "方案",
    "计划",
    "在做",
    "正在做",
    "约束",
    "决定",
    "已经定",
    "里程碑",
    "排期",
    "上线",
    "评审",
    "背景",
)
_PREFERENCE_WORDS = (
    "偏好",
    "喜欢",
    "习惯",
    "风格",
    "要求",
    "不要",
    "不爱",
    "不写",
    "讨厌",
    "语气",
    "格式",
    "排版",
    "先给",
    "简短",
    "详细",
    "客套",
    "雷点",
    "忌讳",
    "必须",
    "尽量",
)
_TOOL_WORDS = (
    "工具",
    "环境",
    "机器",
    "系统",
    "路径",
    "目录",
    "服务器",
    "显卡",
    "显存",
    "部署",
    "版本",
    "软件",
    "命令行",
    "设备",
    "模型",
    "插件",
    "依赖",
    "python",
    "node",
    "docker",
    "windows",
    "linux",
    "mac",
    "nas",
    "内网",
)
_IDENTITY_WORDS = (
    "叫",
    "称呼",
    "名字",
    "代词",
    "语言",
    "中文",
    "英文",
    "角色",
    "身份",
    "单位",
    "团队",
    "公司",
    "所在",
)


def classify_text(text: str, *, default: str = SECTION_PREFERENCES) -> str:
    """按内容把一条记忆归到某一区。

    计分取最高；同分时按词表顺序（项目 > 偏好 > 工具 > 身份）定；
    一个词都没命中时落到 ``default``（偏好区——"长期事实"最像的默认位置）。
    """
    hay = (text or "").casefold()
    best = default
    best_score = 0
    for section, words in (
        (SECTION_PROJECTS, _PROJECT_WORDS),
        (SECTION_PREFERENCES, _PREFERENCE_WORDS),
        (SECTION_TOOLS, _TOOL_WORDS),
        (SECTION_IDENTITY, _IDENTITY_WORDS),
    ):
        score = sum(1 for word in words if word in hay)
        if score > best_score:
            best, best_score = section, score
    return best


# --------------------------------------------------------------------- 文本判据


def normalize_entry(text: str) -> str:
    """一条记忆的标准形：去掉条目记号、把空白折成一个空格。

    入口与比对都过它：界面上粘贴的文本常带 ``- `` 与换行，而"同一条"的判据
    必须落在折过之后的那串字上。
    """
    flat = _BULLET.sub("", (text or "").strip())
    return " ".join(flat.split())


def fingerprint(text: str) -> str:
    """只留字母数字并小写（**只差标点与空白**的两条算同一条）。"""
    return _NON_ALNUM.sub("", (text or "")).casefold()


def normalize(text: str) -> str:
    """更松的一层：去掉全部空白（包含关系比对用它）。"""
    return "".join((text or "").split()).casefold()


def digit_runs(text: str) -> tuple[str, ...]:
    """文本里的数字串（顺序保留）——**数字不同就不是同一件事**这条否决靠它。"""
    return tuple(_DIGIT_RUN.findall(text or ""))


def _grades(text: str) -> set[str]:
    """文本的字符二元组（短到只有一个字时就用它自己）。"""
    body = normalize(text)
    if len(body) < 2:
        return {body} if body else set()
    return {body[index : index + 2] for index in range(len(body) - 1)}


def _lexical_only(query: str, items: Sequence[MemoryItem]) -> list[MemoryItem]:
    """只留**字面重合**的那些条目（兜底嵌入下用，理由见 ``MemoryService._search``）。

    判据两条，满足一条就算：查询与条目**互相包含**，或者查询的二元组有
    ``MIN_LEXICAL_COVERAGE`` 以上在条目里出现过。与旧实现那套"二元组覆盖"同一量级——
    它的量级本来就不重要：这里要的是"筛掉随机相似的一堆"，不是"排出一个精确的名次"。
    """
    want = normalize(query)
    if not want:
        return []
    grams = _grades(want)
    out: list[MemoryItem] = []
    for item in items:
        body = normalize(item.text)
        if not body:
            continue
        if want in body or body in want:
            out.append(item)
            continue
        if not grams:
            continue
        if len(grams & _grades(body)) / len(grams) >= MIN_LEXICAL_COVERAGE:
            out.append(item)
    return out


def is_sensitive(text: str) -> bool:
    """这条能不能进记忆（False = 含敏感信息，绝不写）。"""
    body = text or ""
    low = body.casefold()
    if any(word in low for word in _SENSITIVE_WORDS):
        return True
    return any(shape.search(body) for shape in _SENSITIVE_SHAPES)


def _contains(shorter: str, longer: str) -> bool:
    """``shorter`` 整段出现在 ``longer`` 里，且两端落在词边界上。

    边界这条是给 ASCII 词留的：「代号叫 kylab」是「代号叫 kylab2 代」的子串，
    但那是另一个版本，不是同一件事。
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


def _bigram_similar(one: str, other: str) -> bool:
    """字符二元组重合度（Jaccard）够不够高。"""
    first, second = fingerprint(one), fingerprint(other)
    if len(first) < 2 or len(second) < 2:
        return False
    grams_first = {first[index : index + 2] for index in range(len(first) - 1)}
    grams_second = {second[index : index + 2] for index in range(len(second) - 1)}
    if not grams_first or not grams_second:
        return False
    return len(grams_first & grams_second) / len(grams_first | grams_second) >= DUP_SIMILARITY


# --------------------------------------------------------------------- 数据形状


@dataclass(frozen=True, slots=True)
class MemoryItem:
    """库里的一条记忆（mem0 的 item 在我们这一侧的形状）。"""

    id: str
    text: str
    section: str = ""
    source: str = ""
    created_at: str = ""
    updated_at: str = ""
    score: float | None = None
    """检索给出的相似度；``get_all`` 那条路是 ``None``。"""


@dataclass(frozen=True, slots=True)
class ItemHistory:
    """一条记忆的历史上的一步（mem0 的 history 行）。

    ``event`` 是 mem0 的原文（``ADD`` / ``UPDATE`` / ``DELETE``），``old`` 是这一步
    之前的值（``ADD`` 时为空）。**只读**：v0.57 没有"还原"这条路，
    历史留着是为了让人看清"这条以前是什么"。
    """

    at: str
    event: str
    old: str = ""
    new: str = ""
    deleted: bool = False


@dataclass(frozen=True, slots=True)
class MemoryStatus:
    """记忆层的当前状态，给界面用。

    **没有任何"连通性"字段**：记忆是我们自己进程内的一路存储，没有第二个进程可连，
    也就没有"连不上"这种状态。``development`` 报的是"向量是开发兜底"——
    界面据此说清检索质量不代表真实效果。
    """

    enabled: bool
    workspace: str
    items: int = 0
    last_changed_at: str = ""
    embedder: str = ""
    development: bool = False
    detail: str = ""
    legacy_import_available: bool = False
    """还有没有**没搬过**的旧 ``PROFILE.md`` 条目（见 :meth:`legacy_import_available`）。

    界面拿它决定"那条一次性的导入横幅要不要出现"——搬过之后就没有这个念头了。"""


@dataclass(frozen=True, slots=True)
class Match:
    """机械判据给出的定位结果。"""

    action: str
    """``add`` / ``replace`` / ``existing``。"""

    item: MemoryItem | None = None
    """``replace`` / ``existing`` 指向库里那一条。"""

    kept: str = ""
    """最终留在库里的文本。包含关系里是**更完整的那一条**。"""


@dataclass(frozen=True, slots=True)
class WriteResult:
    """一次写入的结果与回执。"""

    action: str
    """``added`` / ``replaced`` / ``existing`` / ``rejected`` / ``forgotten``。"""

    receipt: str
    text: str = ""
    section: str = ""
    replaced: str = ""
    reason: str = ""
    """``sensitive`` / ``single`` / ``missing`` / ``ambiguous``。"""

    item_id: str = ""


@dataclass(frozen=True, slots=True)
class ImportReport:
    """一次 ``import-legacy`` 的计数。"""

    source: str = ""
    entries: int = 0
    """旧档案里读到几条候选。"""

    imported: int = 0
    existing: int = 0
    dropped_sensitive: int = 0
    skipped: bool = False
    """没有新东西可搬（源指纹与水位一致）——此时净改动为零。"""

    changed: bool = False


# --------------------------------------------------------------------- 判据实现


def classify_action(new_text: str, existing: Sequence[MemoryItem]) -> Match:
    """新条目相对现有记忆该做什么。

    顺序很重要：

    1. **指纹相同**（只差标点空白）→ 已存在，不写；
    2. **数字集合不同**的那一条直接跳过——版本号、地址、数量、日期是唯一能机械区分
       "同一个东西"与"两个东西"的证据，这条否决一个字都不放松；
    3. 包含且差值 ≤ 6 字 → 顶替：**留下更完整的那一条**。若库里那条更长，
       新条目并没有补上信息，按"已存在"回执；
    4. 二元组重合 ≥ 0.7 → 顶替；
    5. 其余 → 新增。
    """
    new_fp = fingerprint(new_text)
    if not new_fp:
        return Match(ACT_ADD, kept=new_text)
    for item in existing:
        if fingerprint(item.text) == new_fp:
            return Match(ACT_EXISTING, item=item, kept=item.text)

    new_digits = digit_runs(new_text)
    new_loose = normalize(new_text)
    for item in existing:
        if digit_runs(item.text) != new_digits:
            continue
        entry_loose = normalize(item.text)
        shorter, longer = sorted((new_loose, entry_loose), key=len)
        if shorter and len(longer) - len(shorter) <= CONTAINMENT_SLACK and _contains(
            shorter, longer
        ):
            if len(new_loose) >= len(entry_loose):
                return Match(ACT_REPLACE, item=item, kept=new_text)
            return Match(ACT_EXISTING, item=item, kept=item.text)
    for item in existing:
        if digit_runs(item.text) != new_digits:
            continue
        if _bigram_similar(new_text, item.text):
            return Match(ACT_REPLACE, item=item, kept=new_text)
    return Match(ACT_ADD, kept=new_text)


def _ordered(items: Sequence[MemoryItem]) -> list[MemoryItem]:
    """条目按**注入顺序**排好：四个固定分区在前、未知分区其次、没有标签的最后。

    **没有标签的不能丢**：自动捕获写进来的条目不带分区（抽取发生在入库那一刻，
    那时还不知道该归哪一区），把它们排到最后而不是漏掉它们——注入块少一条，
    用户就会看到助手"忘了"一件事。
    """
    order = [
        *SECTIONS,
        *(name for name in _sections_of(items) if name and name not in SECTIONS),
        "",
    ]
    return [item for name in order for item in items if (item.section or "") == name]


def _sections_of(items: Sequence[MemoryItem]) -> list[str]:
    """这批条目里出现过的分区名（保序、去重）。"""
    seen: list[str] = []
    for item in items:
        name = item.section or ""
        if name and name not in seen:
            seen.append(name)
    return seen


def render_items(items: Sequence[MemoryItem], *, with_ids: bool = False) -> str:
    """若干条目 → 注入 / 展示用的正文（分区标题 + 条目行）。

    ``with_ids`` 给 ``read_memory`` 那条路用：它要让模型能**指出具体哪一条**
    （改、删都按 id 走）。注入块**不带 id**——一行的 id 是 36 个字符，
    200 条就是七千字，换来的是每轮都发出去的成本。
    """
    blocks: list[str] = []
    current: str | None = None
    lines: list[str] = []
    for item in _ordered(items):
        name = item.section or ""
        if name != current:
            if lines:
                blocks.append(_section_block(current or "", lines))
            current, lines = name, []
        lines.append(f"- [{item.id}] {item.text}" if with_ids else f"- {item.text}")
    if lines:
        blocks.append(_section_block(current or "", lines))
    return "\n\n".join(blocks)


def _section_block(name: str, lines: Sequence[str]) -> str:
    return f"{'## ' + name if name else '## 未分区'}\n" + "\n".join(lines)


def _fitted_body(items: Sequence[MemoryItem], limit: int) -> tuple[str, int]:
    """装到**装不下为止**，返回 ``(正文, 装进的条数)``。

    逐条加、每次重算一遍正文：条数最多两百条，而"哪几条装得下"这件事必须与真正的
    渲染**同一口径**去数——估算字数（比如按行累加）迟早与渲染漂开，
    漂开的表现是"提示词里说前 N 条，实际给了前 N-3 条"。
    """
    ordered = _ordered(items)
    body = ""
    kept = 0
    for index in range(1, len(ordered) + 1):
        candidate = render_items(ordered[:index])
        if len(candidate) > limit:
            break
        body, kept = candidate, index
    return body, kept


def _item_of(raw: Any, *, score: float | None = None) -> MemoryItem:
    """mem0 的 item（dict 或对象）→ :class:`MemoryItem`。

    metadata 只认我们写的两个键（``section`` / ``source``）；别的（用户从别处导入的）
    照旧留在库里，只是不往界面上搬。

    **没有 ``section`` 时按内容补一个标签**：自动捕获（``infer=True``）是 mem0 在
    入库那一刻抽取的，那时还不知道该归哪一区，于是库里那一条的 metadata 里就是空的。
    读取时补出来的这个标签**只用来看**（渲染、排序、界面上的小字），库里那个字段
    仍然空着——为它多写一次 ``update`` 会在历史里留下一条"内容没变的 UPDATE"，
    那比一个显示用的标签更让人困惑。
    """
    meta = _field(raw, "metadata") or {}
    if not isinstance(meta, dict):
        meta = {}
    text = str(_field(raw, "memory") or "")
    section = str(meta.get("section") or "")
    return MemoryItem(
        id=str(_field(raw, "id") or ""),
        text=text,
        section=section or (classify_text(text) if text else ""),
        source=str(meta.get("source") or ""),
        created_at=str(_field(raw, "created_at") or ""),
        updated_at=str(_field(raw, "updated_at") or ""),
        score=score if score is not None else _as_float(_field(raw, "score")),
    )


def _field(raw: Any, name: str) -> Any:
    """从 dict 或对象上取一个字段（mem0 两个形状都会出现）。"""
    if isinstance(raw, dict):
        return raw.get(name)
    return getattr(raw, name, None)


def _as_float(value: Any) -> float | None:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------- 服务


class MemoryService:
    """mem0 之上的门面：开关、注入、四条读写路、模型通道、迁移。

    **实例是进程级的懒加载单例**（``_INSTANCES``）：qdrant 本地模式在**同一个
    path 上只允许一个实例**（文件锁，第二个会抛 ``RuntimeError``），而 mem0 的
    ``Memory`` 每次构造都会打开一次那个 path。缓存键是 ``(存储目录, 通道 key)``
    ——存储目录里带着账号，通道 key 里带着模型与维度，所以"换了账号 / 换了模型"
    自然会建一个新的。
    """

    def __init__(
        self,
        runtime: RuntimeConfigService,
        data_dir: Path,
        *,
        ask: Callable[[list[ChatMessage]], str] | None = None,
    ) -> None:
        self._runtime = runtime
        self._data_dir = data_dir
        #: 问模型的能力（可选）：不给就用运行期配置里绑定的对话模型。
        #: 用例注入它来跑 `memory.infer`（抽取那条路），不必真连一个模型。
        self._ask = ask

    # ------------------------------------------------------------------ 配置

    @property
    def enabled(self) -> bool:
        return self._runtime.get_bool("memory.enabled")
    @property
    def inject_limit(self) -> int:
        """注入硬顶（``memory.inject_limit_chars``，默认 6000 字）。"""
        return self._runtime.get_int("memory.inject_limit_chars") or 6000

    @property
    def search_top_k(self) -> int:
        """一次检索默认取几条（``memory.search_top_k``，默认 8）。"""
        return self._runtime.get_int("memory.search_top_k") or 8

    def account(self, user_id: str | None = None) -> str:
        """这个调用者对应的**账号名**（= mem0 的 ``user_id``）。

        本机主人（``None``：管理员档 / 桌面壳）用字面量 ``local``（D1、D5）。
        """
        return (user_id or "").strip() or LOCAL_ACCOUNT

    def workspace_for(self, user_id: str | None = None) -> Path:
        """某个账号的**人设文件**工作区（``SOUL.md`` / ``AGENTS.md`` / 旧档案）。

        **共享桶刻意就是老路径本身**（``data/memory/``）：本机主人升级前后路径一字不变，
        已有的 ``SOUL.md`` / ``PROFILE.md`` 原地继续用——升级不该让一个人的东西"消失"。
        """
        raw = (self._runtime.get("memory.workspace") or "memory").strip()
        base = self._data_dir / raw
        return base / user_id if user_id else base

    @property
    def workspace(self) -> Path:
        return self.workspace_for(None)

    def memory_dir(self, user_id: str | None = None) -> Path:
        """这个账号的**记忆存储**目录（``<数据>/memory/<账号>/``，D1）。

        与本机主人的 ``workspace_for(None)`` 差一层：人设文件在 ``data/memory/`` 根下
        （老路径），而记忆存储在 ``data/memory/local/`` 里（账号名是 ``local``）。
        成员账号两者同层：``data/memory/<id>/``。
        """
        return (self._data_dir / (self._runtime.get("memory.workspace") or "memory").strip()) / (
            self.account(user_id)
        )

    def _require_enabled(self) -> None:
        """**注入与 recall** 的那道闸。

        报错文案里**不提任何服务**：本地实现没有"要去把某个进程拉起来"这回事，
        能做的动作只有一件——去设置里打开它。

        **记忆的读写不看这道闸**：关着时它照样可以被 `remember`/`forget` 改、
        也可以在记忆页上编辑（"关了也能改自己的东西"这条纪律保留）。这道闸管的
        只是另一半——它进不进这一轮的上下文、`recall` 能不能用。
        """
        if not self.enabled:
            raise InvalidRequestError(
                "未启用长期记忆。请在「设置 → 长期记忆」里打开（在记忆页可以直接打开）"
            )

    # ------------------------------------------------------- 模型通道与实例

    def _channel(self, root: Path) -> memory_providers.Channel:
        """这一轮用哪条模型通道（D2）。

        **通道 key 只认存储落点**（不是模型）：mem0 的 ``Memory`` 只在构造那一刻读
        llm / embedder，而 provider 是**按 key 现查**通道表的 —— 所以同一个 store
        永远配同一个 key，"用户在设置里换了模型"下一次访问就生效，
        **不必（也不能）重建实例**：qdrant 的本地模式在同一个 path 上只允许一个实例。
        """
        chat, _chat_model = self._chat()
        embedder, development = self._embedder()
        return memory_providers.Channel(
            key=f"kylab:{root}",
            chat=chat,
            embedder=embedder,
            dim=embedder.dim,
            development=development,
        )

    def _chat(self) -> tuple[Callable[[Sequence[ChatMessage]], str], str]:
        """对话通道：注入的 ``ask``，或者注册表里绑定的「对话生成」模型。

        **关掉思考**（``enable_thinking=False``）：``llm.py`` 的模块注释里就写着这条
        ——抽取类任务要显式关。实测（真模型 + 真数据，2026-09-27）开着思考时模型的
        **推理过程会混进正文**：那次的输出里中英文夹着"等等，第二个条目没有内容，
        不应该输出…Let me reconsider"，于是解析器只认得出半条。记忆与抽取不是推理题。

        **没配模型时**返回的是一个"到用的时候才报错"的闭包，**不在这里抛**：
        读、写（``infer=False``）、注入这三条路一个字都不问模型，而它们全都要先建
        mem0 实例（实例要一个 LLM 对象）。在这里抛的后果是"没配对话模型 = 记忆页打不开"，
        那件事与记忆一点关系都没有；真正需要模型的那两条（``infer=True``）在调用时
        拿到同一句可读错误。
        """
        if self._ask is not None:
            return (lambda messages: self._ask(list(messages))), "injected"
        config = self._runtime.llm()
        model_id = config.model_id if config.is_configured else ""

        def complete(messages: list[ChatMessage] | Sequence[ChatMessage]) -> str:
            current = self._runtime.llm()
            if not current.is_configured:
                raise InvalidRequestError(
                    "没有可用的对话模型，自动记忆需要一个能用的模型（设置 → 模型注册）"
                )
            return OpenAICompatChat(_without_thinking(current)).complete(list(messages))

        return complete, model_id

    def _embedder(self) -> tuple[EmbeddingProvider, bool]:
        """向量通道：注册表登记的嵌入模型；**没配时退回开发用确定性嵌入**（D2）。

        退回是刻意的：没有它，"没配嵌入模型"就等于"记忆完全不能用"，
        而记忆的**写入与原文读取**本来不依赖语义检索。代价是检索只反映词面重合，
        所以 ``is_development`` 一路报到界面上，让用户知道这是兜底而不是效果。
        """
        try:
            provider = build_embedder(self._runtime)
        except EmbeddingNotConfiguredError:
            return DeterministicEmbedder(dim=DEFAULT_DEV_DIM), True
        return provider, bool(provider.is_development)

    def _memory(self, user_id: str | None = None) -> Any:
        """这个账号的 mem0 实例（**进程级懒加载单例**，见类文档字符串）。

        **建实例同时是"打开一次本地 qdrant"**：同一个 path 在一个进程里只能有一个
        （第二个会抛 ``RuntimeError``），所以缓存键是**存储落点**、不能每次现建。

        **维度变了要重嵌**（见 :meth:`_Store.reembed`）：qdrant 的向量维度是**建集合
        时定死的**，换了另一个维度的嵌入模型之后往里写会直接抛
        ``ValueError: Vector dimension error``。而"新装没配嵌入模型（走 256 维兜底）
        → 后来配了一个 1024 维的模型"恰恰是最常见的一条演进路径，所以这里必须处理它，
        不能让记忆页在那一天变成一片报错。

        判据只有一处：``store.dim != channel.dim``。而 ``store.dim`` 的来源有三种
        （见 :func:`_disk_dim`）——**标记读得出来就用标记；全新库（磁盘上还没集合）
        就等于本轮这条通道；标记读不出来而集合在，按"不知道"（0）算**，
        于是下面那一判必然成立、会重嵌一次把维度对齐。最后一种是最容易写错的：
        拿"本轮算出来的维"去顶替"不知道"，判等成立、重嵌被跳过，
        而磁盘上那个集合还是旧维度——写第一条时就炸。

        每一次访问都**重新登记通道**：provider 是按通道 key 现查的，
        所以"用户在设置里换了模型"下一次访问就生效。
        """
        root = self.memory_dir(user_id) / MEM0_DIRNAME
        channel = self._channel(root)
        account = self.account(user_id)
        recorded = _recorded_dim(root)
        with _INSTANCE_LOCK:
            store = _INSTANCES.get(str(root))
            if store is None:
                root.mkdir(parents=True, exist_ok=True)
                store = _Store(
                    root=root,
                    memory=_build(root, channel),
                    dim=_disk_dim(root, recorded, channel.dim),
                )
                _INSTANCES[str(root)] = store
            if store.dim != channel.dim:
                store.reembed(channel, account)
                _remember_dim(root, channel.dim)
            else:
                memory_providers.register_channel(channel)
                # **新建实例那次要把维度落盘**：标记是跨进程唯一能知道"这个集合按几维建的"
                # 的地方，只在重嵌那条路上写的话，全新库永远没有标记——
                # 下一次进程起来读回 0，上面那条判据就失去了它唯一的证据。
                if not recorded:
                    _remember_dim(root, store.dim)
            return _INSTANCES[str(root)].memory

    def _filters(self, user_id: str | None) -> dict[str, str]:
        """**每次调用都必须带实体 filter**：mem0 不带就抛 ``ValueError``。"""
        return {"user_id": self.account(user_id)}

    def _lock(self) -> threading.RLock:
        """写操作的进程内互斥。

        qdrant 的本地模式**没有线程锁**（``qdrant_client/local/`` 里只有跨进程的
        文件锁），而 FastAPI 的同步端点跑在线程池里 —— 两个请求同时写同一个集合
        是我们不该赌的一件事。读不加锁：它不改变存储。
        """
        return _WRITE_LOCK

    def all_items(self, user_id: str | None = None) -> list[MemoryItem]:
        """库里最多 ``MAX_ITEMS`` 条（注入、状态、查重、界面列表共用这一处）。"""
        raw = self._memory(user_id).get_all(filters=self._filters(user_id), top_k=MAX_ITEMS)
        return [_item_of(item) for item in (raw or {}).get("results") or []]

    # ------------------------------------------------------------------ 注入

    def memory_block(self, user_id: str | None = None) -> str:
        """要注入 system prompt 的**记忆块**；关着或库空时是空串。

        **判在服务层**：它每轮现读现拼、带边界说明、超限自己声明——提示词那一层
        只负责把它放到人设那一档后面。

        **出错时返回空串并记日志**（而不是抛）:这条路每轮都跑，一次存储抖动不该让
        整轮对话失败；而"记忆是空的"这个后果是可见的（用户会发现助手忘了事），
        比"这一轮直接报错"可回退。**`recall` 那条路不这样**——它是一次显式动作，
        必须如实报错（见 :meth:`recall`）。
        """
        if not self.enabled:
            return ""
        try:
            items = self.all_items(user_id)
        except Exception:
            logger.warning("记忆注入块拼装失败，这一轮不带记忆", exc_info=True)
            return ""
        if not items:
            return ""
        body, kept = _fitted_body(items, self.inject_limit)
        if not kept:
            return ""
        if kept < len(items):
            notice = _MEMORY_TRUNCATED.format(count=kept)
            return f"{_MEMORY_LEAD}\n{notice}\n\n{body}"
        return f"{_MEMORY_LEAD}\n\n{body}"

    def guidance(self) -> str:
        """要注入 system prompt 的「长期记忆：怎么用」那一段；**未启用时是空串**。

        空串而不是"关着时也说明一下"：关着时 ``recall`` 会明确报错，把"什么时候
        该去查"讲给模型听，只会换来每轮一次无效调用加一句错误。
        """
        return _GUIDANCE if self.enabled else ""

    def bootstrap_block(self, user_id: str | None = None) -> str:
        """首次引导那一段；库里已经有记忆时是空串（判据见 :data:`_BOOTSTRAP`）。

        **不看 ``memory.enabled``**：记忆的编辑本来就不受那道闸管
        ——"你还不认识对方"与"记忆进不进这一轮的上下文"是两回事，
        把它挂在开关上会让关着记忆的实例永远不做引导。

        与 :meth:`memory_block` 同一条纪律：读不到库时返回空串（引导少一轮没关系，
        对话不能因此失败）。
        """
        try:
            if self.all_items(user_id):
                return ""
        except Exception:
            logger.warning("首次引导的判据读不到记忆库，这一轮不引导", exc_info=True)
            return ""
        return _BOOTSTRAP

    # ------------------------------------------------------------------ 读

    def list_items(
        self, user_id: str | None = None, *, query: str = "", limit: int | None = None
    ) -> list[MemoryItem]:
        """界面上的条目列表：给了 ``query`` 就在库里检索，否则列全部（按改动时间倒序）。

        列全部时**排序在我们这一侧做**：mem0 的 ``get_all`` 没有承诺顺序，
        而界面上"最近改的在前"是用户能预期的唯一一种顺序。

        带 ``query`` 时与 :meth:`recall` 共用 :meth:`_recall_checked`（**那道闸不做第二份**：
        关着记忆时搜索框照样能查，就等于"关着就不查"这句承诺是假的），**上限不同**：
        这一条是**界面**要一屏，跟接口层对齐到 ``MAX_ITEMS``（`MAX_ITEMS_PAGE` 同值）；
        ``recall`` 那一侧是**工具与模型**在用，收在 ``MAX_RECALL``。
        以前这里借 ``recall`` 走，于是接口声明 ``limit≤200``、实际 20 就被悄悄夹住。
        """
        text = (query or "").strip()
        if text:
            return self._recall_checked(
                text,
                limit=_clamp(limit or self.search_top_k, 1, MAX_ITEMS),
                user_id=user_id,
            )
        items = self.all_items(user_id)
        return sorted(items, key=lambda item: item.updated_at or item.created_at, reverse=True)

    def recall(
        self, query: str, *, limit: int | None = None, user_id: str | None = None
    ) -> list[MemoryItem]:
        """在记忆库里按意思检索（mem0 的 ``search``）——**工具那一侧的唯一入口**。

        **与知识库检索是两条路、永不合并**——连索引都不共用。

        **关着时明确报错，不返回空**：返回空会让模型（和用户）以为"没有相关记忆"，
        然后基于错误前提继续。开着而真的没有相关条目时，返回空列表才是诚实的答案
        （那时检索确实跑过了）。

        条数上限 ``MAX_RECALL``（与 ``tools.py`` 那份 schema 的 ``maximum`` 同源）：
        模型一次要几十条不是"检索"，是"把库搬进上下文"。
        """
        return self._recall_checked(
            query, limit=_clamp(limit or DEFAULT_RECALL, 1, MAX_RECALL), user_id=user_id
        )

    def _recall_checked(
        self, query: str, *, limit: int, user_id: str | None
    ) -> list[MemoryItem]:
        """检索的共用内核：**那道闸与"空查询"这条检查只写一份**（两个入口共用）。

        ``limit`` 由调用方先夹好——两条路的上限本来就不同（见两个调用点的说明），
        把上限也收进这里，就得再传一次"这一次是哪条路"。
        """
        self._require_enabled()
        text = (query or "").strip()
        if not text:
            raise InvalidRequestError("缺少参数：query")
        return self._search(text, limit, user_id)

    def _search(self, query: str, count: int, user_id: str | None) -> list[MemoryItem]:
        """mem0 的 ``search``，外加**兜底嵌入下的一道字面过滤**（见下）。

        **为什么要那道过滤**：兜底嵌入（开发用的词面哈希）**没有语义**，它给任意两段
        文本的相似度是随机的——实测（2026-10-09）"不相干的一句话"对
        "用户的内网有一台 L20" 拿 0.29 分，而 mem0 的默认阈值是 0.1。
        于是"没搜到"这件事在兜底配置下**永远不成立**：库里只要有一条，任何查询都能
        翻出它几条。那比"搜不到"更糟——用户会把噪声当结论。

        所以这一档下**只留字面重合的**（二元组覆盖 ≥ 1/3，与旧实现那套判据同一量级），
        与界面上那句"检索走的是开发兜底（只按字面重合）"逐字对齐：
        说什么就做什么，而不是"用向量搜、结果按运气给"。

        配了真的嵌入模型之后这道过滤**不生效**——那时语义相似度是可信的，
        拦它反而会把"换了个说法"的合法命中丢掉。
        """
        raw = self._memory(user_id).search(query, top_k=count, filters=self._filters(user_id))
        items = [_item_of(item) for item in (raw or {}).get("results") or []]
        items = [item for item in items if item.text]
        _provider, development = self._embedder()
        return _lexical_only(query, items) if development else items

    def get_item(self, item_id: str, user_id: str | None = None) -> MemoryItem | None:
        """按 id 取一条；没有就返回 ``None``（调用方决定报什么错）。"""
        try:
            raw = self._memory(user_id).get(item_id)
        except Exception:
            return None
        if raw is None:
            return None
        parsed = _item_of(raw)
        return parsed if parsed.text else None

    def item_history(self, item_id: str, user_id: str | None = None) -> list[ItemHistory]:
        """一条记忆的历史（mem0 自己的 ``history.db``），**最旧在前**。"""
        try:
            rows = self._memory(user_id).history(item_id) or []
        except Exception as exc:
            raise InvalidRequestError(f"读不到这条记忆的历史：{item_id}") from exc
        return [
            ItemHistory(
                at=str(_field(row, "updated_at") or _field(row, "created_at") or ""),
                event=str(_field(row, "event") or ""),
                old=str(_field(row, "old_memory") or ""),
                new=str(_field(row, "new_memory") or ""),
                deleted=bool(_field(row, "is_deleted")),
            )
            for row in rows
        ]

    # ------------------------------------------------------------------ 写

    def remember(
        self,
        content: str,
        *,
        section: str = "",
        replaces: str | None = None,
        source: str = SOURCE_EXPLICIT,
        user_id: str | None = None,
    ) -> WriteResult:
        """新增或顶替一条（**显式那条路，零额外模型调用**，D3）。

        - ``section`` 留空或不认识时**按内容机械归区**（词表见 :func:`classify_text`）：
          分区标签不该成为一次写入失败的原因；
        - ``replaces`` 是"更正一次完成"的入口：它指哪条就改哪条（mem0 的 ``update``，
          历史里留痕），找不到时退回机械判据——指错了不该让这一轮直接失败；
        - **不看 ``memory.enabled``**：关着时照样可写（写进去的下一轮不会被注入，
          打开就都在），这道闸只挡住"注入与 recall"；
        - 返回 :class:`WriteResult`：``action`` 四种（added/replaced/existing/rejected）
          与 ``receipt`` 就是那一份文案——**模型从工具听到的与人在界面上看到的
          是同一句**。

        **``memory.infer`` 默认关**（D3）：关着时走的是上面这条路。打开之后这一次
        写入交给 mem0 的抽取（它会问一次模型，并按语义去重），回执变成"模型抽出来的
        那几条"——那是给"换个说法说同一件事也要认出来"准备的，代价是每写一条都花钱。
        """
        text = normalize_entry(content)
        if not text:
            raise InvalidRequestError("缺少参数：content")
        if len(text) > MAX_ENTRY_CHARS:
            return WriteResult(
                action="rejected",
                receipt=RECEIPT_TOO_LONG.format(limit=MAX_ENTRY_CHARS, current=len(text)),
                text=text,
            )
        if is_sensitive(text):
            return WriteResult(
                action="rejected", receipt=RECEIPT_SENSITIVE, text=text, reason="sensitive"
            )
        target = (section or "").strip()
        if target not in SECTIONS:
            target = classify_text(text)

        if self._runtime.get_bool("memory.infer"):
            return self._infer(text, target, source, user_id)

        items = self.all_items(user_id)
        if replaces:
            hit = _locate(items, normalize_entry(replaces))
            if hit is not None:
                return self._replace(hit, text, target, source, user_id)

        match = classify_action(text, items)
        if match.action == ACT_EXISTING and match.item is not None:
            return WriteResult(
                action="existing",
                receipt=RECEIPT_EXISTING.format(text=match.kept),
                text=match.kept,
                section=match.item.section,
                item_id=match.item.id,
            )
        if match.action == ACT_REPLACE and match.item is not None:
            return self._replace(match.item, text, target, source, user_id)
        return self._add(text, target, source, user_id)

    def _infer(
        self, text: str, section: str, source: str, user_id: str | None
    ) -> WriteResult:
        """``memory.infer`` 打开时那条路：交给 mem0 的抽取 + 语义去重（**会花钱**）。

        与我们自己那条路（``infer=False`` + ``classify_action``）的差别只有一处：
        它能认出"换个说法说同一件事"（那是语义，机械判据够不着）。代价是这一次写入
        要问一次模型，而且**落库的是模型抽出来的那几句**——所以它默认关（D3）。

        抽取回来一条都没有：mem0 判定"不用新增"（它自己的语义去重），按 ``existing``
        回执。文案**不说"已经有了"**——那是在替它断言一件我们并不知道的事
        （它也可能只是没抽出可用的内容），所以只说"没有新增"。

        **"一条都没有"有两种成因，回执不能混**：mem0 判定不用记（上面那句），
        与"抽出来的那些全被判成了凭据、我们没让它进库"。后者是**否决**，不是"没有新增"
        ——说成后者等于把"我们拦下了一条密码"讲成"模型觉得不用记"，
        用户既不知道丢了什么、也不知道该不该再试。所以那一种走 ``rejected`` +
        既有那句 ``RECEIPT_SENSITIVE``（与 `remember` 同一条口径）。
        """
        with self._lock():
            raw = self._extract(
                [{"role": "user", "content": text}],
                metadata={"section": section, "source": source},
                user_id=user_id,
            )
        written: list[str] = []
        first_id = ""
        blocked = 0
        for item in (raw or {}).get("results") or []:
            body = normalize_entry(str(_field(item, "memory") or ""))
            if not body or str(_field(item, "event") or "").upper() == "NONE":
                continue
            if is_sensitive(body):
                blocked += 1
                continue
            written.append(body)
            first_id = first_id or str(_field(item, "id") or "")
        if not written:
            if blocked:
                return WriteResult(
                    action="rejected",
                    receipt=RECEIPT_SENSITIVE,
                    text=text,
                    section=section,
                    reason="sensitive",
                )
            return WriteResult(
                action="existing",
                receipt=RECEIPT_UNCHANGED.format(text=text),
                text=text,
                section=section,
            )
        receipts = [RECEIPT_ADDED.format(text=body) for body in written]
        if blocked:
            receipts.append(RECEIPT_SENSITIVE)
        return WriteResult(
            action="added",
            receipt="；".join(receipts),
            text="；".join(written),
            section=section,
            item_id=first_id,
        )

    def _extract(
        self,
        messages: list[dict[str, str]],
        *,
        metadata: dict[str, str],
        user_id: str | None,
    ) -> Any:
        """跑一次 mem0 的 ``infer=True``（**会问模型**），并把它抛的异常收成可读的那一种。

        mem0 失败时抛的是它自己的 ``LLMError``（里面才是我们那句"没有可用的对话模型"）：
        把 mem0 的异常类型漏给上层，等于让"记忆没配模型"这件事以 500 的形式露出来。
        这里统一折成 ``InvalidRequestError``，**原话保留**。
        """
        try:
            return self._memory(user_id).add(
                messages,
                user_id=self.account(user_id),
                metadata=metadata,
                infer=True,
            )
        except InvalidRequestError:
            raise
        except Exception as exc:
            raise InvalidRequestError(
                f"这一次要让模型判断该记什么，但没跑成：{exc}"
            ) from exc

    def _replace(
        self,
        item: MemoryItem,
        text: str,
        section: str,
        source: str,
        user_id: str | None,
    ) -> WriteResult:
        """把一条改成新文本（mem0 的 ``update``：id 不变、历史留痕）。"""
        with self._lock():
            self._memory(user_id).update(
                item.id,
                text=text,
                metadata={"section": section, "source": source},
            )
        return WriteResult(
            action="replaced",
            receipt=RECEIPT_REPLACED.format(text=text),
            text=text,
            section=section,
            replaced=item.text,
            item_id=item.id,
        )

    def _add(
        self, text: str, section: str, source: str, user_id: str | None
    ) -> WriteResult:
        """原样落库（``infer=False``：**不经过任何模型**）。

        ``infer=False`` 是 D3 的决定：显式这条路的查重由我们自己做（写前
        ``classify_action``），比让 mem0 再问一次模型便宜得多，也不会把"用户明确要求
        记住的一句话"改写成模型自己的说法。
        """
        with self._lock():
            raw = self._memory(user_id).add(
                [{"role": "user", "content": text}],
                user_id=self.account(user_id),
                metadata={"section": section, "source": source},
                infer=False,
            )
        return WriteResult(
            action="added",
            receipt=RECEIPT_ADDED.format(text=text),
            text=text,
            section=section,
            item_id=_first_id(raw),
        )

    def forget(self, topic: str, *, user_id: str | None = None) -> WriteResult:
        """忘掉一条：删掉 + 历史留痕。同样不看开关。

        ``topic`` 先按**原样**找（指纹/归一化相等），找不到再按**唯一子串**兜一次：
        调这个工具的模型手里有整份记忆，多数时候能原样抄出那一条；但用户说
        "忘掉那条关于 NAS 的"时，模型给的多半是半句话。

        **对得上不止一条时不猜**：宁可回执列出候选让它说清，也不删错一条——
        删错的代价（一条真事实没了）与多问一句完全不对等。
        """
        clean = normalize_entry(topic)
        if not clean:
            raise InvalidRequestError("缺少参数：topic")
        items = self.all_items(user_id)
        index = _index_of(items, clean)
        if index is None:
            candidates = _candidates(items, clean)
            if len(candidates) > 1:
                listed = "、".join(f"「{items[item].text}」" for item in candidates[:5])
                return WriteResult(
                    action="rejected",
                    receipt=RECEIPT_AMBIGUOUS.format(
                        count=len(candidates), topic=clean, items=listed
                    ),
                    text=clean,
                    reason="ambiguous",
                )
            index = candidates[0] if candidates else None
        if index is None:
            return WriteResult(
                action="rejected",
                receipt=RECEIPT_MISSING.format(text=clean),
                text=clean,
                reason="missing",
            )
        item = items[index]
        self.delete_item(item.id, user_id=user_id)
        return WriteResult(
            action="forgotten",
            receipt=RECEIPT_FORGOTTEN.format(text=item.text),
            text=item.text,
            section=item.section,
            replaced=item.text,
            item_id=item.id,
        )

    def update_item(
        self,
        item_id: str,
        *,
        content: str = "",
        section: str = "",
        user_id: str | None = None,
    ) -> WriteResult:
        """按 id 改一条（界面上点开来改的那条路）。

        ``content`` 留空 = 只改分区标签。两条与 `remember` 同源的检查（长度、敏感）
        照样生效：**换了一条路进来，判据不能松**。
        """
        item = self.get_item(item_id, user_id)
        if item is None:
            raise NotFoundError(f"记忆里没有这一条：{item_id}")
        text = normalize_entry(content) if content else item.text
        if len(text) > MAX_ENTRY_CHARS:
            return WriteResult(
                action="rejected",
                receipt=RECEIPT_TOO_LONG.format(limit=MAX_ENTRY_CHARS, current=len(text)),
                text=text,
                item_id=item_id,
            )
        if is_sensitive(text):
            return WriteResult(
                action="rejected",
                receipt=RECEIPT_SENSITIVE,
                text=text,
                reason="sensitive",
                item_id=item_id,
            )
        target = (section or "").strip() or item.section or classify_text(text)
        if target not in SECTIONS:
            target = classify_text(text)
        with self._lock():
            self._memory(user_id).update(
                item_id,
                text=text,
                metadata={"section": target, "source": item.source},
            )
        return WriteResult(
            action="replaced",
            receipt=RECEIPT_REPLACED.format(text=text),
            text=text,
            section=target,
            replaced=item.text,
            item_id=item_id,
        )

    def delete_item(self, item_id: str, user_id: str | None = None) -> WriteResult:
        """按 id 删一条（界面上行尾的删除）。"""
        item = self.get_item(item_id, user_id)
        if item is None:
            raise NotFoundError(f"记忆里没有这一条：{item_id}")
        with self._lock():
            self._memory(user_id).delete(item_id)
        return WriteResult(
            action="forgotten",
            receipt=RECEIPT_FORGOTTEN.format(text=item.text),
            text=item.text,
            section=item.section,
            replaced=item.text,
            item_id=item_id,
        )

    # ------------------------------------------------------------------ 迁移

    def import_legacy(self, user_id: str | None = None) -> ImportReport:
        """把旧档案（``PROFILE.md`` 四区条目）搬进 mem0 库（D10）。

        **旧文件一字不动**：读它、搬条目，绝不写回、绝不清空。水位落在
        ``<账号>/mem0/imported.json``（源指纹 + 已搬条目的指纹），
        所以**重跑净改动为零**：源指纹与水位一致时直接返回 ``skipped=True``。

        "搬完清空"这类选项**故意没有**：迁移这件事要能重来，
        也要能回头看原来那份文件长什么样。
        """
        source_dir = self.workspace_for(user_id)
        account_dir = self.memory_dir(user_id)
        entries, source_hash, source_name = memory_migration.read_legacy(source_dir)
        watermark = memory_migration.read_watermark(account_dir)
        done = set(watermark.get("entries") or [])
        if not entries:
            return ImportReport(source=source_name, entries=0)
        if watermark.get("source") == source_hash and done:
            return ImportReport(source=source_name, entries=len(entries), skipped=True)

        known = self.all_items(user_id)
        imported = 0
        existing = 0
        dropped = 0
        for section, raw_text in entries:
            text = normalize_entry(raw_text)
            key = memory_migration.entry_key(section, text)
            if key in done:
                continue
            done.add(key)
            if not text or is_sensitive(text):
                dropped += 1
                continue
            match = classify_action(text, known)
            if match.action == ACT_EXISTING:
                existing += 1
                continue
            target = section if section in SECTIONS else classify_text(text)
            if match.action == ACT_REPLACE and match.item is not None:
                self._replace(match.item, text, target, SOURCE_MIGRATION, user_id)
                known = [item for item in known if item.id != match.item.id]
                known.append(MemoryItem(id=match.item.id, text=text, section=target))
            else:
                added = self._add(text, target, SOURCE_MIGRATION, user_id)
                known.append(MemoryItem(id=added.item_id, text=text, section=target))
            imported += 1
        memory_migration.write_watermark(account_dir, source=source_hash, entries=sorted(done))
        return ImportReport(
            source=source_name,
            entries=len(entries),
            imported=imported,
            existing=existing,
            dropped_sensitive=dropped,
            changed=bool(imported),
        )

    def legacy_import_available(self, user_id: str | None = None) -> bool:
        """还有没有**没搬过**的旧条目（界面上那条一次性横幅的判据）。

        判据与 :meth:`import_legacy` 的跳过条件是同一条：读 ``PROFILE.md`` 的条目、
        逐个比水位里记下的指纹，**有一个没搬过就是"有可导的"**。
        文件不在、或条目都进过水位（搬过一次就都进）→ ``False``：横幅消失、不留痕迹。

        **敏感与否不参与这里的判断**：那些条目搬的时候会被丢掉，但水位照样记下它们，
        所以"搬过一次之后横幅就没了"不取决于它们最终有没有落库。
        """
        entries, _source, _name = memory_migration.read_legacy(self.workspace_for(user_id))
        if not entries:
            return False
        watermark = memory_migration.read_watermark(self.memory_dir(user_id))
        done = set(watermark.get("entries") or [])
        if not done:
            return True
        return any(
            memory_migration.entry_key(section, normalize_entry(text)) not in done
            for section, text in entries
        )

    # ------------------------------------------------------------------ 人设

    def soul_text(self, user_id: str | None = None) -> str:
        """``SOUL.md`` 的正文（人格，一句话说就是"你是谁"）。"""
        try:
            return (
                (self.workspace_for(user_id) / SOUL_FILE).read_text(encoding="utf-8").strip()
            )
        except OSError:
            return ""

    def seed_persona(self, user_id: str | None = None) -> list[str]:
        """把缺的人设文件补上模板，返回**这次新建了哪几个**。

        **只补缺的，绝不覆盖已存在的**：那可能已经是用户写了几天的东西。

        **v0.57 起只两份**（``SOUL.md`` / ``AGENTS.md``）：``PROFILE.md`` 不再是
        记忆的本体（D11），新装的实例不再铺它——铺一份谁也不读的骨架只会让人
        以为"这是记忆存在的地方"。老实例的那一份原地留着（只读、可迁移）。
        """
        created: list[str] = []
        for name, template in ((SOUL_FILE, _SOUL_TEMPLATE), (AGENTS_FILE, _AGENTS_TEMPLATE)):
            path = self.workspace_for(user_id) / name
            if path.exists():
                self._upgrade_untouched_template(path, name, template)
                continue
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                # 按字节写：`write_text` 在 Windows 上会把换行改成 CRLF，
                # 而"逐字节相同"正是 `_upgrade_untouched_template` 的判据
                path.write_bytes(template.encode("utf-8"))
            except OSError:
                logger.warning("人设文件写不出来：%s", path, exc_info=True)
                continue
            created.append(name)
        return created

    def _upgrade_untouched_template(self, path: Path, name: str, template: str) -> bool:
        """把**从没被改过的旧模板**换成新模板；返回是否换了。

        判据是**逐字节相同**：只要用户动过一个字符，这份文件就是他的，我们一个字都不改。
        """
        known = {template, *_LEGACY_TEMPLATES.get(name, ())}
        try:
            current = path.read_text(encoding="utf-8")
        except OSError:
            return False
        if current not in known or current == template:
            return False
        try:
            path.write_bytes(template.encode("utf-8"))
        except OSError:
            logger.warning("人设模板升级失败：%s", path, exc_info=True)
            return False
        logger.info("人设模板已升级（这份文件一直是初始模板，没有人改过）：%s", path.name)
        return True

    def persona_order(self) -> tuple[str, ...]:
        """这一轮**注入哪几份人设文件、按什么顺序**（``memory.persona_files``）。

        - 取值是**逗号分隔的文件名**，按写的顺序注入；
        - **只认那几份核心文件**（``memory_files.CORE_FILES``）：让任意路径进 system
          prompt 等于绕过"哪些是设定"这条分界；
        - **只认人设那两份**（``SOUL.md`` / ``AGENTS.md``）：``PROFILE.md`` 已经不再是
          每轮在场的设定（D11），清单里写了它照样丢掉并记一条日志——**静默忽略**
          会让那一行看起来生效了；
        - **空值/全不认识 → 回到默认顺序**（不写就是默认，不是"一份都不注入"）。
        """
        raw = (self._runtime.get("memory.persona_files") or "").strip()
        if not raw:
            return tuple(name for name, _label in PERSONA_FILES)
        injectable = {name for name, _label in PERSONA_FILES}
        wanted: list[str] = []
        for item in raw.replace("，", ",").split(","):
            name = item.strip()
            if not name:
                continue
            if name not in memory_files.CORE_FILES:
                logger.warning("人设文件清单里有不认识的文件名，已忽略：%s", name)
                continue
            if name not in injectable:
                logger.warning(
                    "人设文件清单里只有 %s 是可注入的人设（%s 不是：PROFILE.md 已不注入），"
                    "已忽略：%s",
                    "/".join(sorted(injectable)),
                    name,
                    name,
                )
                continue
            if name not in wanted:
                wanted.append(name)
        return tuple(wanted) or tuple(name for name, _label in PERSONA_FILES)

    def persona_texts(self, user_id: str | None = None) -> list[tuple[str, str]]:
        """``[(文件名, 正文)]``，按 :meth:`persona_order` 的顺序，空的跳过。"""
        found: list[tuple[str, str]] = []
        for name in self.persona_order():
            try:
                text = (self.workspace_for(user_id) / name).read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if text:
                found.append((name, text))
        return found

    # ------------------------------------------------------------------ 状态

    def status(self, user_id: str | None = None) -> MemoryStatus:
        """当前状态：**数一遍库与工作区，不连任何东西**。

        成本：两次本地检索（条目 + 旧档案水位）加一次目录遍历。这是
        "个人长期记忆"的量级，所以不另做缓存——不缓存就没有"缓存过期"这个新问题。
        """
        space = self.workspace_for(user_id)
        items = self.all_items(user_id)
        latest = max((item.updated_at or item.created_at for item in items), default="")
        _provider, development = self._embedder()
        return MemoryStatus(
            enabled=self.enabled,
            workspace=str(space),
            items=len(items),
            last_changed_at=latest,
            embedder=getattr(_provider, "model_id", ""),
            development=development,
            detail=""
            if self.enabled
            else "未启用：记忆不进提示词，recall 也停着（记忆本身照旧可以编辑）",
            legacy_import_available=self.legacy_import_available(user_id),
        )


# --------------------------------------------------------------------- 实例与存储
#
# 两件事都在这一节：**进程内单例**（qdrant 本地模式一个 path 只许一个实例）与
# **维度变了要重嵌**（qdrant 的向量维度是建集合时定死的，见 :class:`_Store`）。


@dataclass(slots=True)
class _Store:
    """一个账号的 mem0 实例 + 它是按几维建的。

    ``dim`` 是从 ``store.json`` 读回来的**落盘事实**（不是本轮算出来的）：进程重启
    之后仍然要知道"磁盘上那个集合是按几维建的"，否则换个嵌入模型就会撞上 qdrant 的
    ``Vector dimension error``——那可是个在写入时才炸的错，而不是打开时。
    """

    root: Path
    memory: Any
    dim: int

    def reembed(self, channel: memory_providers.Channel, account: str) -> None:
        """换嵌入模型、维度也变了：**把现有条目按新模型重嵌一遍**。

        为什么不是"报个错让用户自己清库"：从"新装没配嵌入模型（256 维兜底）"到
        "后来配上一个 1024 维的模型"是这个功能最正常的一次演进，那条路上报错等于
        把记忆页关掉。而 mem0 存的每一条**都带着原文**，所以重嵌是一条真实可行的路：
        读出来、按新维度重新写一遍。

        **先建新的、搬完、再换**（``qdrant.new`` → 关掉旧库 → 删旧目录 → 改名）：
        重嵌到一半失败时旧库原样还在（那批半成品删掉），
        不会出现"模型换了、记忆没了"这一态。

        ``get_all`` 不嵌任何东西（mem0 走的是向量库的 ``list``），所以**旧库不需要
        原来的嵌入模型在场**——这很重要：模型已经被用户换掉了，它就是要走的那个。
        """
        raw = self.memory.get_all(filters={"user_id": account}, top_k=MAX_ITEMS)
        items = [_item_of(item) for item in (raw or {}).get("results") or []]
        staging = self.root / "qdrant.new"
        shutil.rmtree(staging, ignore_errors=True)
        try:
            rebuilt = memory_providers.build_memory(
                path=staging,
                history_db_path=self.root / "history.db",
                channel=channel,
            )
            for item in items:
                if not item.text:
                    continue
                rebuilt.add(
                    [{"role": "user", "content": item.text}],
                    user_id=account,
                    metadata={"section": item.section, "source": item.source},
                    infer=False,
                )
            # **两个实例都要先关掉再动目录**（Windows 上目录里有打开的文件就改不了名，
            # 实测报 `PermissionError: [WinError 5]`；旧库那个也要关，否则删不掉）
            _close(rebuilt)
            del rebuilt
            _close(self.memory)
            gc.collect()
            shutil.rmtree(self.root / "qdrant", ignore_errors=True)
            staging.rename(self.root / "qdrant")
        except Exception as exc:
            shutil.rmtree(staging, ignore_errors=True)
            _INSTANCES.pop(str(self.root), None)
            logger.error("换嵌入模型时重嵌失败，记忆库保持原样", exc_info=True)
            raise InvalidRequestError(
                "换了嵌入模型（维度变了），但把已有记忆按新模型重嵌时失败了："
                f"{exc}。原来的记忆还在，改回原来的模型或修好嵌入服务之后会自动重试。"
            ) from exc
        # 旧实例已经关掉、目录也换过了：下一句按新维度重新打开。
        # **它也可能失败**（锁没放干净、磁盘满、权限）：那一步之前 `self.memory` 已经被
        # `close()` 了，所以失败时必须把这一条**从实例表里摘掉**——留着它，之后每一次
        # 访问都会撞上一个已经关掉的 qdrant 客户端（"用不了的库"这种错最难查），
        # 而摘掉之后下一次访问按 `_memory` 正常开门（维度标记这时还没写，会再判一次
        # 重嵌，那正是对的：磁盘上那个集合确实还没被确认按新维度建好）。
        try:
            reopened = _build(self.root, channel)
        except Exception:
            _INSTANCES.pop(str(self.root), None)
            logger.error("重嵌之后重开失败：实例已摘掉，下一次访问会重建", exc_info=True)
            raise
        _INSTANCES[str(self.root)] = _Store(root=self.root, memory=reopened, dim=channel.dim)
        logger.info("记忆库已按新嵌入模型重嵌：%d 条，%d 维", len(items), channel.dim)


def _build(root: Path, channel: memory_providers.Channel) -> Any:
    """在既有落点上打开（或新建）一个 mem0 实例。

    **打不开的那一类异常折成可读的那一种**（与 :meth:`MemoryService._extract` 同款口径）：
    mem0 抛出来的东西（集合被另一个进程占着、库文件损坏、目录没有写权限）原样漏给上层，
    等于让"记忆库打不开"这件事以一句 500 的面目出现在记忆页上——而这句话本该说清
    它在哪、该怎么办。**原话保留**（``{exc}``），只换一层壳。
    """
    try:
        return memory_providers.build_memory(
            path=root / "qdrant",
            history_db_path=root / "history.db",
            channel=channel,
        )
    except InvalidRequestError:
        raise
    except Exception as exc:
        raise InvalidRequestError(
            f"记忆库打不开：{exc}。库在 {root}；"
            "若提示已被占用，请先关掉另一个打开它的进程（本机主人与成员各有一份）。"
        ) from exc


def _store_path(root: Path) -> Path:
    return root / STORE_MARKER


def _disk_dim(root: Path, recorded: int, channel_dim: int) -> int:
    """**磁盘上那个集合是按几维建的**（新建实例时的那一判，见 ``MemoryService._memory``）。

    三种情形，各有各的依据：

    - ``recorded`` 有值 → 就是它（那是建集合时写下的**事实**）；
    - 读不出来、而磁盘上**还没有集合**（全新库）→ 就是本轮这条通道的维
      （下面紧接着就要按它建一个新的）；
    - 读不出来、而集合**已经在**（旧版本建的库、或从别处搬来的目录）→ **0 = 不知道**。
      不能拿本轮的维去顶替：判等会成立、重嵌被跳过，而那个集合还是旧形状——
      用户下一次写入才炸，且报的是 qdrant 的维度错。按"不知道"处理会多走一次重嵌，
      代价是重嵌那一次的开销，换来的是"换模型这件事每次都能落地"。
    """
    if recorded:
        return recorded
    return 0 if (root / "qdrant").exists() else channel_dim


def _recorded_dim(root: Path) -> int:
    """磁盘上那个集合是按几维建的（``store.json``）；读不出来时返回 0（= 不知道）。"""
    try:
        raw = json.loads(_store_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0
    try:
        return int(raw.get("dim") or 0) if isinstance(raw, dict) else 0
    except (TypeError, ValueError):
        return 0


def _remember_dim(root: Path, dim: int) -> None:
    """把维度落盘（与集合一起建出来的事实，见 :class:`_Store`）。"""
    try:
        root.mkdir(parents=True, exist_ok=True)
        _store_path(root).write_bytes(
            json.dumps({"dim": dim, "version": 1}, ensure_ascii=False).encode("utf-8")
        )
    except OSError:
        logger.warning("记忆库的维度标记写不出去：%s", _store_path(root), exc_info=True)


def _close(memory: Any) -> None:
    """放掉一个 mem0 实例持有的本地 qdrant 文件锁（换库 / 用例清理时用）。

    mem0 没有 ``close()``，qdrant 的本地客户端有——直接伸手拿它那一个。
    拿不到就只记日志：那多半意味着 mem0 换了实现，重嵌那条路会因此失败，
    但**失败是可见的**（上面那个 except 会把它变成一句可读的报错），不会静默。
    """
    try:
        memory.vector_store.client.close()
    except Exception:
        logger.debug("关不掉 mem0 的本地向量库（忽略）", exc_info=True)


#: 进程级的 mem0 实例表（键 = 存储落点的绝对路径字符串，见 ``MemoryService._memory``）。
_INSTANCES: dict[str, _Store] = {}
_INSTANCE_LOCK = threading.Lock()
#: 写操作的互斥（qdrant 本地模式没有线程锁，见 ``MemoryService._lock``）。
_WRITE_LOCK = threading.RLock()


def reset_instances() -> None:
    """丢掉全部 mem0 实例（用例的清理口）。

    **要先放掉文件锁**：只清字典的话那些 ``QdrantClient`` 还活着，
    下一个用例在同一个 path 上会撞 "already accessed by another instance"。
    """
    with _INSTANCE_LOCK:
        for store in _INSTANCES.values():
            _close(store.memory)
        _INSTANCES.clear()


def _without_thinking(config: Any) -> Any:
    """把对话模型快照的思考关掉（``enable_thinking=False``，理由见 ``_chat``）。"""
    return replace(config, enable_thinking=False)


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(int(value), high))


def _first_id(raw: Any) -> str:
    """mem0 一次 ``add`` 的结果里第一条的 id（没写进去时是空串）。"""
    results = (raw or {}).get("results") or []
    return str(_field(results[0], "id") or "") if results else ""


def _index_of(items: Sequence[MemoryItem], clean: str) -> int | None:
    """按原样找：指纹或归一化相等。"""
    want_fp = fingerprint(clean)
    for index, item in enumerate(items):
        if fingerprint(item.text) == want_fp:
            return index
    return None


def _candidates(items: Sequence[MemoryItem], clean: str) -> list[int]:
    """按**唯一子串**兜一次：命中的下标（按命中的短文本长度降序，更像的那条在前）。"""
    loose = normalize(clean)
    if not loose:
        return []
    out: list[tuple[int, int]] = []
    for index, item in enumerate(items):
        body = normalize(item.text)
        if loose and (loose in body or body in loose):
            out.append((index, len(body)))
    out.sort(key=lambda pair: pair[1])
    return [index for index, _length in out]


def _locate(items: Sequence[MemoryItem], clean: str) -> MemoryItem | None:
    """``replaces`` / ``topic`` 的定位：先原样，再唯一子串（**不唯一就不猜**）。"""
    index = _index_of(items, clean)
    if index is not None:
        return items[index]
    candidates = _candidates(items, clean)
    return items[candidates[0]] if len(candidates) == 1 else None


#: 新建 ``AGENTS.md`` 时的模板。正文照抄 QwenPaw 的 AGENTS.md，**删掉了两节**：
#: 它的"表情回应"那一节（Discord/Slack 上的 emoji 回应，这个项目禁 emoji，
#: 而且我们没有任何"支持表情回应的通道"）；它的"Heartbeat"那一节（KYLAB 没有
#: 这个机制——给模型看一份不存在的机制，会让它去等一个永远不来的信号）。
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
- 在记忆里检索、看文档列表
- 在对方给的工作区里干活

**先问一声的：**

- 任何会**离开这台机器**的操作（对外发送、发布、调用外部服务做写操作）
- 改动别人放在这里的文件

## 工具

- 技能（SOP）的**目录已经在你的系统提示词里**（名字 + 何时用 + 路径）：
  **不知道某类事该怎么做时先看一眼那份目录**，要用哪条就 `read_skill` 读它的正文。
  （目录每轮都注入，所以不必先 `list_skills`——那是给"想看全部字段"用的。）
- 资料在知识库里，用 `search` 取。取回来的原文带编号，引用时用那个编号。
- 值得长期记住的事实用 `remember` 记下来（一条一句）；
  更正旧条目就在同一次调用里带上 `replaces`，要忘掉某条用 `forget`。
  **记忆里已有的条目每轮都在你的提示词里**，不必先去读它。
- 需要啃一批资料才能得到一句话结论时，**自己一轮轮翻**再下结论
  （这条链 2026-10-09 收窄过：以前这里写的是派一个子 Agent 去做）。

## 让它成为你的

以上只是起点。摸索出什么管用之后，加上你自己的习惯与规矩，更新这份 `AGENTS.md`。
"""

#: 新建 ``SOUL.md`` 时的模板。正文照抄 QwenPaw 的 SOUL.md（它的 `md_files/zh/`），
#: 因为这一份是"人格"这件事上少见的、被真实使用磨过的写法：它写的不是
#: "你是一个乐于助人的 AI 助手"这种没有约束力的自我介绍，而是**几条行为约束**
#: （别演、先自己查、对外谨慎对内大胆、你是客人），每一条都能落到具体动作上。
#:
#: 照抄时改掉的两处：ASCII 引号换成「」（这个仓库里中文串里的 `"` 已经弄坏过一次
#: 语法），以及删掉与外部平台相关的措辞（我们没有 Discord/Slack 那类通道）。
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

#: **v0.20 及以前的那两份人设模板**（空骨架），只给
#: :meth:`MemoryService._upgrade_untouched_template` 做"这份文件是不是从来没被改过"
#: 的比对用。留着是为了那些**已经在跑**的实例：它们的文件是当时写下去的，
#: 改模板的这一步必须能认得出来。
_LEGACY_TEMPLATES: dict[str, tuple[str, ...]] = {
    SOUL_FILE: (
        """---
summary: "Agent 的人格：身份、准则与说话方式"
read_when:
  - 需要确认自己是谁、该怎么说话、哪些事不做
---

## 我是谁

## 我的准则

## 说话方式
""",
    ),
    AGENTS_FILE: (
        """---
summary: "操作规程：这类活怎么干、哪些要先问、成果放哪"
read_when:
  - 开始一项任务前，想确认有没有既定做法
---

## 工作方式

## 先问再做的情形

## 成果放哪

## 不要做的事
""",
    ),
}
