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
step "分层纪律与测试位置" "$PY" "$ROOT/scripts/check_layering.py" "$ROOT"

if [ -f "$ROOT/frontend/package.json" ]; then
    step "eslint + prettier" pnpm --dir "$ROOT/frontend" lint
    step "emoji 扫描（前端）" "$PY" "$ROOT/scripts/scan_emoji.py" "$ROOT/frontend/src"
fi

if [ "$fail" -ne 0 ]; then
    echo "共 $fail 项检查失败"
    exit 1
fi
echo "全部检查通过"
