"""记忆工作区的**文件层**（v0.14 三期，见 ``docs/设计/记忆层设计-v0.1.md`` §3）。

记忆就是一堆带 frontmatter 与 wikilink 的普通 Markdown（ReMe 的主张：
*Memory as File, File as Memory*）。这一层提供五件事：列的出、读得进、写得回、
连成图、**搜得到**。

**全都在本地做，没有第二个进程**（v0.46 起）：文件是我们自己的（``data/memory/``，
见设计文档 §2.2 的数据落点），检索也就是把这几份 Markdown 读进来打分——
没有外部服务可连、没有索引要追、没有"编辑之后它什么时候跟上"这个问题。
（原先这一层是 ReMe 的 HTTP 门面，退化的形态见设计文档 §3.5：
即使只想用它的文件操作与 BM25，它也要自己的进程、自己的 venv。）

**为什么直接读本地目录**：

1. 这个目录是**我们自己的**，``remember`` 与 ``core_text`` 早就直接读写它了
   ——经别的进程绕一圈，等于"读一个自己的文本文件还得先有另一个进程活着"；
2. 界面是**随时要打开**的东西：记忆没启用、或者用户就是想看看上次记了什么，
   这时页面不该整个空掉。**能看**与**能召回**是两件事，前者不依赖开关；
3. 少一层转发就少一处别人改字段名我们要跟着改的地方。

**召回的口径**（``search``）：按行切块，块内做词命中打分 + 标题/文件名加权
+ 与文件名的整串命中加分；分数只用于**排序**，命中与否另有一条跨查询可比的判据
（词面覆盖 ≥ ``MIN_TERM_COVERAGE``）。**为什么不走向量**：这一池子是"个人长期记忆"，
量级是几份到几百份文件、几百 KB，词面命中已经够用；而向量要么进文档池
（那会破坏设计文档 §2.1 的两池隔离），要么为记忆单开一路索引与一份 embedding 账单
——在证明"规模上值得"之前不付这个代价。

**召回池的边界**（``MemoryFile.retrievable``）：只有 ``daily/`` 与 ``digest/``
参与召回；``MEMORY.md`` / ``SOUL.md`` 这几份**每轮整份注入 system prompt**，
再召回一遍就是同一段内容进上下文两次。这条边界由我们的选择定下（原先是从 ReMe 的
``watch_dirs`` 读出来的，见设计文档 §3.3），界面必须把它显示出来——否则用户改完
一个不参与召回的文件却搜不到，会以为是检索坏了。

**图谱也是本地算的**：wikilink 就在文件正文里，数一遍是纯函数，可测、可离线，
且与"哪些还没被整合"是同一份数据。
"""

from __future__ import annotations

import logging
import math
import os
import re
import unicodedata
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from app.core.exceptions import InvalidRequestError, NotFoundError
from app.services.retrieval.coverage import content_terms

__all__ = [
    "CORE_KIND",
    "DAILY_KIND",
    "DEFAULT_RECALL",
    "DIGEST_KIND",
    "MAX_LISTED_FILES",
    "MAX_READ_BYTES",
    "MAX_WRITE_BYTES",
    "MAX_WRITE_CHARS",
    "MIN_MATCHED_TERMS",
    "MIN_TERM_COVERAGE",
    "MemoryBlock",
    "MemoryFile",
    "MemoryFileDetail",
    "MemoryGraph",
    "MemoryGraphNode",
    "MemoryMatch",
    "WorkspaceStats",
    "classify",
    "delete_file",
    "describe",
    "entry_texts",
    "graph_of",
    "links_of",
    "parse_frontmatter",
    "read_file",
    "safe_path",
    "scan",
    "search",
    "stats",
    "wikilinks",
    "write_file",
]

logger = logging.getLogger(__name__)

#: 文件分类。**只按它在工作区里的位置分**（ReMe 的分层就是靠目录表达的，
#: 见设计文档 §1 的那张表），不去猜正文内容——猜出来的分类用户无法预期。
CORE_KIND = "core"
DAILY_KIND = "daily"
DIGEST_KIND = "digest"
OTHER_KIND = "other"

#: 扫描上限。工作区可能被塞进很多东西（``resource/`` 下可能有成百上千个
#: 解析产物），而这是**给人浏览**的列表，不是全量索引——超过就截断并在
#: 返回值里说明，而不是让一次页面请求去遍历一万个文件。
MAX_LISTED_FILES = 2000

#: 读文件的上限（编辑器要把它整个塞进 textarea）。记忆文件该是几 KB 量级，
#: 1 MB 已经远超"一条记忆"的合理体积；超了就截断并标记，而不是拒绝打开。
MAX_READ_BYTES = 1_000_000

#: 写入上限。比读大一档：允许用户手写一篇长一点的整合笔记，
#: 但仍要挡住"把整个工作区当成文件服务器"。
MAX_WRITE_BYTES = 4_000_000

#: 同样的上限，按**字符**表述——协议层的 pydantic 校验只能按字符算长度。
#: 取 1e6 而不是 4e6：UTF-8 一个字符最多 4 字节，1e6 字符最坏也就 4e6 字节，
#: 于是"net 上不会传进一个必然被服务层拒掉的请求"，而真正的判据仍是上面的字节数。
MAX_WRITE_CHARS = 1_000_000

#: 一次召回默认取几条。与 ``MemoryService.DEFAULT_RECALL`` 同源（服务层传进来，
#: 这里只做兜底），口径不变：给模型"够用"的几条，上下文预算是有限的。
DEFAULT_RECALL = 6

#: 命中判据之一：命中的证据占**那条通道**总量的比例下限（``MemoryMatch.coverage``）。
#:
#: **为什么不能拿打分当判据**：分数量纲依赖词频与块数，跨查询不可比
#: ——同一个分数在 3 个块的库和 3000 个块的库里含义完全不同。覆盖率是归一化的量
#: （分子分母都随查询长度走），跨查询、跨工作区都可比。这条与文档检索那边的
#: 「相关度下限」是**同一类思路**（见 ``services/retrieval/coverage.py``），
#: 但**各算各的**：记忆池永不进文档检索，也不共用任何索引（设计文档 §2.1）。
#:
#: 取 1/3 而不是文档检索那边的 0.5：那是给长文档定的（几千字的正文里大部分查询词
#: 都会出现），而记忆的一个块往往只有一句话——一句"用户偏好先给结论再给理由"
#: 对得上「用户偏好什么样的回答风格」的一半词已经算强命中了（实测：
#: 拿 0.5 去卡，界面输入框里那句示例提示词什么都搜不出来）。
MIN_TERM_COVERAGE = 1 / 3

#: 命中判据之二：**在通过的那条通道里**至少要有这么多个单位命中（单位见 ``_word_pairs``）。
#:
#: 它**只对 3 个以上单位的查询成立**（短查询不受它管，见 ``_passes``）。
#: 作用是挡住"查询长起来之后蹭上一个常用词就算命中"：例如
#: 「用户的开会时间安排」在只写了「用户偏好…」的记忆上拿到 1/4 但只有「用户」一个词
#: 命中——那不该算相关。
MIN_MATCHED_TERMS = 2

#: 同一个文件最多贡献几条命中。没有它，一次召回很容易被某一份长日笔记占满
#: （同一份文件里相邻的块分数接近），而"召回"的价值恰恰在于从**多个**文件里凑线索。
MAX_HITS_PER_FILE = 3

#: 顺链走一步最多给几条边（图谱那部分不额外花成本，但也不必把整个图塞进上下文）。
MAX_LINKS = 10

#: 一条命中的片段上限（字符）。召回结果是要进上下文的：长了就等于把整份文件塞进去。
MAX_HIT_CHARS = 600

#: 超过这么多行的块再切一刀。正常记忆条目是 1–5 行（bullet 或一段话），
#: 但没有空行的大段正文也是常见的——不切的话，一次命中会把整节内容全带走。
MAX_BLOCK_LINES = 24

#: 标题/文件名加权：查询词出现在文件的标题、路径或摘要里时，这份文件的块
#: **整体加分**（不是只在那一行上加分）。理由：命中标题意味着"这份文件就是讲这个的"，
#: 而命中正文只说明"这里提了一句"。
HEAD_BONUS = 1.5

#: 整串命中加分（查询原样出现在块里）。词表命中可能只是凑巧共享了几个常用词，
#: 而"原样出现"是最强的证据，给一个能压过普通词表命中的加值。
PHRASE_BONUS = 2.0

#: 顶层目录 → 分类。``memory/`` 是每日现场，``digest/`` 是整理后的长期知识。
#: 两个名字都收（``daily`` 是 ReMe 的默认，``memory`` 是 QwenPaw 那族的写法，
#: 而我们的工作区可能被任一版本初始化过）。
_TOP_LEVEL = {"memory": DAILY_KIND, "daily": DAILY_KIND, "digest": DIGEST_KIND}

#: 会进检索索引的分类。**改这里之前先看 ``MemoryFile.retrievable`` 的说明**。
_INDEXED_KINDS = (DAILY_KIND, DIGEST_KIND)

#: 这几个目录是**派生物**（原始对话、可重建索引、外部资料），
#: 里面就算有 .md 也不是记忆。列出来只会淹掉真正要改的东西。
_SKIP_DIRS = {"session", "mem_metadata", "mem_session", "resource", ".git", "node_modules"}

#: ``[[目标]]`` 或 ``[[目标|显示名]]``。ReMe 的 ``[[session/dialog/x.jsonl]]``
#: 就是前一种；``meta.name`` 对应后一种的显示名。
_WIKILINK = re.compile(r"\[\[([^\[\]|]+?)(?:\|([^\[\]]*))?\]\]")
#: frontmatter 开头的 ``---`` 块。
_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
#: 正文里的第一个一级/二级标题，作为"没有 title 时"的显示名。
_HEADING = re.compile(r"^#{1,2}\s+(.+?)\s*$", re.MULTILINE)
#: 一行以列表项开头（``- x`` / ``* x`` / ``1. x``，允许前置缩进）。
#: 三处用到它：切块（条目自成一块）、数条目、捕获去重（只认单行条目）。
_BULLET = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+")
#: 块首认定：**顶格**的列表项或标题。缩进的列表项是上一项的子内容，不该切开。
_BLOCK_START = re.compile(r"^(?:[-*+]|\d+\.)\s+|^#{1,6}\s+")


@dataclass(frozen=True, slots=True)
class MemoryFile:
    """列表项。**body 不在这里**——列表可能有上千条，正文按需再读（渐进式）。"""

    path: str
    """相对工作区的路径，**统一用正斜杠**（ReMe 的 wikilink 也用这个形式，
    而 Windows 的 ``\\`` 写进链接里就点不动了）。"""

    name: str
    title: str
    kind: str
    summary: str = ""
    tags: tuple[str, ...] = ()
    size_bytes: int = 0
    modified_at: str = ""
    links: tuple[str, ...] = ()
    """出链的**原始目标**（还没解析成文件）。解析失败的也留着：那是用户
    写错的链接，界面该让他看见，而不是悄悄丢掉。"""

    consolidated: bool = False
    """``daily`` 专有：有没有被 ``digest/`` 里的文件链到。见 ``scan`` 的说明。"""

    retrievable: bool = False
    """``recall`` 找不找得到它。

    **这条界由我们的选择定**（v0.46）：``daily/`` 与 ``digest/`` 进召回池；
    ``MEMORY.md`` / ``SOUL.md`` / ``PROFILE.md`` / ``AGENTS.md`` 走**注入**
    （每轮整份进 system prompt），再被召回一遍就是同一段内容进上下文两次；
    其余目录下的 Markdown 既不注入也不召回，在这里只是一个能编辑的文本文件。
    （这条界原先是从 ReMe 的 ``watch_dirs`` 读出来的，见设计文档 §3.3；
    现在它由 ``_INDEXED_KINDS`` 定，口径与用户看到的行为一字未变。）

    界面必须把这条显示出来——否则用户改完一个文件却发现"搜不到"，
    会以为是检索坏了，而不是"这个位置本来就不参与召回"。"""

    @property
    def is_core(self) -> bool:
        return self.kind == CORE_KIND


@dataclass(frozen=True, slots=True)
class MemoryFileDetail:
    """单个文件的正文 + 元信息。``content`` 是**原文**（含 frontmatter），
    这样编辑器存回去是逐字节还原的，不会因为我们"顺手格式化"而丢掉用户的手写内容。"""

    path: str
    content: str
    meta: dict[str, Any] = field(default_factory=dict)
    truncated: bool = False
    size_bytes: int = 0
    modified_at: str = ""


@dataclass(frozen=True, slots=True)
class MemoryGraphNode:
    path: str
    title: str
    kind: str
    degree: int
    """连了几条边。界面按它定节点大小——一眼看出哪份记忆是被反复引用的。"""


@dataclass(frozen=True, slots=True)
class MemoryGraph:
    nodes: list[MemoryGraphNode]
    edges: list[tuple[str, str]]
    """``(from_path, to_path)``。**两条都必须是真实存在的文件**：指向不存在目标的
    链接只留在 ``MemoryFile.links`` 里，不画成悬空节点——图上出现一堆
    "不存在的东西"会把真正的结构淹掉。"""

    dangling: list[tuple[str, str]] = field(default_factory=list)
    """``(from_path, 原始目标)``：写了但没解析到文件的链接。单独给出来，
    界面可以提示"有 3 条链接指向不存在的文件"。"""


@dataclass(frozen=True, slots=True)
class MemoryBlock:
    """召回的最小单位：文件里的一"块"正文（见 ``blocks_of``），带真实行号。

    ``path`` + 行号是这一层最重要的东西：**用户拿着它就能去改那一条**
    （界面上的召回结果点一下就跳到编辑器那一段）。
    """

    path: str
    title: str
    summary: str
    start_line: int
    end_line: int
    text: str


@dataclass(frozen=True, slots=True)
class MemoryMatch:
    """一条召回命中：片段 + 出处 + 分数。"""

    text: str
    path: str
    start_line: int
    end_line: int
    score: float
    """排序用的分数（词命中 × 词的稀缺度，再乘标题加权与整串加分）。
    **只在本条查询内可比**——它依赖工作区里有几块正文，不是归一化的量。"""

    coverage: float
    """命中的判据：查询实词在这一块里出现的比例（0.0–1.0，见 ``MIN_TERM_COVERAGE``）。"""


@dataclass(frozen=True, slots=True)
class WorkspaceStats:
    """工作区的本地状态（``stats``）。界面上"几份文件、多少条、上次改动"就是它。"""

    file_count: int = 0
    """工作区里的 Markdown 份数（不含 ``session/`` 那类派生物目录）。"""

    retrievable_count: int = 0
    """其中进入召回池的份数。"""

    entry_count: int = 0
    """**可召回的条数**：召回池那些文件切出来的块数。与 ``count_entries`` 同源——
    这个数字与"召回能给出几条线索"是同一件事，不是另算的一个估计值。"""

    last_changed_at: str = ""
    """最近一次改动的时间（ISO，UTC）。没有索引也就没有"索引时间"，
    如实给"内容最后变更时间"——界面上写的是"上次更新"。"""


# --------------------------------------------------------------------- 路径


def safe_path(workspace: Path, path: str) -> Path:
    """把界面传来的相对路径解析成工作区内的绝对路径，**越界一律拒绝**。

    这是本模块唯一的安全边界：路径由前端给出（用户点的、或者手输的），
    不校验就等于把整个文件系统开放给这个端点（``../../backend/.env`` 一份就够糟）。

    四道检查，缺一不可：非空、非绝对路径、没有 ``..`` 段、解析后仍在工作区内。
    最后一道是**兜底**：前两道挡的是"写出来的坏路径"，而符号链接、Windows 的
    ``C:foo``、以及各种编码花样只有真解析一遍才能确认。
    """
    raw = (path or "").strip().replace("\\", "/").lstrip("/")
    if not raw:
        raise InvalidRequestError("缺少参数：path")
    if not raw.lower().endswith(".md"):
        raise InvalidRequestError("只能读写 Markdown 文件（.md）")
    # 冒号单独拦一道：Windows 上 ``C:foo.md`` 是"驱动器相对路径"（会被解析到别处），
    # ``x.md:stream`` 则是 NTFS 的备用数据流——两者都能绕开下面基于 ``..`` 的判断。
    # 合法的记忆文件名里没有冒号，所以直接拒。
    if ":" in raw or any(ord(ch) < 32 for ch in raw):
        raise InvalidRequestError("路径里有非法字符（冒号或控制字符）")
    parts = [part for part in raw.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise InvalidRequestError("路径不能包含 ..（不允许跳出记忆工作区）")

    workspace = workspace.resolve()
    target = (workspace / Path(*parts)).resolve()
    # Python 3.9+ 的 is_relative_to；相等也合法（但工作区本身不是文件，下面 read 会拒）
    if target != workspace and not target.is_relative_to(workspace):
        raise InvalidRequestError("路径超出记忆工作区")
    return target


def _relative(workspace: Path, target: Path) -> str:
    return target.resolve().relative_to(workspace.resolve()).as_posix()


#: 核心文件：住在工作区根下、**靠注入生效、不进检索**的那几份。
#:
#: 人设四件套（P1 起）：人格、身份、操作规程、长期记忆。它们必须是同一份清单——
#: 少列一个的后果是那份文件被当成普通文件（不进注入、还可能被检索进去），
#: 而用户看到的现象是"我改了它，但助手好像没读到"。
CORE_FILES: tuple[str, ...] = ("MEMORY.md", "SOUL.md", "PROFILE.md", "AGENTS.md")


def classify(path: str) -> str:
    """按位置分类。核心文件按**文件名**判（它们在根下，``head`` 会是空串），
    其余按顶层目录。"""
    if Path(path).name in CORE_FILES:
        return CORE_KIND
    head = path.split("/", 1)[0] if "/" in path else ""
    return _TOP_LEVEL.get(head, OTHER_KIND)


# ----------------------------------------------------------------- 解析纯函数


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """拆出 YAML frontmatter 与正文。

    **解析失败不抛错**：frontmatter 是给人看的约定，手写时少个引号很正常，
    而"因为 frontmatter 坏了就打不开这个文件"是最糟的处理——用户正是来修它的。
    退回空 frontmatter、正文原样返回（含那段 ``---``），让他能改。
    """
    match = _FRONTMATTER.match(text)
    if not match:
        return {}, text
    try:
        loaded = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        logger.debug("frontmatter 解析失败，按无 frontmatter 处理", exc_info=True)
        return {}, text
    meta = loaded if isinstance(loaded, dict) else {}
    return meta, text[match.end() :]


def wikilinks(text: str) -> list[str]:
    """正文里的 wikilink 目标（去重、保序）。"""
    seen: set[str] = set()
    out: list[str] = []
    for target in _WIKILINK.findall(text):
        clean = target[0].strip()
        if clean and clean not in seen:
            seen.add(clean)
            out.append(clean)
    return out


def _title_of(body: str, meta: dict[str, Any], name: str, *, kind: str) -> str:
    """显示名，优先级：frontmatter.title → 正文首个标题 → 文件名。

    frontmatter 排在标题前面，是因为 ReMe 那族文件用它放"给检索读的一句话"，
    而正文标题可能只是 ``## 当前判断`` 这种片段标题。

    **核心文件例外，一律用文件名**：``MEMORY.md`` 正文里那个
    ``## 核心长期记忆`` 是它的章节名，不是它的名字——把章节名当标题，
    列表里就会出现两个都叫"核心长期记忆"的条目，而用户要找的是 MEMORY.md。
    """
    if kind != CORE_KIND:
        for key in ("title", "name"):
            value = meta.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        match = _HEADING.search(body)
        if match:
            return match.group(1).strip()
    return name


def _summary_of(meta: dict[str, Any]) -> str:
    value = meta.get("summary")
    return value.strip() if isinstance(value, str) else ""


def _tags_of(meta: dict[str, Any]) -> tuple[str, ...]:
    raw = meta.get("tags")
    if isinstance(raw, str):
        parts = [part.strip() for part in raw.split(",")]
    elif isinstance(raw, list):
        parts = [str(part).strip() for part in raw]
    else:
        return ()
    return tuple(part for part in parts if part)


def _norm(path: str) -> str:
    """链接解析与去重用的规范化形式：大小写与 Unicode 形式都拉平。

    Windows 上 ``Digest/Wiki/A.md`` 与 ``digest/wiki/a.md`` 是同一个文件，
    而链接是手写的（或由模型生成的），不该因为大小写差异就断掉。
    """
    return unicodedata.normalize("NFC", path.replace("\\", "/")).strip().lower()


# --------------------------------------------------------------------- 扫描


def _iter_markdown(workspace: Path) -> list[Path]:
    """遍历工作区里的 .md，跳过派生物目录与隐藏目录。结果**排序**，
    这样列表顺序稳定（否则 os.scandir 的顺序会让界面每次刷新都换一个样子）。"""
    found: list[Path] = []
    if not workspace.is_dir():
        return found
    for root, dirs, files in os.walk(workspace):
        dirs[:] = sorted(d for d in dirs if d not in _SKIP_DIRS and not d.startswith("."))
        for name in sorted(files):
            if name.lower().endswith(".md"):
                found.append(Path(root) / name)
        if len(found) >= MAX_LISTED_FILES:
            break
    return found[:MAX_LISTED_FILES]


def _entry_of(workspace: Path, target: Path) -> MemoryFile:
    """一个文件 → 一条列表项。**``scan`` 与 ``describe`` 共用这一处字段装配**：
    两边各拼一份的话，以后加字段（比如刚加的 ``retrievable``）必然漏掉一边，
    而漏掉的那边是"读单个文件"——它只在打开编辑器时才走到。

    读法也与 ``read_file`` 对齐（按字节读再解码），这样两条路径看到的是同一份文本；
    解码失败用 ``errors="replace"`` 兜住——**语法错误的手工编辑不该让整个列表 500**，
    那个文件本来就该被打开来修。
    """
    raw = target.read_bytes().decode("utf-8", errors="replace")
    stat = target.stat()
    meta, body = parse_frontmatter(raw)
    rel = _relative(workspace, target)
    kind = classify(rel)
    return MemoryFile(
        path=rel,
        name=target.name,
        title=_title_of(body, meta, target.name, kind=kind),
        kind=kind,
        summary=_summary_of(meta),
        tags=_tags_of(meta),
        size_bytes=stat.st_size,
        modified_at=datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat(),
        links=tuple(wikilinks(raw)),
        retrievable=kind in _INDEXED_KINDS,
    )


def scan(workspace: Path) -> list[MemoryFile]:
    """列出工作区里所有记忆文件（含解析出的 frontmatter 摘要与出链）。

    ``consolidated`` 的判定：**一份每日笔记被 ``digest/`` 里的文件链到，就算已整合**。
    为什么用链接而不是 ReMe 某个状态字段：四动作整合（CREATE/CORROBORATE/REFINE/
    CORRECT）的产物就是 ``digest/`` 下的文件加回链，而回链是**写在正文里的、
    可以被人核对的东西**。拿一个内部状态标记来判定，用户既看不到也无从修正；
    链接他看得见、也改得动。
    """
    workspace = workspace.resolve()
    entries: list[MemoryFile] = []
    for target in _iter_markdown(workspace):
        try:
            entries.append(_entry_of(workspace, target))
        except OSError:
            logger.warning("读记忆文件失败：%s", target, exc_info=True)
    return _with_consolidation(entries, workspace)


def describe(workspace: Path, path: str) -> MemoryFile:
    """单个文件的列表项（不含正文）。

    **单独有它，是为了不让"读一个文件"去扫整个工作区**：编辑器每次打开都走这条路，
    而工作区可能有上千个文件。``consolidated`` 在这里只能是 False——
    它要跨文件才知道，而这里只读了一个。调用方不该拿这个字段下结论。
    """
    workspace = workspace.resolve()
    target = safe_path(workspace, path)
    try:
        return _entry_of(workspace, target)
    except FileNotFoundError as exc:
        raise NotFoundError(f"记忆文件不存在：{path}") from exc
    except OSError as exc:
        raise InvalidRequestError(f"读不了这个文件：{exc}") from exc


def _with_consolidation(entries: list[MemoryFile], workspace: Path) -> list[MemoryFile]:
    """标出哪些每日笔记已经被 ``digest/`` 引用过（见 ``scan`` 的说明）。"""
    index = _path_index(entries)
    linked: set[str] = set()
    for entry in entries:
        if entry.kind != DIGEST_KIND:
            continue
        for link in entry.links:
            resolved = _resolve(link, index)
            if resolved:
                linked.add(resolved)
    return [
        replace(entry, consolidated=entry.path in linked)
        if entry.kind == DAILY_KIND
        else entry
        for entry in entries
    ]


# --------------------------------------------------------------------- 读写


def read_file(workspace: Path, path: str) -> MemoryFileDetail:
    """读一个文件的原文。文件不存在 → 404（而不是返回空内容）。"""
    target = safe_path(workspace, path)
    try:
        data = target.read_bytes()
    except FileNotFoundError as exc:
        raise NotFoundError(f"记忆文件不存在：{path}") from exc
    except OSError as exc:
        raise InvalidRequestError(f"读不了这个文件：{exc}") from exc

    stat = target.stat()
    truncated = len(data) > MAX_READ_BYTES
    text = data[:MAX_READ_BYTES].decode("utf-8", errors="replace")
    meta, _ = parse_frontmatter(text)
    return MemoryFileDetail(
        path=_relative(workspace.resolve(), target),
        content=text,
        meta=meta,
        truncated=truncated,
        size_bytes=stat.st_size,
        modified_at=datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat(),
    )


def write_file(workspace: Path, path: str, content: str) -> MemoryFileDetail:
    """写入（覆盖）一个文件，必要时建目录。返回写后的状态。

    **允许建新文件**：三期要能新建一条整合笔记（``digest/personal/…``），
    否则用户只能在既有文件里改。
    """
    target = safe_path(workspace, path)
    size = len(content.encode("utf-8"))
    if size > MAX_WRITE_BYTES:
        raise InvalidRequestError(
            f"文件太大（{size} 字节，上限 {MAX_WRITE_BYTES}）：记忆是给人读的短文件，"
            "长内容请走知识库那条路"
        )
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        # **写字节，不写文本**：``Path.write_text`` 在 Windows 上会把 ``\n`` 翻成
        # ``\r\n``，而文件里本来就有 ``\r\n`` 时结果是 ``\r\r\n``——每存一次长一个
        # ``\r``（实测：往返一趟就不再逐字相等）。记忆文件是用户也会用别的编辑器
        # 改的东西，我们只该原样存回他给的内容。
        target.write_bytes(content.encode("utf-8"))
    except OSError as exc:
        raise InvalidRequestError(f"写不了这个文件：{exc}") from exc
    return read_file(workspace, path)


def delete_file(workspace: Path, path: str) -> None:
    """删除一个文件。目录**不删**（只删 .md，``safe_path`` 已经保证了这一点），
    免得留下空目录树——空目录不影响任何东西，而递归删目录是个不必要的危险动作。"""
    target = safe_path(workspace, path)
    try:
        target.unlink()
    except FileNotFoundError as exc:
        raise NotFoundError(f"记忆文件不存在：{path}") from exc
    except OSError as exc:
        raise InvalidRequestError(f"删不了这个文件：{exc}") from exc


# --------------------------------------------------------------------- 图谱


def _path_index(entries: list[MemoryFile]) -> dict[str, str]:
    """规范化路径 → 真实路径 的索引，另外把**文件名与主干名**也收进去。

    链接是手写的，实际写起来三种都有：``digest/wiki/锂价敏感性.md``（全路径）、
    ``锂价敏感性.md``（文件名）、``锂价敏感性``（主干，Obsidian 的常见写法）。
    只认第一种的话，图谱会缺掉大半边。**重名时不猜**：一个名字对应多个文件时
    丢弃该键，宁可显示成"悬空链接"，也不要连到随机一个上。
    """
    index: dict[str, str] = {}
    ambiguous: set[str] = set()
    for entry in entries:
        for key in (_norm(entry.path), _norm(entry.name), _norm(Path(entry.path).stem)):
            existing = index.get(key)
            if existing is not None and existing != entry.path:
                ambiguous.add(key)
                continue
            index[key] = entry.path
    for key in ambiguous:
        index.pop(key, None)
    return index


def _resolve(link: str, index: dict[str, str]) -> str | None:
    """把一个链接目标解析成真实路径；解析不到返回 None（调用方按悬空处理）。"""
    key = _norm(link)
    if key in index:
        return index[key]
    if not key.endswith(".md") and f"{key}.md" in index:
        return index[f"{key}.md"]
    return None


def graph_of(entries: list[MemoryFile]) -> MemoryGraph:
    """由出链拼出无向图（两个方向都算一条边，同一条边只留一份）。

    为什么按**无向**画：wikilink 是单向写的，但"这两份记忆相关"这个事实是双向的
    ——界面要回答的是"什么和什么连在一起"，不是"谁写的链接"。
    出边/入边的方向差异在召回结果里已经由 ReMe 给出（``link_expansion``），
    这里不必再重复一遍，重复只会让图变乱。
    """
    index = _path_index(entries)
    titles = {entry.path: entry.title for entry in entries}
    kinds = {entry.path: entry.kind for entry in entries}
    degree: dict[str, int] = {entry.path: 0 for entry in entries}
    edges: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    dangling: list[tuple[str, str]] = []

    for entry in entries:
        for link in entry.links:
            target = _resolve(link, index)
            if target is None:
                dangling.append((entry.path, link))
                continue
            if target == entry.path:
                # 自指链接（正文里提到自己）不画成自环：它不表达任何关系，
                # 但会让这个节点的度虚高。
                continue
            key = (min(entry.path, target), max(entry.path, target))
            if key in seen:
                continue
            seen.add(key)
            edges.append((entry.path, target))
            degree[entry.path] = degree.get(entry.path, 0) + 1
            degree[target] = degree.get(target, 0) + 1

    nodes = [
        MemoryGraphNode(
            path=entry.path,
            title=titles.get(entry.path, entry.name),
            kind=kinds.get(entry.path, OTHER_KIND),
            degree=degree.get(entry.path, 0),
        )
        for entry in entries
        # 只画连上边的节点：孤立文件放进图里就是一堆散点，
        # 它们已经在列表里了，图要回答的是"结构"。
        if degree.get(entry.path, 0) > 0
    ]
    nodes.sort(key=lambda node: (-node.degree, node.path))
    return MemoryGraph(nodes=nodes, edges=edges, dangling=dangling)


# --------------------------------------------------------------------- 召回
#
# 这一节是 v0.46 的"去服务化"落点：召回在本地做，读的就是上面那些函数读的同一批
# 文件。**没有任何索引、没有第二处数据**——所以也不存在"索引跟不跟得上编辑"这个
# 问题（原先那个问题要解释 ReMe 的 5 秒 debounce，见设计文档 §3.3）。


def _frontmatter_lines(text: str) -> int:
    """frontmatter 占掉的行数。行号必须报**文件里的真实行号**：用户拿着它去
    编辑器里找那一行，前移几行就会找错地方。"""
    match = _FRONTMATTER.match(text)
    if not match:
        return 0
    raw = match.group(0)
    return raw.count("\n") + (0 if raw.endswith("\n") else 1)


def _split_blocks(text: str) -> list[tuple[int, int, str]]:
    """把正文切成"块"：``(起始行, 结束行, 正文)``，行号 **1 起、相对整个文件**。

    切法（三条规则，都为了对上人写记忆的习惯）：

    1. **空行分段**：连续非空行是一块；
    2. **顶格的标题或列表项另起一块**：日笔记里一条 `- ` 就是一条记忆，
       把它们粘成一整块，召回就分不清"命中哪一条"（行号也会是整节的）；
    3. **缩进的列表项不切开**：它是上一条的子内容，切开会让同一条记忆被拆成两半。

    超过 ``MAX_BLOCK_LINES`` 行的块再按行数切开：没有空行的长正文很常见，
    不切的话一次命中会把整节内容全带进上下文。
    """
    lines = text.splitlines()
    offset = _frontmatter_lines(text)
    out: list[tuple[int, int, str]] = []
    start = 0
    buf: list[str] = []

    def flush() -> None:
        nonlocal start, buf
        if not buf:
            return
        for index in range(0, len(buf), MAX_BLOCK_LINES):
            window = buf[index : index + MAX_BLOCK_LINES]
            out.append(
                (start + index, start + index + len(window) - 1, "\n".join(window).strip())
            )
        buf = []

    for number, raw in enumerate(lines[offset:], start=offset + 1):
        if not raw.strip():
            flush()
            continue
        if buf and _BLOCK_START.match(raw):
            flush()
        if not buf:
            start = number
        buf.append(raw.rstrip())
    flush()
    return [(begin, end, body) for begin, end, body in out if body]


#: 疑问词与纯客套词：**不算检索证据**（见 ``_requirement_terms``）。
#:
#: 它们描述的是"我要问什么"，不是"这段记忆在说什么"——拿它们当证据，
#: 等于要求记忆里也写着"什么时候"这四个字。实测两种坏法各一例：
#: 「复盘什么时候做」在只写了「复盘固定每周五下午做」的记忆上被判成不相关
#: （"什么时候"没命中，于是三个单位只中一个）；反过来，
#: 「用户的时间安排」这类问题会因为蹭上「用户」而更像命中。
#: 剔掉它们之后，"命中"更接近用户的直觉：**记忆里有没有你问的那件事**。
#:
#: 名单刻意短：只收"明显不承载信息"的那批（疑问 + 能不能/是否这类助动词短语）。
#: 长名单会让"搜不到"变成一件无法解释的事（用户没法知道哪个词被我们吃了）。
_FILLER_WORDS = frozenset(
    {
        "什么",
        "什么样",
        "什么时候",
        "怎么",
        "怎么样",
        "怎样",
        "为什么",
        "如何",
        "多少",
        "多久",
        "几点",
        "哪里",
        "哪个",
        "哪些",
        "哪种",
        "何时",
        "谁",
        "是否",
        "能不能",
        "可不可以",
        "有没有",
        "是不是",
        "要不要",
    }
)


def _requirement_terms(query: str) -> list[str]:
    """查询的**实词**（走 ``services/retrieval/coverage.py`` 那份切分，再剔掉疑问词）。

    用**与文档检索同一套中文切法**（jieba + 去掉单字虚词）：两处对"什么算一个词"
    的看法就不会漂；但**只用它的分词器，不碰它的索引**——记忆池与文档池永不混池（§2.1）。

    疑问词在 ``_FILLER_WORDS`` 里单独剔掉（理由写在那个常量上）。
    查询里一个实词都不剩时返回空：那时只剩字对那条通道（见 ``_word_pairs``）。
    """
    return [word for word in content_terms(query) if word not in _FILLER_WORDS]


def _word_pairs(query: str) -> list[str]:
    """查询的**相邻字对**（去空格后的滑动二元组，保序去重）。

    **为什么除了词还要字对**：分词是 jieba 做的，它切出来的东西与正文里的写法
    可能对不上——实测「发布前要先跑什么」被切成 `发布 / 前要 / 什么`，
    而正文里写的是"发布前必须先跑一遍"，于是"前要"这个词永远命中不了，
    去掉疑问词后只剩两个单位、命中一个，覆盖率刚好卡在线上（**明明记过这句话
    却差点搜不出来**）。字对不依赖分词：`发布 / 布前 / 先跑` 都能在正文里找到。

    字对单独成一条通道（两条通道任一条通过即算命中），**不是与词混在一张表里
    数覆盖率**：混在一起会把词那一侧的覆盖率压下去（实测那样做会把
    「用户偏好什么样的回答风格」这种正常提问误判成不相关）。
    """
    flat = "".join((query or "").split())
    pairs: list[str] = []
    for index in range(len(flat) - 1):
        pair = flat[index : index + 2]
        if pair not in pairs:
            pairs.append(pair)
    return pairs


def _evidence(units: list[str], haystack: str) -> tuple[list[str], float]:
    """一条通道的命中：``(命中的单位, 覆盖率)``。"""
    if not units:
        return [], 0.0
    hit = [unit for unit in units if unit in haystack]
    return hit, len(hit) / len(units)


def _passes(hit: list[str], units: list[str]) -> bool:
    """这条通道算不算命中（判据见 ``MIN_MATCHED_TERMS`` / ``MIN_TERM_COVERAGE``）。

    "至少两个单位"**只对 3 个以上单位的查询成立**：一两个单位的短查询本来就没什么
    可蹭的，命中一个就是 1/2（或 1/1）的覆盖——再要求"必须全中"会把正常提问挡在门外
    （实测：「发布前要先跑什么」剔掉疑问词后只剩 `发布 / 前要` 两个单位，
    而「前要」是分词的产物、正文里根本没有；要求两个都中，这条真记忆就搜不出来了）。
    """
    if not units:
        return False
    floor = MIN_MATCHED_TERMS if len(units) >= 3 else 1
    return len(hit) >= floor and len(hit) / len(units) >= MIN_TERM_COVERAGE


def _clip(text: str) -> str:
    """把片段压到 ``MAX_HIT_CHARS``，**按整行截**（截断的痕迹要说出来）。"""
    if len(text) <= MAX_HIT_CHARS:
        return text
    kept: list[str] = []
    used = 0
    for line in text.splitlines():
        if used + len(line) > MAX_HIT_CHARS:
            break
        kept.append(line)
        used += len(line) + 1
    return "\n".join(kept) + "\n…"


def _retrievable_paths(workspace: Path) -> list[Path]:
    """召回池里的那些文件（``_INDEXED_KINDS`` 对应的分类）。"""
    workspace = workspace.resolve()
    out: list[Path] = []
    for target in _iter_markdown(workspace):
        try:
            if classify(_relative(workspace, target)) in _INDEXED_KINDS:
                out.append(target)
        except (OSError, ValueError):
            logger.warning("记忆文件路径解析失败，跳过：%s", target, exc_info=True)
    return out


def _block_records(workspace: Path, target: Path) -> list[MemoryBlock]:
    """一个文件 → 若干块（带该文件的标题与摘要，供加权用）。"""
    raw = target.read_bytes().decode("utf-8", errors="replace")
    rel = _relative(workspace, target)
    meta, body = parse_frontmatter(raw)
    kind = classify(rel)
    title = _title_of(body, meta, target.name, kind=kind)
    summary = _summary_of(meta)
    return [
        MemoryBlock(
            path=rel,
            title=title,
            summary=summary,
            start_line=begin,
            end_line=end,
            text=body_text,
        )
        for begin, end, body_text in _split_blocks(raw)
    ]


def search(
    workspace: Path,
    query: str,
    *,
    limit: int = DEFAULT_RECALL,
    per_file: int = MAX_HITS_PER_FILE,
) -> list[MemoryMatch]:
    """在召回池里找回相关的块。**纯本地、纯函数式的一次扫描**（没有索引可查）。

    **两条证据通道，命中判据是"任一条通过"**（都是词面证据，都不依赖索引）：

    - **实词**（jieba 切出来的词）：查询里的词出现在这一块里多少；
    - **相邻字对**（不依赖分词的滑动二元组）：绕开"jieba 的切法与正文写法不一致"
      这类漏检（见 ``_word_pairs`` 的实测例子）。

    每条通道各自算覆盖率（``MIN_TERM_COVERAGE``）与命中个数（``MIN_MATCHED_TERMS``），
    **哪个通过算哪个**；两者分开算、不混在一张表里（混着数会把正常提问的覆盖率
    压到线下，实测过）。命中结果里的 ``coverage`` 给的是通过那条通道的比例。

    打分（只用于排序，口径写在这里免得下一个人猜）：

    ``score = Σ(证据权重 × (1 + ln 频次))``，标题/路径/摘要命中再乘 ``HEAD_BONUS``，
    查询原样出现再加 ``PHRASE_BONUS``。权重是 ``ln(1 + 块数 / (1 + 出现块数))``
    ——一份日笔记里到处都是「用户」，「用户」就不该和「锂价」一样重。

    **命中与否不看分数**：分数是量纲量、跨查询不可比；判据是归一化的，
    于是"没召回任何东西"永远只有一个含义：**这几份记忆里确实没有相关的话**
    （关着时是另一回事：那时直接报错）。

    每个文件最多贡献 ``per_file`` 条：没有这条限制，一次召回很容易被某一份长
    日笔记占满，而召回的价值恰恰在于从多个文件里凑线索。
    """
    text = " ".join((query or "").split())
    if not text:
        return []
    words = _requirement_terms(text)
    pairs = _word_pairs(text)
    if not words and not pairs:
        # 单字查询（「锂」）：没有词、也没有字对，退化成"整串出现即命中"。
        # 用户明确只搜这一个字时就该按它搜——返回空比"低精度的一堆"更让人困惑。
        words = [text.casefold()]
    phrase = text.casefold()

    blocks: list[MemoryBlock] = []
    for target in _retrievable_paths(workspace):
        try:
            blocks.extend(_block_records(workspace, target))
        except OSError:
            # 一份读不了的文件不该让整次召回失败（同 ``scan`` 的处置）
            logger.warning("读记忆文件失败，跳过：%s", target, exc_info=True)
    if not blocks:
        return []

    folded = [block.text.casefold() for block in blocks]
    total = len(blocks)

    def weight_of(unit: str) -> float:
        """这个证据有多稀缺（出现在越少的块里越值钱）。"""
        seen = sum(1 for hay in folded if unit in hay)
        return math.log(1 + total / (1 + seen))

    matched: list[MemoryMatch] = []
    for block, hay in zip(blocks, folded, strict=True):
        hit_words, word_ratio = _evidence(words, hay)
        hit_pairs, pair_ratio = _evidence(pairs, hay)
        # 先看实词那条；它不过再看字对那条（两条都不混着数，理由见上面的说明）
        if _passes(hit_words, words):
            hit, coverage = hit_words, word_ratio
        elif _passes(hit_pairs, pairs):
            hit, coverage = hit_pairs, pair_ratio
        else:
            continue
        score = sum(weight_of(unit) * (1.0 + math.log(hay.count(unit))) for unit in hit)
        head = f"{block.title} {block.path} {block.summary}".casefold()
        if any(unit in head for unit in hit):
            score *= HEAD_BONUS
        if len(text) >= 2 and phrase in hay:
            score += PHRASE_BONUS
        matched.append(
            MemoryMatch(
                text=_clip(block.text),
                path=block.path,
                start_line=block.start_line,
                end_line=block.end_line,
                score=score,
                coverage=coverage,
            )
        )

    matched.sort(key=lambda item: (-item.score, item.path, item.start_line))
    picked: list[MemoryMatch] = []
    used: dict[str, int] = {}
    for item in matched:
        if used.get(item.path, 0) >= per_file:
            continue
        used[item.path] = used.get(item.path, 0) + 1
        picked.append(item)
    return picked[: max(1, limit)]


def links_of(entries: list[MemoryFile], paths: list[str]) -> list[tuple[str, str, str]]:
    """命中集合的邻接边：``(对端路径, 方向, 显示名)``。

    出链来自命中文件正文里的 ``[[…]]``，入链来自"哪些文件链到了命中文件"。
    两边都只用 ``scan`` 已经读到的出链，**不额外读任何文件**——所以这一步是
    免费附带的（原先是 ReMe 在同一份响应里给的 ``link_expansion``）。

    链接解析沿用图谱那一套（全路径/文件名/主干名都认，重名不猜）：
    同一个链接在图谱里连得上、在这里也必须连得上。
    """
    wanted = list(dict.fromkeys(path for path in paths if path))
    if not wanted:
        return []
    index = _path_index(entries)
    titles = {entry.path: entry.title for entry in entries}
    wanted_set = set(wanted)
    out: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str]] = set()

    def add(path: str, direction: str) -> None:
        key = (path, direction)
        if key in seen or path in wanted_set or len(out) >= MAX_LINKS:
            return
        seen.add(key)
        out.append((path, direction, titles.get(path, Path(path).name)))

    for entry in entries:
        for link in entry.links:
            target = _resolve(link, index)
            if target is None:
                continue
            # 命中文件 → 对端是出链；其它文件 → 对端是命中文件时算入链
            if entry.path in wanted_set:
                add(target, "out")
            elif target in wanted_set:
                add(entry.path, "in")
    return out


def entry_texts(workspace: Path) -> list[str]:
    """工作区里**所有** ``- `` 条目的正文（跨全部文件，含核心文件）。

    给"同一件事别反复写"用（见 ``MemoryService.capture`` 的去重）。
    **只认单行条目的那一行**：去重比对要的是一个稳定的短指纹，
    不是完整正文——把多行 bullet 整段拿来比，只会让"意思一样但排版不同"漏过去。
    """
    workspace = workspace.resolve()
    out: list[str] = []
    for target in _iter_markdown(workspace):
        try:
            text = target.read_bytes().decode("utf-8", errors="replace")
        except OSError:
            logger.warning("读记忆文件失败，跳过：%s", target, exc_info=True)
            continue
        _, body = parse_frontmatter(text)
        for line in body.splitlines():
            entry = _BULLET.sub("", line).strip() if _BULLET.match(line) else ""
            if entry:
                out.append(entry)
    return out


def stats(workspace: Path) -> WorkspaceStats:
    """工作区的本地状态：几份文件、其中几份可召回、可召回条数、最后改动时间。

    ``entry_count`` 用**与 ``search`` 同一个切块器**数出来：这个数字的含义就是
    "召回最多能给出多少条线索"，另算一套口径的话，界面上那个数字迟早和召回对不上。

    没有索引也就没有"索引时间"：召回每次按需扫工作区，所以这里如实给
    "内容最后变更时间"（界面上写"上次更新"）。
    """
    workspace = workspace.resolve()
    targets = _iter_markdown(workspace)
    retrievable: list[Path] = []
    latest = 0.0
    for target in targets:
        try:
            latest = max(latest, target.stat().st_mtime)
            if classify(_relative(workspace, target)) in _INDEXED_KINDS:
                retrievable.append(target)
        except (OSError, ValueError):
            logger.warning("记忆文件状态读取失败，跳过：%s", target, exc_info=True)

    entries = 0
    for target in retrievable:
        try:
            entries += len(_split_blocks(target.read_bytes().decode("utf-8", errors="replace")))
        except OSError:
            logger.warning("读记忆文件失败，跳过：%s", target, exc_info=True)

    return WorkspaceStats(
        file_count=len(targets),
        retrievable_count=len(retrievable),
        entry_count=entries,
        last_changed_at=datetime.fromtimestamp(latest, tz=UTC).isoformat() if latest else "",
    )
