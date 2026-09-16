"""记忆工作区的**文件层**（v0.14 三期，见 ``docs/记忆层设计-v0.1.md`` §3）。

记忆就是一堆带 frontmatter 与 wikilink 的普通 Markdown（ReMe 的主张：
*Memory as File, File as Memory*）。三期要让人**看得见、改得动**这些文件，
于是这里提供四件事：列的出、读得进、写得回、连成图。

**为什么直接读本地目录，而不是转发 ReMe 的 ``list`` / ``read`` / ``write``**：

1. 这个目录是**我们自己的**（``data/memory/``，见设计文档 §2.2 的数据落点），
   ``remember`` 与 ``core_text`` 早就直接读写它了——再经 ReMe 绕一圈，
   等于"读一个自己的文本文件还得先有另一个进程活着"；
2. 界面是**随时要打开**的东西：记忆服务没起、或者用户就是想看看上次记了什么，
   这时页面不该整个空掉。**能看**与**能召回**是两件事，前者不依赖服务；
3. 少一层转发就少一处它改字段名我们要跟着改的地方。

**索引怎么办**：不用我们管。读 ReMe 的 ``config/default.yaml`` 可以看到它有
``index_update_loop`` 这个后台守护，``watch_dirs: [daily_dir, digest_dir]``、
``watch_suffixes: [md]``、``force_polling`` + 5 秒 debounce——文件一改，它自己会重新分块入库。
而它的 ``reindex`` job 写明了是 *without rescanning workspace files*，
也就是"只重建已入库分片的索引、看不见新文件"，所以**每次保存后调它是白调**。
我们的做法是：保存路径上什么都不做，``MemoryService.reindex`` 只留作手动兜底。

**这条同时划出了一条界**：只有 ``daily/`` 与 ``digest/`` 会被召回（它们才在
``watch_dirs`` 里），``MEMORY.md`` / ``SOUL.md`` 靠注入生效、不参与检索。
``MemoryFile.retrievable`` 把这件事带给界面，免得用户以为"搜不到 = 索引坏了"。

**图谱也是本地算的**（不调 ReMe 的 ``graph_snapshot``）：wikilink 就在文件正文里，
数一遍是纯函数，可测、可离线、且与"哪些还没被整合"是同一份数据。
"""

from __future__ import annotations

import logging
import os
import re
import unicodedata
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from app.core.exceptions import InvalidRequestError, NotFoundError

__all__ = [
    "CORE_KIND",
    "DAILY_KIND",
    "DIGEST_KIND",
    "MAX_LISTED_FILES",
    "MAX_READ_BYTES",
    "MAX_WRITE_BYTES",
    "MAX_WRITE_CHARS",
    "MemoryFile",
    "MemoryFileDetail",
    "MemoryGraph",
    "MemoryGraphNode",
    "classify",
    "delete_file",
    "describe",
    "graph_of",
    "parse_frontmatter",
    "read_file",
    "safe_path",
    "scan",
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

#: 顶层目录 → 分类。``memory/`` 是每日现场，``digest/`` 是整理后的长期知识。
#: 两个名字都收（``daily`` 是 ReMe 的默认，``memory`` 是 QwenPaw 那族的写法，
#: 而我们的工作区可能被任一版本初始化过）。
_TOP_LEVEL = {"memory": DAILY_KIND, "daily": DAILY_KIND, "digest": DIGEST_KIND}

#: 会进检索索引的分类。**改这里之前先看 ReMe 的 watch_dirs**（见 ``retrievable``）。
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

    **这是实测得出的一条分界**（读 ReMe 的 ``config/default.yaml``）：
    它的索引守护只盯 ``watch_dirs: [daily_dir, digest_dir]``，也就是只有
    ``daily/`` 与 ``digest/`` 下的文件进了检索索引。``MEMORY.md`` / ``SOUL.md``
    走的是**注入**（每轮进 system prompt），本来就不该被检索到；其余目录下的
    Markdown 既不注入也不被召回，在这里只是一个能编辑的文本文件。

    界面必须把这条显示出来——否则用户改完一个文件却发现"搜不到"，
    会以为是索引坏了，而不是"这个位置本来就不参与检索"。"""

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


def classify(path: str) -> str:
    """按位置分类。两个核心文件按**文件名**判（它们在根下，``head`` 会是空串），
    其余按顶层目录。"""
    if Path(path).name in ("MEMORY.md", "SOUL.md"):
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
