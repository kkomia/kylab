#!/usr/bin/env sh
# 代码规范检查（提交前跑一遍）：ruff + emoji 扫描 + 分层纪律 + eslint
# 用法：sh scripts/lint.sh
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PY=${PYTHON:-python3}
fail=0

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
