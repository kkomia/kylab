"""技能市场（v0.16，设计见 ``docs/Agent-工作区与能力层设计-v0.1.md`` §6.1）。

技能是"会进模型上下文、并且能影响它怎么行动"的文本，所以**市场是这一层风险最高的入口**：
它把"从一个别处拿来的东西"直接放进提示词。QwenPaw 为此有 Skill Scanner 与
whitelist 机制。这里做三件必须做的事，其余的（签名、评分、举报）等有真市场再说：

1. **安装前扫描**（复用 ``services.skills`` 的扫描）：命中注入特征就**拒绝安装**
   （不是"装上去但标一下"——安装是主动引入，与扫描磁盘上已有的技能是两回事）；
2. **解压防护**：zip 里的路径要防"zip slip"（``../../x`` 写到仓库外）与
   符号链接（链到别处去），并限制条目数与总解压大小（zip 炸弹）；
3. **可追溯**：记下每个技能是从哪个源装的（写进 frontmatter 之外的一个小清单文件），
   这样"这玩意儿哪来的"永远答得出来，卸载也能只删该删的。

**源的形式**（都不需要新依赖）：

- 本地目录：``<catalog>/<技能名>/SKILL.md``——开发期最常用；
- 本地/远端 zip：``file://…/x.zip``、``https://…/x.zip``——分发形态；
- 索引（``catalog.json``）：
  ``{"skills": [{"name": "...", "description": "...", "source": "..."}]}``，
  本地路径或 http(s) URL 都行。

**没有真市场服务时它照样可用**：指向一个本地目录或一个 zip 就能装。
"市场"是这个服务的一种用法，不是它的前提。
"""

from __future__ import annotations

import io
import json
import logging
import shutil
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

from app.core.exceptions import ConflictError, InvalidRequestError, NotFoundError, UpstreamError
from app.services.skills import SKILL_FILE, SkillService, _scan, normalize_name

__all__ = ["CatalogEntry", "SkillMarketService"]

logger = logging.getLogger(__name__)

#: 索引文件的名字（放在源目录里）。空市场就是没有这个文件。
CATALOG_FILE = "catalog.json"

#: 装过哪些技能（写进数据目录）。**一行一个来源**，用来回答"这玩意儿哪来的"，
#: 也让卸载只删该删的（仓库自带的技能不在里面，所以删不掉）。
INSTALLED_FILE = "installed.json"

#: 单次下载的上限。市场拿来的东西**先假定它是坏的**：一个 500MB 的 zip
#: 会在解压前就把磁盘吃完。
MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024

#: 解压后的上限（zip 炸弹：一个几 KB 的 zip 能解出几个 GB）。
MAX_UNPACKED_BYTES = 32 * 1024 * 1024

#: 条目数上限（同上，防"十万个空文件"这类）。
MAX_ENTRIES = 500

#: 单个技能目录里允许的文件名。**白名单**：技能是文本，不该带可执行文件进来。
_ALLOWED_SUFFIXES = (".md", ".txt", ".json", ".yaml", ".yml", ".csv")


@dataclass(frozen=True, slots=True)
class CatalogEntry:
    """索引里的一条。``source`` 是它的取用地址（相对目录或 URL）。"""

    name: str
    description: str = ""
    source: str = ""
    installed: bool = False


class SkillMarketService:
    """技能的安装 / 卸载 / 索引。

    **只写 ``data/skills/``**：仓库自带的 ``skills/`` 是随代码发布的，
    市场动不了它（``uninstall`` 也删不掉它）。这条边界很重要——
    否则一次误操作就能改掉"我们审过的那个版本"。
    """

    def __init__(self, data_dir: Path, skills: SkillService) -> None:
        self._data_dir = data_dir
        self._skills = skills

    @property
    def install_root(self) -> Path:
        return self._data_dir / "skills"

    @property
    def installed_index(self) -> Path:
        return self._data_dir / INSTALLED_FILE

    # ------------------------------------------------------------------ 索引

    def catalog(self, source: str) -> list[CatalogEntry]:
        """读一个源的索引。

        ``source`` 可以是目录（找里面的 ``catalog.json``），也可以直接是
        那个 json 文件/URL。**没有索引文件不算错**——那表示"这个源没有可浏览的清单"，
        此时用户仍然可以按名字直接装（``install(name, source=<目录>``）。
        """
        try:
            raw, origin = self._fetch(source)
        except NotFoundError:
            return []
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise InvalidRequestError(f"源的索引不是合法 JSON（{origin}）：{exc}") from exc

        items = data.get("skills") if isinstance(data, dict) else data
        if not isinstance(items, list):
            raise InvalidRequestError(f"索引格式不对（{origin}）：应当是 {{'skills': [...]}}")

        installed = {record.slug for record in self._skills.list() if record.source == "user"}
        out: list[CatalogEntry] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            out.append(
                CatalogEntry(
                    name=name,
                    description=str(item.get("description") or ""),
                    source=str(item.get("source") or name),
                    installed=normalize_name(name) in installed,
                )
            )
        return out

    def installed(self) -> dict[str, str]:
        """已装清单：``技能名 → 来源``。"""
        try:
            data = json.loads(self.installed_index.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}

    # ------------------------------------------------------------------ 安装

    def install(self, name: str, *, source: str, catalog: str = "") -> str:
        """装一个技能，返回它落到的目录（绝对路径）。

        ``source`` 三形态都认，**按顺序判断**：先看是不是 URL，再看是不是 zip，
        最后当目录处理。判断顺序不能反：Windows 上 ``C:/x.zip`` 既像盘符路径
        又像 URL，先判 URL 会把它当 http 去请求。
        """
        clean = (name or "").strip()
        if not clean:
            raise InvalidRequestError("缺少参数：name")
        target = self.install_root / _safe_dirname(clean)
        if target.exists():
            raise ConflictError(
                f"已经装过「{clean}」了。要更新请先卸载，或换个名字装成两份。"
            )

        payload, origin = self._resolve_source(name, source=source, catalog=catalog)
        if payload is None:
            raise NotFoundError(f"源里没有这个技能：{clean}（来自 {origin}）")
        raw_name, blob = payload

        # **按类型分派**，不能按"有没有 is_dir"猜：zip 形态的载荷是 ``bytes``，
        # 而 bytes 没有 is_dir（写这段时就是这么炸的）。目录走拷贝、字节走解压。
        #
        # **任何一步失败都要把已经落地的目录清掉**：半成品比"没装"更糟——
        # 界面上它已经被扫进技能列表了，而缺了 references/ 的它是残的。
        # 统一在一处兜住，而不是每个失败分支各写一遍 rmtree（那样迟早漏一个）。
        try:
            if isinstance(blob, Path):
                self._copy_dir(blob, target)
            else:
                self._extract_zip(blob, target)

            # **安装前扫描**（与扫描磁盘上已有技能共用同一套规则）：
            # 命中就当场拒——安装是主动引入，所以处置是拒绝而不是标注。
            flags = _scan(self._read_skill_text(target))
            if flags:
                raise InvalidRequestError(
                    f"「{raw_name}」没有通过安全检查，已拒绝安装：{'；'.join(flags)}"
                )
        except Exception:
            shutil.rmtree(target, ignore_errors=True)
            raise

        self._remember(clean, f"{origin}#{raw_name}")
        logger.info("技能已安装：%s ← %s", clean, origin)
        return str(target)

    def uninstall(self, name: str) -> None:
        """卸载。**只能卸市场装的**（仓库自带的不在清单里，所以删不掉）。"""
        clean = (name or "").strip()
        index = self.installed()
        if clean not in index:
            raise NotFoundError(
                f"「{clean}」不是从市场装的，不能在这里卸载。"
                "随代码发布的技能要改就去改仓库里的 skills/"
            )
        target = self.install_root / _safe_dirname(clean)
        shutil.rmtree(target, ignore_errors=True)
        index.pop(clean, None)
        self._write_index(index)
        logger.info("技能已卸载：%s", clean)

    # ------------------------------------------------------------------ 内部

    def _resolve_source(
        self, name: str, *, source: str, catalog: str
    ) -> tuple[tuple[str, Path | bytes] | None, str]:
        """把 ``source`` 解析成 ``(技能名, 目录 Path 或 zip 的 bytes)``。

        三种形态：zip（本地或 http）、目录、以及"目录里再找一层同名目录"。
        最后那种是**发布形态**：一个源目录里并列着若干技能目录。
        """
        text = (source or "").strip()
        if not text:
            raise InvalidRequestError("缺少参数：source（技能从哪儿来）")

        if _is_url(text):
            blob = self._download(text)
            return (name, blob), text

        path = Path(text)
        if path.is_file() and path.suffix.lower() == ".zip":
            return (name, path.read_bytes()), str(path)
        if path.is_dir():
            # 目录直接就是技能（有 SKILL.md），或者是"若干技能并列"的源目录
            if (path / SKILL_FILE).is_file():
                return (path.name, path), str(path)
            for candidate in (path / name, path / _safe_dirname(name)):
                if (candidate / SKILL_FILE).is_file():
                    return (candidate.name, candidate), str(path)
            return None, str(path)

        # 目录形态的索引：`catalog` 指着一个源目录，`source` 只是它的条目名
        if catalog:
            base = Path(catalog)
            for candidate in (base / text, base / _safe_dirname(text)):
                if (candidate / SKILL_FILE).is_file():
                    return (candidate.name, candidate), str(base)
            if base.is_file() and base.suffix.lower() == ".zip":
                return (text, base.read_bytes()), str(base)
        raise NotFoundError(f"找不到这个技能的来源：{text}")

    def _fetch(self, source: str) -> tuple[bytes, str]:
        """取索引内容。找不到就 ``NotFoundError``（调用方把它当"空清单"）。"""
        text = (source or "").strip()
        if not text:
            return b'{"skills": []}', "(空源)"
        if _is_url(text):
            return self._download(text), text
        path = Path(text)
        if path.is_dir():
            path = path / CATALOG_FILE
        if not path.is_file():
            raise NotFoundError(f"源里没有索引：{text}")
        return path.read_bytes(), str(path)

    def _download(self, url: str) -> bytes:
        """下载并**限额**。``file://`` 也走这里，所以本地源与远端源是同一条路。"""
        try:
            with urllib.request.urlopen(url, timeout=15) as response:  # noqa: S310 - 用户自己配的源
                # 先看 Content-Length：等它传完再拒等于已经把磁盘写满了
                declared = response.headers.get("Content-Length")
                if declared and int(declared) > MAX_DOWNLOAD_BYTES:
                    raise InvalidRequestError(
                        f"源太大了（{declared} 字节，上限 {MAX_DOWNLOAD_BYTES}）"
                    )
                blob = response.read(MAX_DOWNLOAD_BYTES + 1)
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise UpstreamError(f"取不到源的地址 {url}：{exc}") from exc
        if len(blob) > MAX_DOWNLOAD_BYTES:
            raise InvalidRequestError(f"源超过 {MAX_DOWNLOAD_BYTES} 字节，已中止")
        return blob

    def _copy_dir(self, source: Path, target: Path) -> None:
        """拷一个本地技能目录。同样只允许白名单后缀——本地源也不该塞可执行文件。"""
        target.mkdir(parents=True, exist_ok=True)
        total = 0
        for item in source.rglob("*"):
            if item.is_dir() or item.is_symlink():
                # **符号链接不拷**：它能把技能目录链到仓库外，而那正是
                # 我们要防的那类"看起来在目录里、其实在别处"
                if item.is_symlink():
                    logger.warning("跳过符号链接：%s", item)
                continue
            if item.suffix.lower() not in _ALLOWED_SUFFIXES:
                logger.warning("技能里只允许文本文件，跳过：%s", item)
                continue
            total += item.stat().st_size
            if total > MAX_UNPACKED_BYTES:
                raise InvalidRequestError(f"技能内容超过 {MAX_UNPACKED_BYTES} 字节")
            destination = target / item.relative_to(source)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(item.read_bytes())

    def _extract_zip(self, blob: bytes, target: Path) -> None:
        """解压 zip。**三道防护**：路径穿越、符号链接、大小与条目数。"""
        try:
            archive = zipfile.ZipFile(io.BytesIO(blob))
        except zipfile.BadZipFile as exc:
            raise InvalidRequestError(f"这不是一个合法的 zip：{exc}") from exc

        entries = archive.infolist()
        if len(entries) > MAX_ENTRIES:
            raise InvalidRequestError(f"zip 里条目太多（{len(entries)}，上限 {MAX_ENTRIES}）")

        target.mkdir(parents=True, exist_ok=True)
        total = 0
        for info in entries:
            relative = _safe_relative(info.filename)
            if relative is None:
                # zip slip：`../../x` 或绝对路径。**整包拒绝**而不是跳过那一条——
                # 一个想往仓库外写的包，里面剩下的东西不值得再信。
                raise InvalidRequestError(f"zip 里有越界路径，已拒绝整个包：{info.filename}")
            if info.is_dir():
                continue
            if _is_symlink(info):
                raise InvalidRequestError(f"zip 里有符号链接，已拒绝：{info.filename}")
            if Path(relative).suffix.lower() not in _ALLOWED_SUFFIXES:
                raise InvalidRequestError(
                    f"zip 里有非文本文件（{info.filename}）：技能只该带 Markdown 与数据"
                )
            total += info.file_size
            if total > MAX_UNPACKED_BYTES:
                raise InvalidRequestError(
                    f"解压后超过 {MAX_UNPACKED_BYTES} 字节（zip 炸弹？），已中止"
                )
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(archive.read(info))

    def _read_skill_text(self, target: Path) -> str:
        """把技能目录里的文本拼起来做扫描。

        **不止扫 SKILL.md**：references/ 里的内容同样会进模型上下文
        （模型按需读它们），所以注入特征藏在那一层同样危险。
        """
        parts: list[str] = []
        for item in sorted(target.rglob("*")):
            if item.is_file() and item.suffix.lower() in _ALLOWED_SUFFIXES:
                try:
                    parts.append(item.read_text(encoding="utf-8", errors="replace"))
                except OSError:
                    continue
        return "\n".join(parts)

    def _remember(self, name: str, origin: str) -> None:
        index = self.installed()
        index[name] = origin
        self._write_index(index)

    def _write_index(self, index: dict[str, str]) -> None:
        self.install_root.mkdir(parents=True, exist_ok=True)
        self.installed_index.write_text(
            json.dumps(index, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8"
        )


def _is_url(text: str) -> bool:
    return text.startswith(("http://", "https://", "file://"))


def _safe_dirname(name: str) -> str:
    """技能名 → 目录名。**掐掉首尾的点**：``..`` 在路径里不是名字、是导航。"""
    cleaned = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in name).strip("._")
    return cleaned or "skill"


def _safe_relative(raw: str) -> str | None:
    """zip 里的条目名 → 安全的相对路径；越界或非法返回 ``None``。

    三种要拦的：绝对路径（``/x``、``C:/x``）、``..`` 段、以及 Windows 上的反斜杠
    路径（``..\\x`` 在 POSIX 上看着人畜无害，解到 Windows 上就穿越了）。
    """
    text = (raw or "").replace("\\", "/").strip()
    if not text or text.startswith("/") or (len(text) > 1 and text[1] == ":"):
        return None
    parts = [part for part in text.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        return None
    return "/".join(parts)


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    """zip 里的符号链接：高 4 位是 Unix 权限，``0o120000`` 就是链接。"""
    mode = info.external_attr >> 16
    return (mode & 0o170000) == 0o120000
