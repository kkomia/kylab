"""旧档案 → mem0 库的**一次性搬迁**（D10）。

**只做两件事**：读 ``PROFILE.md`` 的条目、维护水位。往库里写由
``MemoryService.import_legacy`` 做（那边才有 mem0）。

三条纪律，每条都为了让这件事**能重来**：

1. **旧文件一字不动**：只读 ``PROFILE.md``，绝不写回、绝不清空、绝不重命名。
   迁移完之后那份文件还是原样——它就是"以前说过什么"的证物，
   而新的库是不是记得住，不能靠把旧东西删掉来证明；
2. **水位是"源指纹 + 已搬条目指纹"**（``<账号>/mem0/imported.json``）：
   源没变且条目都搬过 → ``skipped``，**净改动为零**；源变了（用户后来又编辑了
   旧档案）→ 只搬新出现的那些。所以这个端点可以想点几次点几次；
3. **占位行不算条目**：旧模板里那些 ``- **名字：**`` / ``- **代词：** *（可选）*``
   是给人填的骨架，不是记忆。搬进去的话，每一轮注入的都是一个空标签——
   这正是 D26 那次走查（模型每轮问"怎么称呼你"）的同一个病灶。
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

__all__ = [
    "IMPORT_WATERMARK_NAME",
    "LEGACY_FILENAME",
    "MEMORY_ROOT",
    "entry_key",
    "read_legacy",
    "read_watermark",
    "watermark_path",
    "write_watermark",
]

logger = logging.getLogger(__name__)

#: 旧档案文件名（与 ``memory.PROFILE_FILE`` 同源；这里写死是为了让本模块不 import 服务层）。
LEGACY_FILENAME = "PROFILE.md"

#: 记忆存储的根目录名（与 ``memory.MEM0_DIRNAME`` 同源）。
MEMORY_ROOT = "mem0"

#: 水位的文件名，落在 ``<账号>/mem0/imported.json``。
IMPORT_WATERMARK_NAME = "imported.json"

#: ``## 区名``。
_H2 = re.compile(r"^##\s+(.+?)\s*$")
#: ``### 项目名``（项目段的分组标题，条目在它下面）。
_H3 = re.compile(r"^###\s+(.+?)\s*$")
#: 条目行：``- x`` / ``* x`` / ``1. x``。
_BULLET = re.compile(r"^\s*(?:[-*+•]|\d+[.、)])\s+")
#: frontmatter 块。
_FRONTMATTER = re.compile(r"^---\s*\n.*?\n---\s*\n?", re.DOTALL)

#: **占位行**：``名字：`` / ``**名字：**`` / ``**代词：** *（可选）*``——
#: 只有标签没有值。它们搬进库里就是一条没有内容的记忆（见模块头第 3 条）。
_PLACEHOLDER = re.compile(r"^\*{0,2}[^：:*]{1,15}[：:]\*{0,2}(?:\s*\*?（[^）]*）\*?)?$")


def _is_placeholder(text: str) -> bool:
    """这一行是不是"给人填空的骨架"（不是一条记忆）。"""
    bare = text.replace("*", "").strip()
    if not bare or bare.endswith(("：", ":")):
        return True
    if _PLACEHOLDER.match(text.strip()):
        return True
    # 一整行都是斜体说明（``*（挑一个你喜欢的）*``）——它是旁注，不是事实
    return bool(re.fullmatch(r"\*[^*]+\*", text.strip()))


def parse_entries(text: str) -> list[tuple[str, str]]:
    """``PROFILE.md`` 的正文 → ``[(分区, 条目)]``（保序）。

    只认 ``- `` 这类条目行；``##`` 换区、``###`` 换组（组名不单独成条）。
    未知分区**照样收**（用户拿外部编辑器加的 ``## 某区``）：静默丢掉他写下的东西，
    比多几条"分区不认识"糟得多。
    """
    body = _FRONTMATTER.sub("", text or "", count=1)
    section = ""
    out: list[tuple[str, str]] = []
    for line in body.splitlines():
        stripped = line.strip()
        heading = _H2.match(stripped)
        if heading:
            section = heading.group(1).strip()
            continue
        if _H3.match(stripped):
            continue
        if stripped.startswith("#"):
            continue
        if not _BULLET.match(line):
            continue
        item = " ".join(_BULLET.sub("", stripped).split())
        if not item or _is_placeholder(item):
            continue
        out.append((section, item))
    return out


def read_legacy(source_dir: Path) -> tuple[list[tuple[str, str]], str, str]:
    """读旧档案：``(条目, 源指纹, 文件名)``。

    文件不在（新装的实例）时给 ``([], "", LEGACY_FILENAME)``——**不是错误**：
    "这儿没有旧东西要搬"是最常见的一种回答。
    """
    path = Path(source_dir) / LEGACY_FILENAME
    try:
        data = path.read_bytes()
    except OSError:
        return [], "", LEGACY_FILENAME
    text = data.decode("utf-8", errors="replace")
    return parse_entries(text), hashlib.sha256(data).hexdigest(), LEGACY_FILENAME


def entry_key(section: str, text: str) -> str:
    """一条旧条目的指纹（水位里记的就是它，用来判断"这条搬过没有"）。"""
    body = f"{section}\u0000{text}".encode()
    return hashlib.sha256(body).hexdigest()[:32]


def watermark_path(account_dir: Path) -> Path:
    """水位文件的路径：``<账号>/mem0/imported.json``（D10）。"""
    return Path(account_dir) / MEMORY_ROOT / IMPORT_WATERMARK_NAME


def read_watermark(account_dir: Path) -> dict[str, Any]:
    """读水位；文件不在或读坏时给空表（**迁移不该被自己的簿记卡住**）。

    返回的是一个**归一过**的形状（``source`` 直接是那串 sha256、
    ``entries`` 一定是列表），文件里那份带版本号的原始结构由
    :func:`write_watermark` 负责写。
    """
    try:
        raw = json.loads(watermark_path(account_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"source": "", "entries": []}
    if not isinstance(raw, dict):
        return {"source": "", "entries": []}
    source = raw.get("source")
    digest = str(source.get("sha256") or "") if isinstance(source, dict) else str(source or "")
    entries = raw.get("entries")
    return {
        "source": digest,
        "entries": [str(item) for item in entries] if isinstance(entries, list) else [],
    }


def write_watermark(account_dir: Path, *, source: str, entries: list[str]) -> None:
    """写水位（原子替换：写临时文件再 ``replace``，中途挂掉不会留下一份半截的簿记）。"""
    path = watermark_path(account_dir)
    payload = {
        "version": 1,
        "source": {"name": LEGACY_FILENAME, "sha256": source},
        "entries": sorted(entries),
        "imported_at": datetime.now(UTC).isoformat(),
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_bytes(json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"))
        temp.replace(path)
    except OSError:
        logger.warning("迁移水位写不出去（下次会重搬一遍）：%s", path, exc_info=True)
