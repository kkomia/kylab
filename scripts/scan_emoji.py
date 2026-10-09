"""扫描源码中的 emoji 字符（项目硬性禁令：UI 全链路禁 emoji）。

与 ``skills/code-quality-check/scripts/scan_emoji.py`` 同源，仓库内自带副本以便 CI 自包含；
差别是显式把标准输出切到 UTF-8，避免 GBK 控制台下的 UnicodeEncodeError。

用法：python scripts/scan_emoji.py <目录> [<目录>...]
      python scripts/scan_emoji.py --baseline scripts/baselines/emoji.txt <目录> [<目录>...]
      python scripts/scan_emoji.py --write-baseline scripts/baselines/emoji.txt <目录> [...]
退出码：0 = 未发现（或只剩基线内的存量）；1 = 发现**基线之外**的 emoji；2 = 用法错误。

## 基线（ratchet）——为什么要它

仓库里有一批 2026-09 就在代码注释里的 ``✓`` / ``✗`` / ``⚠``（六百余处）。它们与
"UI 全链路禁 emoji" 那条禁令的初衷无关，却让这条检查**永远红**——门禁一旦永远红，
它就不再是红绿灯，谁也不会再看。所以存量走基线，门禁只对**新增**报红：

- ``--baseline <文件>``：基线内的存量放行（打印"存量 N 处"），只对增量报红；
- ``--write-baseline <文件>``：把当前全部命中写成基线（修掉存量后用它收紧）；
- 两个参数都不给 = 老行为（任何一处 emoji 都红），CI 想严跑时仍可这么用。

基线按 ``<相对仓库根的路径>\t<字符>\t<处数>`` 记——**记处数，不记行号**：
改写一行既有注释不会误报，新增才会让处数变大。
基线**只准收紧**：新增条目必须在提交信息里写理由。
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

#: 仓库根（``scripts/`` 的上一级）。基线里的路径都相对它，这样门禁从哪个目录跑都一致。
REPO = Path(__file__).resolve().parents[1]

BASELINE_HEADER = (
    "# emoji 基线（ratchet）：只准收紧，新增条目必须在提交信息里写理由。\n"
    "# 格式：<相对仓库根的路径>\\t<字符>\\t<处数>；不传 --baseline 时这份文件不生效。\n"
)

# 常见 emoji Unicode 区段（杂项符号、象形文字、表情、交通符号、增补、变体选择符、区旗、键帽等）
EMOJI_RE = re.compile(
    "["
    "\U0001F000-\U0001FAFF"  # 各类象形/表情符号区
    "\U00002600-\U000027BF"  # 杂项符号 + 装饰符号
    "\U0001F1E6-\U0001F1FF"  # 区旗指示符
    "\U00002B00-\U00002BFF"  # 箭头与杂项符号
    "\U0000FE00-\U0000FE0F"  # 变体选择符
    "\U00002000-\U0000206F"  # 与 emoji 组合的极少字符，见白名单过滤
    "\U00002190-\U000021FF"  # 箭头（前端常见误用）
    "]"
)

# 文本排版合法字符白名单（引号、破折号、省略号、箭头、数学符号等不误报）
WHITELIST = set("“”‘’—–…·•‹›«»←→↑↓↔‖")

TEXT_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".vue", ".html", ".css",
    ".json", ".md", ".toml", ".yaml", ".yml", ".sql",
}

SKIP_DIRS = {"node_modules", ".git", "dist", "__pycache__", ".venv", "venv"}


def scan_file(path: Path) -> list[tuple[int, int, str]]:
    """返回 ``[(行, 列, 字符)]``。"""
    hits: list[tuple[int, int, str]] = []
    try:
        text = path.read_text(encoding="utf-8", errors="strict")
    except (UnicodeDecodeError, OSError):
        return hits
    for lineno, line in enumerate(text.splitlines(), 1):
        for match in EMOJI_RE.finditer(line):
            char = match.group()
            if char in WHITELIST:
                continue
            hits.append((lineno, match.start() + 1, char))
    return hits


def parse_args(argv: list[str]) -> tuple[list[str], Path | None, Path | None] | None:
    """拆出目录参数与 ``--baseline`` / ``--write-baseline``；用法错误时返回 None。"""
    roots: list[str] = []
    baseline: Path | None = None
    write: Path | None = None
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("--baseline", "--write-baseline"):
            if i + 1 >= len(argv):
                print(f"{arg} 需要一个文件路径", file=sys.stderr)
                return None
            if arg == "--baseline":
                baseline = Path(argv[i + 1])
            else:
                write = Path(argv[i + 1])
            i += 2
            continue
        if arg.startswith("--"):
            print(f"不认识的参数：{arg}", file=sys.stderr)
            return None
        roots.append(arg)
        i += 1
    if not roots:
        print(
            "用法: python scripts/scan_emoji.py [--baseline <文件>] <目录> [<目录>...]",
            file=sys.stderr,
        )
        return None
    return roots, baseline, write


def relative_to_repo(path: Path) -> str:
    """基线里的键一律相对仓库根，这样门禁从哪个目录跑都一致。"""
    try:
        return path.resolve().relative_to(REPO).as_posix()
    except ValueError:  # 扫到了仓库外的东西（正常不会）：退化成绝对路径
        return path.resolve().as_posix()


def collect(roots: list[str]) -> tuple[list[tuple[str, Path, int, int, str]], set[str]]:
    """扫出全部命中 ``(相对路径, 文件, 行, 列, 字符)``，外加本次**扫过**的文件集合。

    扫过的文件集合用来判断哪些基线条目本轮在管辖范围内——门禁只扫 ``backend/app``
    时，不该拿前端那半份的存量去提示"已低于基线"。
    """
    hits: list[tuple[str, Path, int, int, str]] = []
    scanned: set[str] = set()
    for root_arg in roots:
        root = Path(root_arg)
        if not root.exists():
            continue
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in TEXT_EXTS:
                continue
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            rel = relative_to_repo(path)
            scanned.add(rel)
            for lineno, col, char in scan_file(path):
                hits.append((rel, path, lineno, col, char))
    return hits, scanned


def load_baseline(path: Path) -> dict[tuple[str, str], int] | None:
    """读基线；文件不存在返回 None——调用方据此报错，**绝不静默放行**。"""
    if not path.is_file():
        return None
    loaded: dict[tuple[str, str], int] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 3 or not parts[2].isdigit():
            continue
        loaded[(parts[0], parts[1])] = int(parts[2])
    return loaded


def write_baseline(path: Path, hits: list[tuple[str, Path, int, int, str]]) -> int:
    """把当前命中写成基线（处数 + 字符，不记行号）；返回写下的命中总数。"""
    counts = Counter((rel, char) for rel, _path, _lineno, _col, char in hits)
    lines = [BASELINE_HEADER.rstrip("\n")]
    lines += [f"{rel}\t{char}\t{counts[(rel, char)]}" for rel, char in sorted(counts)]
    path.parent.mkdir(parents=True, exist_ok=True)
    # newline="\n"：Windows 上 Python 的文本模式默认会把 \n 翻成 \r\n，基线文件不该因此带上 CR
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return len(hits)


def main() -> int:
    # Windows 默认 GBK 控制台无法输出 emoji 字符，会导致报告阶段崩溃
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parsed = parse_args(sys.argv[1:])
    if parsed is None:
        return 2
    roots, baseline_path, write_path = parsed

    hits, scanned = collect(roots)

    if write_path is not None:
        total = write_baseline(write_path, hits)
        files = len({rel for rel, _p, _l, _c, _char in hits})
        print(f"已写入基线 {write_path}：{total} 处存量、{files} 个文件。")
        return 0

    if baseline_path is None:
        for _rel, path, lineno, col, char in hits:
            print(f"{path}:{lineno}:{col}  发现 emoji {char!r} (U+{ord(char):04X})")
        if hits:
            print(f"\n共发现 {len(hits)} 处 emoji，违反《前端设计规范》禁令。")
            return 1
        print("未发现 emoji，检查通过。")
        return 0

    base = load_baseline(baseline_path)
    if base is None:
        print(f"找不到基线文件：{baseline_path}（先跑 --write-baseline 生成）", file=sys.stderr)
        return 2

    counts = Counter((rel, char) for rel, _p, _l, _c, char in hits)
    by_key: dict[tuple[str, str], list[tuple[str, Path, int, int, str]]] = {}
    for hit in hits:
        by_key.setdefault((hit[0], hit[4]), []).append(hit)

    fresh = 0
    for rel, char in sorted(counts):
        allowed = base.get((rel, char), 0)
        actual = counts[(rel, char)]
        if actual <= allowed:
            continue
        excess = actual - allowed
        fresh += excess
        # 前 allowed 处算存量，多出来的按文件内顺序报出来（近似"新增的那几行"）
        rows = "、".join(str(hit[2]) for hit in by_key[(rel, char)][allowed:])
        print(f"!! {rel}  字符 {char!r}  基线 {allowed} → 实得 {actual}（新增 {excess}），行 {rows}")

    kept = len(hits) - fresh
    if fresh:
        print(f"\n共发现 {fresh} 处**基线之外**的新增 emoji（基线内存量 {kept} 处），违反《前端设计规范》禁令。")
        print("若这是改写既有违规行造成的误报，跑 --write-baseline 收紧基线。")
        return 1

    print(f"未发现新增 emoji（基线内存量 {kept} 处）。")
    in_scope = [(key, count) for key, count in base.items() if key[0] in scanned]
    tightened = sum(1 for key, count in in_scope if counts.get(key, 0) < count)
    if tightened:
        print(f"其中 {tightened} 项已低于基线——修掉了就顺手跑 --write-baseline 收紧。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
