#!/usr/bin/env sh
# 后端门禁（**只改后端时跑这一个**）：ruff + 分层纪律 + emoji + API 文档同步 + pytest
#
# 用法：sh scripts/check-backend.sh
# 范围纪律见 scripts/check-frontend.sh 的说明与开发计划 §12.24。
#
# 两档节奏（工程规范 §5.2.1）：**改一处**跑 sh scripts/test-changed.sh（秒级）；
# 这一个是**大版块收尾**用的全量档。全量 pytest 默认并行（-n 8）。
#
# emoji 与分层两步走 scripts/baselines/*.txt 基线：存量不算红，**新增才算**；
# 修掉存量后跑一次 --write-baseline 把基线收紧（见两个脚本的头注释）。
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

# uv 常常装了但不在 PATH 上（Desktop 安装器放在 ~/.local/bin）——门禁不该因为这个变红
if ! command -v uv >/dev/null 2>&1; then
    for uvdir in "$HOME/.local/bin" "$HOME/.cargo/bin"; do
        if [ -x "$uvdir/uv" ]; then
            PATH="$uvdir:$PATH"
            export PATH
            break
        fi
    done
fi

EMOJI_BASELINE="$ROOT/scripts/baselines/emoji.txt"
LAYERING_BASELINE="$ROOT/scripts/baselines/layering.txt"

step() {
    label=$1
    shift
    echo "==> $label"
    started=$(date +%s)
    if ! "$@"; then
        echo "!! $label 失败（$(( $(date +%s) - started ))s）"
        fail=$((fail + 1))
    else
        echo "    OK（$(( $(date +%s) - started ))s）"
    fi
}

step "ruff" sh -c "cd '$ROOT/backend' && uv run ruff check app/ tests/"
step "emoji 扫描（后端，基线）" "$PY" "$ROOT/scripts/scan_emoji.py" --baseline "$EMOJI_BASELINE" "$ROOT/backend/app"
step "结构性规范（分层 / 测试位置 / 界面文案 / 版本号，基线）" "$PY" "$ROOT/scripts/check_layering.py" --baseline "$LAYERING_BASELINE" "$ROOT"
if [ -x "$VENV_PY" ]; then
    step "同步 API 接口规范" "$VENV_PY" "$ROOT/scripts/gen_api_spec.py"
    # 前端类型与后端 schema 的契约核对：改后端的人最该跑它——schema 动了而前端
    # 那座城市没跟上时，这里会直接红（见 scripts/gen_api_types.py 的说明）
    step "核对 API 类型（前端 ← OpenAPI）" "$VENV_PY" "$ROOT/scripts/gen_api_types.py" --check
else
    echo "==> 同步 API 接口规范（跳过：找不到 venv 解释器）"
    echo "==> 核对 API 类型（跳过：找不到 venv 解释器）"
fi
# 存储只有本机一套（SQLite + 数据目录），用例自带临时目录，不需要任何外部服务
# -n 8：16 核机器上的实测档位（全量 262s → ~110s）
step "后端测试" sh -c "cd '$ROOT/backend' && '$VENV_PY' -m pytest tests -m 'not bench and not cloud' -q -n 8"

if [ "$fail" -ne 0 ]; then
    echo "后端门禁未通过（$fail 项）"
    exit 1
fi
echo "后端门禁全绿"
