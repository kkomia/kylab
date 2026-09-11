#!/usr/bin/env sh
# 后端门禁（**只改后端时跑这一个**）：ruff + 分层纪律 + emoji + API 文档同步 + pytest
#
# 用法：sh scripts/check-backend.sh
# 范围纪律见 scripts/check-frontend.sh 的说明与开发计划 §12.24。
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

PY=$(pick_python || true)
[ -n "$PY" ] || { echo "未找到可用的 Python 解释器" >&2; exit 2; }

VENV_PY="$ROOT/backend/.venv/Scripts/python.exe"
[ -x "$VENV_PY" ] || VENV_PY="$ROOT/backend/.venv/bin/python"

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
if [ -x "$VENV_PY" ]; then
    step "同步 API 接口规范" "$VENV_PY" "$ROOT/scripts/gen_api_spec.py"
else
    echo "==> 同步 API 接口规范（跳过：找不到 venv 解释器）"
fi
step "后端测试" sh -c "cd '$ROOT/backend' && '$VENV_PY' -m pytest tests -m 'not bench and not cloud' -q"

if [ "$fail" -ne 0 ]; then
    echo "后端门禁未通过（$fail 项）"
    exit 1
fi
echo "后端门禁全绿"
