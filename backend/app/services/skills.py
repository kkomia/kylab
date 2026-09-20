"""技能注册表（v0.15，设计见 ``docs/设计/Agent-工作区与能力层设计-v0.1.md`` §6.1）。

**技能 = 磁盘上一个带 frontmatter 的 ``SKILL.md``**（与 QwenPaw / Claude Code 同格式，
仓库里自带的那份 ``skills/kylab-knowledge-base/SKILL.md`` 就是）。它不是代码插件，
而是**写给模型看的流程与索引**——这一点决定了它的加载方式。

**加载分两段，这是它省 token 的关键**：

1. **目录注入**（``catalog``）：只把所有技能的 `name` + `description` 拼进 system prompt，
   每个技能一行。模型据此知道"有哪些能力、什么时候该用"。
2. **按需展开**（``read``）：模型决定用某个技能时，才把正文读进来。正文里指向的
   ``references/*.md`` 再按需读——**目录里的细节不进上下文**。

于是"装二十个技能"的代价是二十行文本，而不是二十篇文档。

**来源目录**（按顺序合并，同名以**先出现的**为准，因为先出现的是随代码发布的）：

- 仓库自带 ``skills/``：随代码走，如 ``kylab-knowledge-base``；
- 数据目录 ``data/skills/``：用户自己放、或以后从市场装的。

**安全**：技能是"会进模型上下文、并且能影响它怎么行动"的文本，所以它是注入面。
QwenPaw 为此有 Skill Scanner。这里做**最小必要**的两条：
可疑指令（"忽略之前的指令"这类）与疑似凭据（``sk-`` 开头的长串）会被标出来，
被标的那条**不进目录**（模型看不见 = 无法被它驱动），但**在接口里如实列出**并给出理由
——静默藏掉会让用户以为技能装失败了。技能本身**不因此获得任何工具权限**：
能不能读文件、能不能跑命令，由工作区与工具策略决定，与技能文本无关。
"""

from __future__ import annotations

import logging
import re
import shutil
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.core.exceptions import NotFoundError
from app.services.memory_files import parse_frontmatter
from app.services.runtime_config import SETTING_GROUPS

__all__ = ["SKILL_FILE", "SkillRecord", "SkillService"]

logger = logging.getLogger(__name__)

#: 技能文件名。大写是这一族的约定（Claude Code / QwenPaw 都是 `SKILL.md`）。
SKILL_FILE = "SKILL.md"

#: 描述的长度上限（注入目录时每行就该短）。
MAX_DESCRIPTION_CHARS = 400
#: 正文上限：技能是流程与索引，不是手册。超长的应该拆进 references/。
MAX_BODY_CHARS = 60_000

#: 目录注入时最多带几条。装几百个技能时，目录本身也会变成负担。
MAX_CATALOG = 60

#: ``requires`` 里认识的四个键。**与 OpenClaw 的门控字段是同一批**
#: （见《预装技能选型》§4.2）：它们都是"这个技能在这台机器上跑不跑得起来"的
#: 客观条件，而不是"我们想不想让它跑"。
REQUIRE_KEYS = ("config", "binaries", "env", "os")

#: ``sys.platform`` → 写在技能里的平台名。
_PLATFORMS = {"linux": "linux", "darwin": "darwin", "win32": "windows"}

#: 疑似"试图操纵模型"的写法。命中**不足以判断恶意**（安全文档里也可能出现这些词），
#: 所以处置是"不进目录 + 标出来给人看"，而不是拒绝加载或报错。
_INJECTION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("忽略先前指令", re.compile(r"忽略(之前|上面|前面|以上)的?(所有)?指令", re.I)),
    (
        "ignore previous",
        re.compile(r"ignore\s+(all\s+)?(previous|prior|above)\s+instructions?", re.I),
    ),
    (
        "要求泄露系统提示",
        re.compile(r"(泄露|输出|reveal|print).{0,10}(system\s*prompt|系统提示)", re.I),
    ),
    ("伪装成系统消息", re.compile(r"</?(system|assistant)>|\[\s*system\s*\]", re.I)),
)

#: 疑似凭据。技能里**不该**出现密钥——需要凭据的地方走环境变量或设置页。
_CREDENTIAL_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("疑似 API Key", re.compile(r"\b(sk|ak|ghp|xox[baprs])[-_][A-Za-z0-9_\-]{16,}")),
    ("疑似私钥", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    (
        "疑似令牌赋值",
        re.compile(r"(api[_-]?key|token|secret)\s*[:=]\s*['\"][^'\"]{20,}['\"]", re.I),
    ),
)


@dataclass(frozen=True, slots=True)
class SkillRecord:
    """一个技能。``body`` 只在 ``read`` 时取，列表里不带（省内存也省不住什么，
    但它提醒调用方"目录注入只用得到 name + description"）。"""

    name: str
    description: str
    path: str
    """``SKILL.md`` 的绝对路径（界面上要能点开看，排错时也要能找到它）。"""
    source: str
    """``builtin`` = 仓库自带；``user`` = 数据目录里用户放的。"""
    directory: str
    """技能目录（``references/`` 相对它解析）。"""
    used_by_prompt: bool = True
    """会不会进 system prompt 的目录。被安全扫描拦下的为 ``False``。"""
    flagged: tuple[str, ...] = ()
    """拦下来的原因（人话）。空 = 没发现问题。"""

    @property
    def slug(self) -> str:
        """``name`` 的规范化形式，用来做事后查找（大小写与空格不敏感）。"""
        return normalize_name(self.name)


def normalize_name(raw: str) -> str:
    return " ".join((raw or "").split()).strip().casefold()


class SkillService:
    """扫描并读取技能。**无状态**：每次调用重新扫磁盘。

    为什么不缓存：技能是文件，用户可能刚刚往目录里丢了一个（这正是它比"装插件"
    轻的地方）。扫一次是几十毫秒的重活里最轻的那种，而缓存要处理失效——
    为省这点开销引入一套失效逻辑不划算。真到几百个技能时再加 mtime 缓存。
    """

    def __init__(
        self,
        data_dir: Path,
        *,
        builtin_dir: Path | None = None,
        config_value: Callable[[str], str] | None = None,
        binaries: Callable[[str], str | None] | None = None,
    ) -> None:
        #: 读一个运行期配置的值（``requires.config`` 用它判定）。
        #: **不给就是"读不到"**，于是带 requires 的技能不出现——那一侧的默认必须是
        #: "不宣称自己能跑"，反过来的话，一个没接配置的部署会把技能摆在目录里，
        #: 模型照它做然后失败在最后一步。
        self._config_value = config_value
        self._binaries = binaries or shutil.which
        self._data_dir = data_dir
        # 仓库自带的技能目录：`backend/app/services/skills.py` 往上四层是仓库根。
        # 允许注入是为了测试能指到临时目录，而不是去猜相对层级。
        self._builtin_dir = builtin_dir or Path(__file__).resolve().parents[3] / "skills"

    # ------------------------------------------------------------------ 读

    def list(self) -> list[SkillRecord]:
        """全部技能（含被拦下的）。顺序：仓库自带在前，然后按名字。"""
        found: dict[str, SkillRecord] = {}
        for source, root in (("builtin", self._builtin_dir), ("user", self._data_dir / "skills")):
            for directory in self._skill_dirs(root):
                record = self._load(directory, source=source)
                if record is None:
                    continue
                # 先出现的优先：随代码发布的那份是"我们调过的版本"
                found.setdefault(record.slug, record)
        return sorted(found.values(), key=lambda item: (item.source != "builtin", item.name))

    def get(self, name: str) -> SkillRecord:
        wanted = normalize_name(name)
        for record in self.list():
            if record.slug == wanted:
                return record
        raise NotFoundError(f"没有这个技能：{name}")

    def read(self, name: str) -> tuple[SkillRecord, str]:
        """取技能正文（按需展开那一步）。"""
        record = self.get(name)
        text = (Path(record.directory) / SKILL_FILE).read_text(encoding="utf-8")
        _, body = parse_frontmatter(text)
        return record, body.strip()

    def catalog(self) -> str:
        """拼成注入 system prompt 的**目录**；没有可用技能时是空串。

        写法上刻意模仿"工具清单"而不是"文档目录"：每行
        ``- <name>：<description>``，并明确告诉模型"要用的时候先读它"。
        不加这句的话，模型会凭 description 猜内容然后直接答——那正是技能最容易被
        用错的方式（它以为知道流程，其实细节在正文里）。
        """
        usable = [item for item in self.list() if item.used_by_prompt][:MAX_CATALOG]
        if not usable:
            return ""
        lines = [f"- {item.name}：{item.description}".rstrip("：") for item in usable]
        return (
            "【可用技能】下面这些是本环境里可用的技能（名字：什么时候用）。"
            "需要按某个技能的流程做事时，**先用 `read_skill` 把它的正文读出来**，"
            "不要只凭这一行描述就动手——细节在正文里。\n" + "\n".join(lines)
        )

    # ------------------------------------------------------------------ 内部

    def _skill_dirs(self, root: Path) -> list[Path]:
        """找 ``<root>/<name>/SKILL.md`` 与 ``<root>/<group>/<name>/SKILL.md``。

        **只走两层**：再深就是"把别人的仓库整个拷进来"，那会让扫描变成遍历。
        跳过隐藏目录与 ``node_modules``／``__pycache__`` 这类明显的非技能目录。
        """
        out: list[Path] = []
        if not root.is_dir():
            return out
        for first in sorted(root.iterdir()):
            if not first.is_dir() or first.name.startswith((".", "_")):
                continue
            if (first / SKILL_FILE).is_file():
                out.append(first)
                continue
            for second in sorted(first.iterdir()):
                if not second.is_dir() or second.name.startswith((".", "_")):
                    continue
                if (second / SKILL_FILE).is_file():
                    out.append(second)
        return out

    def _load(self, directory: Path, *, source: str) -> SkillRecord | None:
        """读一个技能目录。**坏文件不抛错**：一个技能写坏了不该让整个列表 500。

        捕获里必须带上 ``UnicodeDecodeError``——它是 ``ValueError`` 的子类，
        **不是 ``OSError``**，只写 ``except OSError`` 会被它直接穿透（真踩过：
        一个非法 UTF-8 的 SKILL.md 让整个技能列表 500）。同一个坑在
        ``memory_files._entry_of`` 里也踩过一次，处置不同是有意的：
        那边是"替换成 U+FFFD 也要把文件打开"（用户是进去修它的），
        这里是"**跳过**"——技能描述会被注入提示词，带着乱码的描述比没有描述更糟。
        """
        path = directory / SKILL_FILE
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            logger.warning("读技能失败（跳过）：%s", path, exc_info=True)
            return None
        meta, _body = parse_frontmatter(text)
        name = str(meta.get("name") or directory.name).strip()
        description = str(meta.get("description") or "").strip()
        if not name:
            return None
        if len(description) > MAX_DESCRIPTION_CHARS:
            description = description[:MAX_DESCRIPTION_CHARS] + "…"
        # 没有 description 的技能**没法被正确触发**（目录里那一行就是触发条件），
        # 所以它不进目录——但要出现在列表里，让用户知道"这个装了但用不上"。
        flagged: list[str] = []
        if not description:
            flagged.append(
                "缺少 description：目录里那一行是模型判断「何时该用」的唯一依据，"
                "没有它这个技能不会被触发"
            )
        flagged.extend(_scan(text))
        flagged.extend(self._unmet(meta))
        return SkillRecord(
            name=name,
            description=description,
            path=str(path),
            source=source,
            directory=str(directory),
            used_by_prompt=not flagged,
            flagged=tuple(flagged),
        )


    def _unmet(self, meta: dict[str, Any]) -> list[str]:
        """``requires`` 里**没满足**的那几项，回人话理由。

        为什么用具名键而不是一句自由文本：这些是**可以自动判的客观条件**
        （配置有没有值、命令在不在 PATH 上、平台对不对），而自由文本只能靠人读。
        调研 §4.2 抄的就是这个做法——预装 ≠ 默认开启，没装依赖的用户
        **根本看不到**那个技能，而不是看到一个点了就报错的技能。

        处置与"疑似注入"完全一致（那条路也是 ``used_by_prompt=False`` + 理由）：
        不进模型目录，但在界面里如实列出**并说明差什么**——静默藏掉会让用户
        以为技能装失败了。
        """
        raw = meta.get("requires")
        if not isinstance(raw, dict):
            return []
        reasons: list[str] = []
        for key in REQUIRE_KEYS:
            if key not in raw:
                continue
            if key == "config":
                reasons.extend(self._unmet_config(raw["config"]))
            elif key == "binaries":
                reasons.extend(_unmet_binaries(raw["binaries"], self._binaries))
            elif key == "env":
                reasons.extend(_unmet_env(raw["env"]))
            elif key == "os":
                reasons.extend(_unmet_os(raw["os"]))
        unknown = [key for key in raw if key not in REQUIRE_KEYS]
        if unknown:
            # 拼错的键（`require:` / `bins:`）**必须报出来**：不报的话，
            # 那个条件等于没写，而写它的人以为已经门控住了
            reasons.append(
                f"requires 里有不认识的键：{'、'.join(sorted(unknown))}"
                f"（只有 {'、'.join(REQUIRE_KEYS)}）"
            )
        return reasons

    def _unmet_config(self, raw: Any) -> list[str]:
        keys = [str(item) for item in _as_list(raw)]
        missing = [
            key for key in keys if not (self._config_value or (lambda _key: ""))(key).strip()
        ]
        if not missing:
            return []
        where = "、".join(_config_label(key) for key in missing)
        return [f"需要先配置：{where}（这个技能要用的能力还没接上）"]


def _as_list(raw: Any) -> list[Any]:
    """``config: web.search_api_key`` 与 ``config: [a, b]`` 都认。

    两种写法都收是有意的：只写一项时不必为其套一层列表（写技能的人会那么写），
    而写成自由字符串又必须能按**单个键**解析——按字符拆会把键名拆碎。
    """
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        return [item for item in raw if str(item).strip()]
    text = str(raw).strip()
    return [text] if text else []


def _config_label(key: str) -> str:
    """配置键 → 界面上的说法（``「设置 → 联网」里的「搜索 API 密钥」``）。

    不写键名给用户看：``web.search_api_key`` 是代码里的东西，
    而他要找的是界面上那个输入框。找不到就退回键名——**宁可难看也别编**。
    """
    for group in SETTING_GROUPS.values():
        for field in group.get("fields", []):
            if field.get("key") == key:
                return f"「设置 → {group.get('label', '')}」里的「{field.get('label', key)}」"
    return key


def _unmet_binaries(raw: Any, which: Callable[[str], str | None]) -> list[str]:
    missing = [str(name) for name in _as_list(raw) if not which(str(name))]
    if not missing:
        return []
    return [f"需要这台机器上装了命令：{'、'.join(missing)}（没找到就说明这个技能跑不起来）"]


def _unmet_env(raw: Any) -> list[str]:
    import os

    missing = [str(name) for name in _as_list(raw) if not os.environ.get(str(name))]
    if not missing:
        return []
    return [f"需要环境变量：{'、'.join(missing)}"]


def _unmet_os(raw: Any) -> list[str]:
    wanted = {str(item).strip().lower() for item in _as_list(raw)}
    if not wanted:
        return []
    current = _PLATFORMS.get(sys.platform, sys.platform)
    if current in wanted:
        return []
    return [f"只在 {'、'.join(sorted(wanted))} 上用（当前是 {current}）"]


def _scan(text: str) -> list[str]:
    """安全扫描：返回人话理由（可能多条）。见模块头对"为什么只是标出来"的说明。"""
    reasons: list[str] = []
    for label, pattern in _INJECTION_PATTERNS:
        if pattern.search(text):
            reasons.append(f"疑似提示注入（{label}）：这条技能不会进模型的技能目录")
    for label, pattern in _CREDENTIAL_PATTERNS:
        if pattern.search(text):
            reasons.append(f"{label}：技能里不该存凭据，请改成从设置或环境变量取")
    return reasons
