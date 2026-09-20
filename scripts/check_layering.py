"""仓库结构性规范自动核查：分层纪律、测试位置、脚本编码、界面文案、版本号。

对应《项目工程规范 v0.4》§3.3（分层纪律）、§5.1（测试存放铁律）与 §6（脚本约定）、
《前端设计规范》§5.1（界面里不写解释性小字），以及 CHANGELOG「附：版本号约定」。
这些约束靠人工 review 容易漏，故做成机械检查接入 CI：
``L1`` 协议层越界、``L2`` 业务层直连数据库/SQL、``L3`` 解析器互引、
``L4`` 解析器反向依赖业务层、``L5`` 业务层依赖协议层、``L6`` app 根下的游离模块、
``A1`` 异步端点里没有 await（假异步，会按住事件循环）、
``T1`` 测试位置、``S1`` .ps1 缺少 UTF-8 BOM、``U1`` 界面里的解释性小字、
``V1`` 手写版本号不一致、``PARSE`` 语法错误。

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
# **只允许 `app.storage.base`**（抽象契约）：具体实现（postgres_impl / s3_impl / local_impl / duckdb_impl）
# 只被组合根装配。写成"允许清单"而不是"禁止前缀"是有意的——原来的禁止清单漏了
# `app.storage.duckdb_impl`，也漏了 `from app.storage import postgres_impl`（目标是
# 包名 `app.storage`，任何前缀规则都不命中），等于留了口子。
SERVICE_LAYER = "app.services"
SERVICE_FORBIDDEN_MODULES = (
    "sqlite3",
    "sqlite_vec",
    "duckdb",
    "sqlalchemy",
    # v0.12 起存储转向 PostgreSQL：psycopg 与 sqlite3 同级，业务层同样不得直连
    "psycopg",
    "psycopg_pool",
)
SERVICE_STORAGE_ALLOWED = "app.storage.base"
SERVICE_MSG = "业务层禁止直连数据库，存储访问必须经 storage/base.py 的 Repository 接口"

# L3：解析器实现之间互不引用（base.py 的 ParseResult 与 probe.py 是共享契约）
#
# `tabular_format` / `html_format` 是**共享的格式转换器**而不是"某个解析器实现"：
# 它们不含任何解析器注册逻辑，可以被多个解析器与连接器复用。放进允许清单是刻意的
# ——把它们算作"实现"，只会逼着后来的人复制一份 HTML 剥标签的代码。
PARSER_LAYER = "app.parsers"
PARSER_SHARED = {
    "base",
    "probe",
    "tabular_format",
    "html_format",
    "text_decode",
    "__init__",
}

# L4：解析器（插件层）不得反向依赖业务层/协议层。
# 原规则只查 parser→parser，于是 `parsers/tabular.py` import `app.services.tabular`
# 这种更严重的反向依赖直接通过——依赖方向反了，插件就没法脱离业务层复用。
PARSER_FORBIDDEN = ("app.services", "app.api", "app.mcp_server", "app.workers")
PARSER_MSG = "解析器是插件层，不得反向依赖业务层（services）或协议层（api/mcp/workers）"

# L5：业务层不得依赖协议适配层。
#
# 起因：`app/agent_tools.py`（当时在 app 根）import 了 `app.mcp_server.tools`，
# 而协议层（api）又 import 这个根模块——方向成了"协议层 → 业务实现 → 另一个协议层"。
# 共用实现只能住在 services/ 里（两个门都往下依赖它），反过来就是循环的形状。
SERVICE_FORBIDDEN_LAYERS = ("app.api", "app.mcp_server")
SERVICE_LAYER_MSG = "业务层不得依赖协议适配层（api / mcp_server）；共用实现要放在 services/ 里"

# L6：`app/` 根下只允许 main.py 与 __init__.py——每个模块都必须属于一个分层。
#
# 起因与 L5 同：`app/agent_tools.py` 住在 app 根，既不匹配 `app.api` / `app.services`，
# 也不匹配任何禁止前缀，于是 L1–L4 一条都不作用于它。**一个不被任何规则覆盖的文件，
# 等于分层纪律对它不存在**：它 import 谁都不会红——而那块代码恰好管着工具准入与会话
# 范围收口，是全项目最需要护栏的地方。规则靠"命名空间白名单"而不是"记得加清单"。
APP_ROOT_ALLOWED = {"__init__", "main"}
APP_ROOT_MSG = (
    "app/ 根下不得放游离模块（只允许 main.py 与 __init__.py）："
    "请归入 api/ services/ storage/ parsers/ workers/ core/ models/ pipeline/ 之一"
)

# A1：协议层的 `async def` 端点**必须真的 await 点什么**。
#
# 起因是一次实测：38 个端点里有 33 个是 `async def` 但内部一行 await 都没有，
# 它们调的是同步的 psycopg / httpx。这会把这些阻塞调用**全部按在事件循环线程上**，
# 于是"并发"完全不成立——实测不碰库的 /health 在并发 20 下，中位延迟从 4.7ms
# 涨到 140ms（整个循环在等别人的同步 IO）。
#
# 修法是把这类端点写成普通的 `def`：Starlette 会把同步端点丢进线程池（默认 40 线程），
# 阻塞不再卡住循环。这条规则就是防止后来者（或"顺手加个 async"）把它退回去。
ASYNC_API_LAYERS = ("app.api",)
ASYNC_MSG = (
    "协议层的异步端点里没有任何 await：它调的是同步 IO，会把事件循环按住。"
    "请改成普通的 def（Starlette 会丢进线程池），或真的用异步驱动。"
)

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


# ---------------------------------------------------------------- U1：界面文案
#
# 《前端设计规范》§5.1：**界面里不写"这一页/这一节是什么"的解释性小字**。
# 它是用户明确要求删干净的一类东西（原话"所有类似这种的全部删除，一个不留"），
# 而它删完还会长回来——`PageShell` 的 `description` prop 就是被写回来的口子，
# 所以那个 prop 连同一整套样式都删了。
#
# 为什么这条要靠机械检查：**Vue 对多余属性是宽容的**，给 `<PageShell description="…">`
# 传一个不存在的 prop 不会报错，它会变成落到根元素的 attr 安静地渲染出来；
# 而 `class="panel-desc"` 这种新写的类名更是谁也不会拦。靠 review 一定漏。
#
# 判据是**命名约定**而不是"这段文字像不像解释"——后者没法机械判。所以：
# 属性名精确匹配；类名按前缀族匹配（要写别的用途的名字，就别用 page-/panel-/section- 开头）。

FORBIDDEN_ATTRS = ("description=", ":description=")

#: 类名族：命中即报。`page-desc` / `panel-desc` / `section-desc` / `page-description` /
#: `panel-lead` … 都在这几族里。
#: 类名族：命中即报。`page-desc` / `panel-desc` / `section-desc` / `page-description` /
#: `panel-lead` … 都在这几族里。
#:
#: **用分词而不是正则**：类名本来就是按空白分开的，拆开看更准；而正则要写的 ``
#: 这类转义在这个仓库里被 heredoc 吃掉过一次（第一版的正则里剩了个退格符，
#: 规则从此永远不命中——所以这条检查的写法本身就是那次事故的产物）。
UI_COPY_FAMILIES = ("page", "panel", "section", "view", "tab")
UI_COPY_TAILS = ("desc", "description", "lead")
UI_COPY_CLASS = re.compile(
    r"""class="[^"]*(?:(?:page|panel|section|view|tab)-desc(?:ription)?"""
    r"""|(?:page|panel|section|view|tab)-lead)""",
    re.I,
)

#: 允许的例外：有正当用途、名字恰好落在上面那几族里的类。
#: **能空就空着**——留一个例外就要写清理由，不然它会长成一条通道。
UI_COPY_ALLOWED: frozenset[str] = frozenset()

UI_COPY_MSG = (
    "界面里的解释性小字（标题下面那句「这一页是什么」）："
    "删掉它，或改用别的类名（别用 page-/panel-/section- 开头的 desc/lead）"
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
            if any(
                target == layer or target.startswith(f"{layer}.")
                for layer in SERVICE_FORBIDDEN_LAYERS
            ):
                violations.append(
                    Violation("L5", display, lineno, f"{SERVICE_LAYER_MSG}（import {target}）")
                )

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


def check_async_endpoints(path: Path, root: Path, tree: ast.AST) -> list[Violation]:
    """A1：协议层的 ``async def`` 必须真的 await 东西（见 ``ASYNC_MSG``）。"""
    violations: list[Violation] = []
    module = module_name_of(path, root)
    if not any(in_layer(module, layer) for layer in ASYNC_API_LAYERS):
        return violations
    display = path.relative_to(root)
    for node in ast.walk(tree):
        if not isinstance(node, ast.AsyncFunctionDef) or node.name.startswith("_"):
            continue
        # 只查**路由处理函数**：带装饰器的那些（Depends 注入的依赖函数不在此列）
        if not node.decorator_list:
            continue
        has_await = any(
            isinstance(n, (ast.Await, ast.AsyncWith, ast.AsyncFor)) for n in ast.walk(node)
        )
        if not has_await:
            violations.append(Violation("A1", display, node.lineno, f"{node.name}：{ASYNC_MSG}"))
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


def check_ui_copy(path: Path) -> list[Violation]:
    """U1：界面里不许出现"这一页是什么"的解释性小字（《前端设计规范》§5.1）。

    两条判据都是**机械可判的**：

    1. 给 `PageShell` / `PageHeader` 传 `description`——那个 prop 已经删了，
       而 Vue 不为多余属性报错，它会安静地落在根元素上渲染出来（这正是它会被写回来的原因）；
    2. 类名落在 `page-` / `panel-` / `section-` / `view-` / `tab-` 的 `desc` / `lead` 族里。

    **注释不算**：注释里提到这些词，多半正是在解释"为什么删掉它"，那要留着。

    例外靠 `UI_COPY_ALLOWED` 显式列（默认是空的）：留一个例外就得写清理由，
    不然它会长成一条通道。
    """
    if path.suffix not in (".vue", ".ts"):
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    found: list[Violation] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        if line.lstrip().startswith(("//", "/*", "*", "<!--")):
            continue
        if any(token in line for token in FORBIDDEN_ATTRS) and _targets_page_shell(
            line, text, lineno
        ):
            found.append(Violation("U1", path, lineno, UI_COPY_MSG))
            continue
        banned = [name for name in _class_names(line) if _is_ui_copy_class(name)]
        if banned and not all(name in UI_COPY_ALLOWED for name in banned):
            found.append(Violation("U1", path, lineno, f"{UI_COPY_MSG}：{'、'.join(banned)}"))
    return found


def _class_names(line: str) -> list[str]:
    """这一行里 `class="…"` 写到的类名（`class=` 后紧跟引号，与模板一致）。"""
    names: list[str] = []
    for chunk in line.split('class="')[1:]:
        names.extend(chunk.split('"')[0].split())
    return names


def _is_ui_copy_class(name: str) -> bool:
    """这个类名是不是"页面/小节说明"那一族。

    族前缀 + `desc`/`description`/`lead` 打头。用 `partition` 而不是正则：
    这个文件里**不写正则转义**（第一版写的 `\b` 被 heredoc 变成了退格符，
    规则从此永远不命中——一次看不出任何异常的静默失效）。
    """
    head, _, tail = name.partition("-")
    if head not in UI_COPY_FAMILIES or not tail:
        return False
    return any(tail == item or tail.startswith(f"{item}-") for item in UI_COPY_TAILS)


def _targets_page_shell(line: str, text: str, lineno: int) -> bool:
    """这一行的 `description=` 是不是挂在 `PageShell` / `PageHeader` 上。

    属性可能被 prettier 换到下一行写，所以本行看不到标签名时**往回找最近的那个开标签**。
    """
    window = [line]
    lines = text.splitlines()
    for back in range(0, 4):
        if back:
            index = lineno - 1 - back
            if index >= 0:
                window.insert(0, lines[index])
        opened = _opened_tags(chr(10).join(window))
        if opened:
            return opened[-1] in ("PageShell", "PageHeader")
    return False


def _opened_tags(text: str) -> list[str]:
    """文本里所有开标签的名字（按出现顺序）。不用正则：见 `_is_ui_copy_class` 的说明。"""
    names: list[str] = []
    for chunk in text.split("<")[1:]:
        name = ""
        for char in chunk:
            if char.isalnum() or char in "_.-":
                name += char
            else:
                break
        if name and name[0].isalpha():
            names.append(name)
    return names


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


# ---------------------------------------------------------------- 版本号一致性（V1）
#
# 版本号是**多处手写副本**：pyproject、package.json、Settings.app_version，
# 加上 compose 的默认标签（backend / frontend 各一处）。MCP Server 原本也是手写副本，
# v0.2.0 起改为读 Settings。
#
# 这条约定一直写在 CHANGELOG 的「附：版本号约定」里，但**没有任何检查**——
# 于是 0.1.0 → 0.2.0 那次升级才发现实际有六处，而文档说的是三处
# （见《开发计划》§12.171）。手写约定不加机械核查的失效方式，与 §12.32 记的"文档绿着撒谎"
# 一模一样，故补这条 V1。

VERSION_MSG = "手写版本号必须一致（约定见 CHANGELOG「附：版本号约定」）"


def _quoted_after(text: str, marker: str) -> str | None:
    """``marker`` 之后第一对双引号里的内容；找不到返回 None。"""
    start = text.find(marker)
    if start < 0:
        return None
    rest = text[start + len(marker) :]
    end = rest.find('"')
    return rest[:end] if end >= 0 else None


def version_sources(root: Path) -> dict[str, set[str]]:
    """各处手写版本号 → 读到的一个或多个值。

    一份文件里出现多次就有多个值（compose 有两处默认标签），**两个都要对**——
    只取第一个的话，改一处漏一处照样绿。

    文件不存在就跳过：这个脚本要能在只检出部分目录时跑，否则会误报。
    用 ``errors="replace"`` 读：被存成别的编码的文件不该让整条规则崩掉。
    """

    def read(relative: str) -> str | None:
        path = root / relative
        if not path.exists():
            return None
        return path.read_text(encoding="utf-8", errors="replace")

    found: dict[str, set[str]] = {}

    for relative, marker in (
        ("backend/pyproject.toml", 'version = "'),
        ("frontend/package.json", '"version": "'),
        ("backend/app/core/config.py", 'app_version: str = "'),
    ):
        text = read(relative)
        if text is None:
            continue
        value = _quoted_after(text, marker)
        if value:
            found[relative] = {value}

    compose = read("deploy/docker-compose.yml")
    if compose is not None:
        marker = "${KYLAB_VERSION:-"
        values: set[str] = set()
        cursor = 0
        while True:
            index = compose.find(marker, cursor)
            if index < 0:
                break
            cursor = index + len(marker)
            end = compose.find("}", cursor)
            if end < 0:
                break
            values.add(compose[cursor:end])
        if values:
            found["deploy/docker-compose.yml"] = values

    return found


def check_app_root_modules(root: Path) -> list[Violation]:
    """L6：``app/`` 根下只允许 ``main.py`` 与 ``__init__.py``（见 ``APP_ROOT_MSG``）。

    与其它规则不同，这条查的是"文件在不在规则覆盖范围内"——它不解析 import，
    只看目录。所以它对新增文件立刻生效，不需要有人记得去补一份清单。
    """
    app_dir = root / "backend" / "app"
    if not app_dir.exists():
        return []
    return [
        Violation("L6", path.relative_to(root), 1, APP_ROOT_MSG)
        for path in sorted(app_dir.glob("*.py"))
        if path.stem not in APP_ROOT_ALLOWED
    ]


def check_version_consistency(root: Path) -> list[Violation]:
    """V1：各处手写版本号必须一致。基准取 `backend/pyproject.toml`。"""
    found = version_sources(root)
    if not found:
        return []

    reference = (
        "backend/pyproject.toml" if "backend/pyproject.toml" in found else sorted(found)[0]
    )
    own = found[reference]
    if len(own) != 1:
        # 同一份文件里自相矛盾（典型：compose 两处默认标签只改了一处）
        return [
            Violation(
                "V1",
                Path(reference),
                1,
                f"{VERSION_MSG}：同一份文件里出现多个版本号：{'、'.join(sorted(own))}",
            )
        ]
    expected = next(iter(own))

    picture = "；".join(
        f"{name}={'、'.join(sorted(values))}" for name, values in sorted(found.items())
    )
    return [
        Violation(
            "V1",
            Path(name),
            1,
            f"{VERSION_MSG}：期望 {expected}（取自 {reference}），此处是 "
            f"{'、'.join(sorted(values))}。全仓实读：{picture}",
        )
        for name, values in sorted(found.items())
        if values != {expected}
    ]


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
            violations.extend(check_async_endpoints(path, root, tree))
            violations.extend(check_test_placement(path, root))

    frontend_src = root / "frontend" / "src"
    if frontend_src.exists():
        for path in sorted(frontend_src.rglob("*")):
            if path.is_file():
                violations.extend(check_test_placement(path, root))
                violations.extend(check_ui_copy(path))

    violations.extend(check_ps1_bom(root))
    violations.extend(check_version_consistency(root))
    violations.extend(check_app_root_modules(root))

    for violation in violations:
        print(violation)

    if violations:
        print(
            f"\n共发现 {len(violations)} 处违规，违反《项目工程规范》§3.3 / §5.1、"
            f"脚本编码约定、界面文案条款或 CHANGELOG「附：版本号约定」。"
        )
        return 1
    print("分层纪律、测试位置、脚本编码、界面文案与版本号检查通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
