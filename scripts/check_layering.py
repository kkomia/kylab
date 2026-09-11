"""仓库结构性规范自动核查：分层纪律、测试位置、脚本编码。

对应《项目工程规范 v0.3》§3.3（分层纪律）、§5.1（测试存放铁律）与 §6（脚本约定）。
这些约束靠人工 review 容易漏，故做成机械检查接入 CI：
``L1`` 协议层越界、``L2`` 业务层直连数据库/SQL、``L3`` 解析器互引、
``L4`` 解析器反向依赖业务层、``T1`` 测试位置、
``S1`` .ps1 缺少 UTF-8 BOM、``PARSE`` 语法错误。

用法：python scripts/check_layering.py [仓库根目录，默认当前目录]
退出码：0 = 通过；1 = 发现违规。
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------- 规则定义
# 注意：层常量必须是**点分模块前缀**（app.api），不能写成目录形式（app/api）——
# 模块名是点分的，写成目录形式会导致规则永不命中（静默假阴性）。

# L1：协议适配层不得越过 services/ 直接碰存储、解析器、队列
PROTOCOL_LAYERS = ("app.api", "app.mcp_server")
PROTOCOL_FORBIDDEN = ("app.storage", "app.parsers", "app.workers")
PROTOCOL_MSG = "协议适配层只能转发 services/，禁止直接依赖存储/解析器/队列"

# L2：业务层不得直接使用数据库驱动，也不得依赖具体存储实现。
# **只允许 `app.storage.base`**（抽象契约）：具体实现（sqlite_impl / duckdb_impl）
# 只被组合根装配。写成"允许清单"而不是"禁止前缀"是有意的——原来的禁止清单漏了
# `app.storage.duckdb_impl`，也漏了 `from app.storage import sqlite_impl`（目标是
# 包名 `app.storage`，任何前缀规则都不命中），等于留了口子。
SERVICE_LAYER = "app.services"
SERVICE_FORBIDDEN_MODULES = ("sqlite3", "sqlite_vec", "duckdb", "sqlalchemy")
SERVICE_STORAGE_ALLOWED = "app.storage.base"
SERVICE_MSG = "业务层禁止直连数据库，存储访问必须经 storage/base.py 的 Repository 接口"

# L3：解析器实现之间互不引用（base.py 的 ParseResult 与 probe.py 是共享契约）
PARSER_LAYER = "app.parsers"
PARSER_SHARED = {"base", "probe", "tabular_format", "__init__"}

# L4：解析器（插件层）不得反向依赖业务层/协议层。
# 原规则只查 parser→parser，于是 `parsers/tabular.py` import `app.services.tabular`
# 这种更严重的反向依赖直接通过——依赖方向反了，插件就没法脱离业务层复用。
PARSER_FORBIDDEN = ("app.services", "app.api", "app.mcp_server", "app.workers")
PARSER_MSG = "解析器是插件层，不得反向依赖业务层（services）或协议层（api/mcp/workers）"

# T1：测试代码绝不进入源码目录
SOURCE_ROOTS = ("backend/app", "frontend/src")
TEST_FILE_RE = re.compile(r"^(test_.*\.py|.*_test\.py|.*\.test\.ts|.*\.spec\.ts)$")

# SQL 语句起始关键字：业务层源码中的这类字符串字面量视为直接写 SQL。
#
# **要求关键字后面还有内容**（``\s+\S``），不能只匹配一个孤零零的词：
# 单个词是 HTML 标签名或枚举值的可能性更大——实测 `"select"`（HTML 的
# <select> 下拉框）与 `"delete"`（任务类型）都被误报成"业务层写 SQL"。
# 真正的 SQL 一定带列名或表名（`select *`、`delete from ...`），
# 所以多要求一个词就能把误报挡掉，而不会放过真正的违规。
SQL_START_RE = re.compile(
    r"(?i)^\s*(select|insert|update|delete|create|drop|alter|pragma|attach"
    r"|replace\s+into)\s+\S"
)


class Violation:
    """一条违规记录。"""

    def __init__(self, rule: str, path: Path, lineno: int, detail: str) -> None:
        self.rule = rule
        self.path = path
        self.lineno = lineno
        self.detail = detail

    def __str__(self) -> str:
        return f"{self.path}:{self.lineno}  [{self.rule}] {self.detail}"


def module_name_of(path: Path, root: Path) -> str:
    """把文件路径转成点分模块名，如 ``backend/app/api/v1/health.py`` → ``app.api.v1.health``。"""
    rel = path.relative_to(root / "backend").with_suffix("")
    parts = [p for p in rel.parts if p != "__init__"]
    return ".".join(parts)


def in_layer(module: str, layer: str) -> bool:
    """判断模块是否属于某层（按点分前缀整段匹配，避免 ``app.api_x`` 误命中 ``app.api``）。"""
    return module == layer or module.startswith(f"{layer}.")


def imported_modules(tree: ast.AST, current: str) -> list[tuple[int, str]]:
    """收集 import 的目标模块名（含 ``from .x import y`` 的相对导入解析）。"""
    found: list[tuple[int, str]] = []
    package = current.rsplit(".", 1)[0] if "." in current else current
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.extend((node.lineno, alias.name) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:  # 相对导入：按当前包深度还原
                base_parts = package.split(".")[: len(package.split(".")) - node.level + 1]
                base = ".".join(base_parts) if base_parts else package
                target = f"{base}.{node.module}" if node.module else base
            else:
                target = node.module or ""
            found.append((node.lineno, target))
    return found


def string_literals(tree: ast.AST) -> list[tuple[int, str]]:
    """收集字符串字面量（含 f-string 片段）。"""
    values: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            values.append((node.lineno, node.value))
        elif isinstance(node, ast.JoinedStr):
            for part in node.values:
                if isinstance(part, ast.Constant) and isinstance(part.value, str):
                    values.append((node.lineno, part.value))
    return values


def check_layer_rules(path: Path, root: Path, tree: ast.AST) -> list[Violation]:
    """L1/L2/L3：分层纪律。``path`` 为绝对路径，报告时转成相对路径。"""
    violations: list[Violation] = []
    display = path.relative_to(root)
    module = module_name_of(path, root)

    for lineno, target in imported_modules(tree, module):
        if any(in_layer(module, layer) for layer in PROTOCOL_LAYERS) and any(
            target == prefix or target.startswith(f"{prefix}.") for prefix in PROTOCOL_FORBIDDEN
        ):
            violations.append(Violation("L1", display, lineno, f"{PROTOCOL_MSG}（import {target}）"))

        if in_layer(module, SERVICE_LAYER):
            allowed_storage = target == SERVICE_STORAGE_ALLOWED or target.startswith(
                f"{SERVICE_STORAGE_ALLOWED}."
            )
            uses_storage = target == "app.storage" or target.startswith("app.storage.")
            if target.split(".")[0] in SERVICE_FORBIDDEN_MODULES or (
                uses_storage and not allowed_storage
            ):
                violations.append(Violation("L2", display, lineno, f"{SERVICE_MSG}（import {target}）"))

        if in_layer(module, PARSER_LAYER):
            parts = target.split(".")
            if parts[0] == "app" and len(parts) >= 3 and parts[1] == "parsers":
                if parts[2] not in PARSER_SHARED:
                    violations.append(
                        Violation(
                            "L3",
                            display,
                            lineno,
                            f"解析器实现之间禁止互相引用，共享契约只能来自 base.py（import {target}）",
                        )
                    )
            if any(target == prefix or target.startswith(f"{prefix}.") for prefix in PARSER_FORBIDDEN):
                violations.append(Violation("L4", display, lineno, f"{PARSER_MSG}（import {target}）"))

    if in_layer(module, SERVICE_LAYER):
        for lineno, value in string_literals(tree):
            if SQL_START_RE.match(value):
                snippet = value.strip().splitlines()[0][:60]
                violations.append(
                    Violation("L2", display, lineno, f"业务层出现 SQL 字面量：{snippet!r}")
                )

    return violations


def check_test_placement(path: Path, root: Path) -> list[Violation]:
    """T1：源码目录内不得出现测试文件。``path`` 为绝对路径。"""
    rel = path.relative_to(root)
    rel_posix = rel.as_posix()
    if not any(rel_posix.startswith(source) for source in SOURCE_ROOTS):
        return []
    if "__tests__" in path.parts or TEST_FILE_RE.match(path.name):
        return [
            Violation(
                "T1",
                rel,
                1,
                "测试文件不得放入源码目录，请按工程规范 §5.1 放到 backend/tests 或 frontend/tests",
            )
        ]
    return []


def check_ps1_bom(root: Path) -> list[Violation]:
    """S1：``scripts/*.ps1`` 必须带 UTF-8 BOM。

    Windows PowerShell 5.1 会把无 BOM 的 .ps1 当 GBK 解码，中文字符串直接变乱码、
    脚本以 ParserError 崩掉——门禁脚本自己就是受害者。编辑器/工具改写文件时极易丢掉 BOM，
    故用机械检查兜住，而不是靠人记得。
    """
    violations: list[Violation] = []
    scripts_dir = root / "scripts"
    if not scripts_dir.exists():
        return violations
    for path in sorted(scripts_dir.rglob("*.ps1")):
        if not path.read_bytes().startswith(b"\xef\xbb\xbf"):
            violations.append(
                Violation(
                    "S1",
                    path.relative_to(root),
                    1,
                    "缺少 UTF-8 BOM，PowerShell 5.1 会按 GBK 解码导致中文乱码与解析失败；"
                    "请以 UTF-8 with BOM 重新保存",
                )
            )
    return violations


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    backend_app = root / "backend" / "app"

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    violations: list[Violation] = []

    if backend_app.exists():
        for path in sorted(backend_app.rglob("*.py")):
            # 用 utf-8-sig 读：Windows 上被存成 UTF-8 with BOM 的源码是合法的 Python，
            # 用 utf-8 读会让 ast.parse 报 "invalid non-printable character U+FEFF"
            source = path.read_text(encoding="utf-8-sig")
            try:
                tree = ast.parse(source, filename=str(path))
            except SyntaxError as exc:
                violations.append(Violation("PARSE", path, exc.lineno or 1, f"语法错误：{exc.msg}"))
                continue
            violations.extend(check_layer_rules(path, root, tree))
            violations.extend(check_test_placement(path, root))

    frontend_src = root / "frontend" / "src"
    if frontend_src.exists():
        for path in sorted(frontend_src.rglob("*")):
            if path.is_file():
                violations.extend(check_test_placement(path, root))

    violations.extend(check_ps1_bom(root))

    for violation in violations:
        print(violation)

    if violations:
        print(f"\n共发现 {len(violations)} 处结构性违规，违反《项目工程规范》§3.3 / §5.1 与脚本编码约定。")
        return 1
    print("分层纪律、测试位置与脚本编码检查通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
