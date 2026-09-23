"""按真实的 OpenAPI 生成前端的 TypeScript 类型（T4.9 的姊妹项）。

**为什么需要它**：`frontend/src/api/*.ts` 里的接口是**手抄**后端 schema 的。
后端加/改一个字段，前端不会在编译期报错，只会**在运行期静默错位**——
而这是"反复改版"的项目里最容易积累的一种暗债。这里把那份契约变成生成物：
`frontend/src/api/schema.d.ts` 由 OpenAPI 生成、随代码一起提交，
接口文件用 `components['schemas'][...]` 引用它，漂移就变成编译错误。

**为什么不做成"边跑边写"**（像 `gen_api_spec.py` 那样直接把文档改掉）：
类型参与编译，静默重写等于把"契约变了"这件事藏起来。所以默认是 **`--check`**：
与已提交的文件不一致就**失败**并告诉你怎么更新；开发时用 `--write` 更新。

**怎么拿到 OpenAPI**：与 `gen_api_spec.py` 同一套——在进程内 `create_app().openapi()`，
不需要起服务、也不联网（CI 里两条路都通）。生成本身交给 `openapi-typescript`
（Node CLI），本脚本只负责"喂它一个临时 JSON、比对结果"。

用法::

    python scripts/gen_api_types.py --check   # 门禁：不一致就红
    python scripts/gen_api_types.py --write   # 开发：更新生成物（默认写到旧前端）

React 迁移期（§12.230）新增 ``--target {frontend|react|both}``：两套前端共用同一份
OpenAPI，各写一份生成物。默认 ``frontend``——不传参数时行为与迁移前**逐字节相同**，
老门禁不会因为多了一套前端而变化。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


# **别把仓库根的 ``data/`` 当数据目录**：门禁从仓库根执行本脚本，而
# ``KYLAB_DATA_DIR`` 的默认值是**相对路径** ``./data``——于是 ``create_app()``
# 挂的日志会落到 ``<仓库根>/data/logs``，多跑几次就在仓库里长出一个数据目录
# （历史上那份 ``data/kylab.db`` 就是这么来的，直到存储换 PostgreSQL 才成死文件）。
# 本脚本只读 OpenAPI，不需要真实数据目录，显式指到临时目录即可。
os.environ["KYLAB_DATA_DIR"] = tempfile.mkdtemp(prefix="kylab-openapi-")

ROOT = Path(__file__).resolve().parents[1]

#: 两套前端各自的生成物落点（迁移期共存，见 §12.230）
TARGETS = {
    "frontend": ROOT / "frontend" / "src" / "api" / "schema.d.ts",
    "react": ROOT / "frontend-react" / "src" / "api" / "schema.d.ts",
}

#: openapi-typescript 的 CLI：优先用旧前端的 node_modules（它一直在），
#: 新前端里也有一份时就近用——两处都指向同一个包，选谁不影响输出。
CLI = next(
    path
    for path in (
        ROOT / "frontend" / "node_modules" / "openapi-typescript" / "bin" / "cli.js",
        ROOT / "frontend-react" / "node_modules" / "openapi-typescript" / "bin" / "cli.js",
    )
    if path.exists()
)

# ``app`` 包在 ``backend/`` 下：门禁从 backend/ 调本脚本时它天然可导入，
# 从仓库根调就不是——显式补上，别让调用方记住这件事（同 gen_api_spec.py）。
_BACKEND = ROOT / "backend"
if _BACKEND.is_dir() and str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

HEADER = """/**
 * 由 `scripts/gen_api_types.py` 从后端的 OpenAPI 生成——**不要手改**。
 *
 * 后端加了字段、改了必填、动了枚举，这里就会变；`scripts/lint.*` 里的那一步
 * 会拿它和真实 schema 比对（`--check`），不一致时门禁直接红。
 * 更新方式：`python scripts/gen_api_types.py --write`。
 */
"""


def _openapi() -> dict:
    from app.main import create_app

    return create_app().openapi()


def _generate(spec: dict, out: Path) -> str:
    """把 spec 交给 openapi-typescript，返回它生成的文本。"""
    if not CLI.exists():
        raise SystemExit(
            "找不到 openapi-typescript：先在 frontend/ 里 `pnpm install`"
            "（它是 devDependency，前端门禁本来就需要 node_modules）"
        )
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "openapi.json"
        source.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
        result = subprocess.run(
            ["node", str(CLI), str(source), "--output", str(out)],
            cwd=ROOT / "frontend",
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if result.returncode != 0:
            raise SystemExit(f"openapi-typescript 失败：{result.stderr.strip()}")
    return out.read_text(encoding="utf-8")


def _selected() -> list[str]:
    """``--target`` 选了哪几套前端（默认只选旧前端：门禁行为一个字不变）。"""
    for index, item in enumerate(sys.argv):
        if item == "--target":
            wanted = sys.argv[index + 1] if index + 1 < len(sys.argv) else "frontend"
        elif item.startswith("--target="):
            wanted = item.split("=", 1)[1]
        else:
            continue
        if wanted == "both":
            return ["frontend", "react"]
        if wanted not in TARGETS:
            raise SystemExit(f"--target 只认 frontend / react / both，收到 {wanted!r}")
        return [wanted]
    return ["frontend"]


def main() -> int:
    check = "--check" in sys.argv
    write = "--write" in sys.argv
    if not check and not write:
        print(__doc__.split("用法::")[1].strip())
        return 2
    targets = _selected()

    with tempfile.TemporaryDirectory() as tmp:
        scratch = Path(tmp) / "schema.d.ts"
        generated = HEADER + _generate(_openapi(), scratch)

    failed: list[str] = []
    for name in targets:
        target = TARGETS[name]
        current = target.read_text(encoding="utf-8") if target.exists() else ""
        if generated == current:
            print(f"API 类型是最新的：{target.relative_to(ROOT)}")
            continue
        if write:
            target.write_text(generated, encoding="utf-8")
            print(f"已更新 {target.relative_to(ROOT)}（{len(generated.splitlines())} 行）")
            continue
        detail = target.relative_to(ROOT)
        print(
            f"API 类型与后端的 OpenAPI 不一致：{detail}",
            "后端改了 schema（加字段 / 改必填 / 动枚举）而生成物没跟上。",
            "跑 python scripts/gen_api_types.py --write [--target react|both] 更新，",
            "再按提示改用到它的接口文件。",
        )
        failed.append(name)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
