#!/usr/bin/env sh
# 代码规范检查（提交前跑一遍）：ruff + emoji 扫描 + 分层纪律 + eslint/prettier
#
# 用法：sh scripts/lint.sh
#
# 跨平台注意：解释器名不能写死。Linux/macOS 是 python3，Windows 只有 python，
# 且 Windows 应用商店的 python3 别名会在 PATH 上"存在但不可执行"，因此逐个探测能否真正运行。
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
fail=0

pick_python() {
    for candidate in "${PYTHON:-}" python3 python py; do
        [ -n "$candidate" ] || continue
        if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys' >/dev/null 2>&1; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

if ! PY=$(pick_python); then
    echo "未找到可用的 Python 解释器（可用 PYTHON 环境变量指定）" >&2
    exit 2
fi

step() {
    label=$1
    shift
    echo "==> $label"
    if ! "$@"; then
        echo "!! $label 失败"
        fail=$((fail + 1))
    fi
}

step "ruff" sh -c "cd '$ROOT/backend' && uv run ruff check app/ tests/"
step "emoji 扫描（后端）" "$PY" "$ROOT/scripts/scan_emoji.py" "$ROOT/backend/app"
step "结构性规范（分层 / 测试位置 / 界面文案 / 版本号）" "$PY" "$ROOT/scripts/check_layering.py" "$ROOT"
# 同步《API 接口规范》的端点清单：它是从真实 OpenAPI 生成的，
# 跑这一步之后文档里的清单必然与代码一致（T4.9）
# 这一步要 import app（进而 import duckdb），所以**必须用 venv 的解释器**：
# lint.sh 顶部的 $PY 是通用探测（Windows 上常落到系统 python），
# 那个环境里没有项目依赖。找不到 venv 时跳过而不是报失败——
# 生成文档不该成为门禁里最脆的一环，而 pytest 那条已经会核对文档一致性。
VENV_PY="$ROOT/backend/.venv/Scripts/python.exe"
[ -x "$VENV_PY" ] || VENV_PY="$ROOT/backend/.venv/bin/python"
if [ -x "$VENV_PY" ]; then
    step "同步 API 接口规范" "$VENV_PY" "$ROOT/scripts/gen_api_spec.py"
    # 前端类型与后端 schema 的契约核对（T4.9 的姊妹项）：**不一致就红**，
    # 不像上面那条把文档改掉——类型参与编译，静默重写等于把"契约变了"藏起来。
    step "核对 API 类型（前端 ← OpenAPI）" "$VENV_PY" "$ROOT/scripts/gen_api_types.py" --check
else
    echo "==> 同步 API 接口规范（跳过：找不到 venv 解释器）"
    echo "==> 核对 API 类型（跳过：找不到 venv 解释器）"
fi

if [ -f "$ROOT/frontend/package.json" ]; then
    step "eslint + prettier" pnpm --dir "$ROOT/frontend" lint
    step "类型检查（vue-tsc）" pnpm --dir "$ROOT/frontend" typecheck
    step "emoji 扫描（前端）" "$PY" "$ROOT/scripts/scan_emoji.py" "$ROOT/frontend/src"
fi

if [ "$fail" -ne 0 ]; then
    echo "共 $fail 项检查失败"
    exit 1
fi
echo "全部检查通过"
