#!/usr/bin/env sh
# 新前端（React）的门禁（§12.230）。
#
# 为什么单开一个：迁移期两套前端并存，各自的门禁要能**独立**跑——
# 旧前端改了跑 check-frontend.sh，新前端改了跑这一个，互相当对方的红灯。
# 迁移完成（P5）后 `check-frontend.sh` 会指向新前端，这个脚本届时改名为它的实现。
#
# 用法：sh scripts/check-react.sh
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$ROOT/frontend-react"
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

step "eslint + prettier" pnpm --dir "$APP" lint
step "类型检查（tsc）" pnpm --dir "$APP" typecheck
step "单测（vitest）" pnpm --dir "$APP" test
step "生产构建" pnpm --dir "$APP" build
step "emoji 扫描（界面文案禁令）" sh -c "cd '$ROOT' && python scripts/scan_emoji.py frontend-react/src"

# 这一步要 import app（进而 import duckdb），**必须用 venv 的解释器**：
# 与 check-frontend.sh 同一个理由（通用探测常落到系统 python，那里没有项目依赖）
VENV_PY="$ROOT/backend/.venv/Scripts/python.exe"
[ -x "$VENV_PY" ] || VENV_PY="$ROOT/backend/.venv/bin/python"
if [ -x "$VENV_PY" ]; then
    step "API 类型契约（前端 ← OpenAPI）" "$VENV_PY" "$ROOT/scripts/gen_api_types.py" --check --target react
else
    echo "==> API 类型契约（跳过：找不到 venv 解释器）"
fi

if [ "$fail" -ne 0 ]; then
    echo "React 前端门禁未通过（$fail 项）"
    exit 1
fi
echo "React 前端门禁全绿"
