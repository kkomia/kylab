#!/usr/bin/env sh
# 只跑"这次改动影响到的"用例——工程规范 §5.2.1 那条内环纪律的**可执行版本**。
#
# 为什么要有它：规范早就写了"改一处只跑受影响的那几个文件"，但受影响的范围
# 没人能可靠地手算（前端根本没有镜像关系，规范里记着 2026-09-27 因此漏过一次）。
# 手算会漏，于是大家都退化成跑全量——而后端全量一次是十几分钟，迭代速度就没了。
#
# 跑什么（**内环整套**，顺序如下）：
#   1. emoji + 分层（全仓，带 scripts/baselines/*.txt 基线——存量不红，新增才红）
#   2. 后端 ruff（全仓；ruff 本身就是秒级）
#   3. 本轮改到了前端文件时：eslint / prettier 只查那几个文件 + tsc 全量
#   4. 受影响用例（后端受影响 pytest + 前端受影响 vitest），判定见 affected_tests.py
#
# 为什么把静态检查也放进来：它们加起来只有几秒，却能在"看行为"之前挡住最便宜的那类错。
# 全仓的 eslint / vitest / 生产构建留到收尾档（check-frontend.sh）。
#
# 分工（与规范 §5.2.1 那张表一致，**不改变标准**）：
#   内环（写代码 → 看行为）  →  sh scripts/test-changed.sh
#   一个大版块收尾 / 交付前  →  sh scripts/check-backend.sh && sh scripts/check-frontend.sh
#   CI                       →  全量（裁判地位不受影响）
#
# 影响面怎么算、有几道"宁滥勿缺"的保险，见 scripts/affected_tests.py 的头注释。
#
# 用法：
#   sh scripts/test-changed.sh                      # 未提交的改动
#   sh scripts/test-changed.sh --base origin/main   # 按分支比较
#   sh scripts/test-changed.sh --list               # 只列出会跑哪些，不跑
#   sh scripts/test-changed.sh --all                # 强制全量
#   sh scripts/test-changed.sh --extra "-x -vv"     # 透传给 pytest/vitest
#
# 不需要任何外部服务：存储只有本机一套（SQLite + 数据目录），用例自带临时目录。
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)

VENV_PY="$ROOT/backend/.venv/Scripts/python.exe"
[ -x "$VENV_PY" ] || VENV_PY="$ROOT/backend/.venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
    echo "找不到 venv 解释器：$VENV_PY" >&2
    echo "先建虚拟环境并装依赖（见 backend/README.md）" >&2
    exit 2
fi

# 只想看判定结果（--list / --json / --dry-run）时不要顺手跑起来：连静态检查也跳过，
# 只回答"会跑哪些用例"。
MODE="--run"
for arg in "$@"; do
    case "$arg" in
        --list | --json | --dry-run) MODE="" ;;
    esac
done

fail=0
TOTAL_STARTED=$(date +%s)

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

if [ -n "$MODE" ]; then
    # uv 常常装了但不在 PATH 上（Desktop 安装器放在 ~/.local/bin）——内环不该因为这个变红
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

    step "emoji 扫描（后端，基线）" "$VENV_PY" "$ROOT/scripts/scan_emoji.py" --baseline "$EMOJI_BASELINE" "$ROOT/backend/app"
    step "emoji 扫描（前端，基线）" "$VENV_PY" "$ROOT/scripts/scan_emoji.py" --baseline "$EMOJI_BASELINE" "$ROOT/frontend/src"
    step "结构性规范（基线）" "$VENV_PY" "$ROOT/scripts/check_layering.py" --baseline "$LAYERING_BASELINE" "$ROOT"
    step "ruff（后端）" sh -c "cd '$ROOT/backend' && uv run ruff check app/ tests/"

    # 前端只查本轮改到的文件（跟着 --base 走）：全仓 eslint/prettier 是收尾档的事
    base=HEAD
    prev=""
    for arg in "$@"; do
        if [ "$prev" = "--base" ]; then base="$arg"; fi
        prev="$arg"
    done
    if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
        changed=$({
            git -C "$ROOT" diff --name-only --diff-filter=ACMR "$base"
            if [ "$base" = "HEAD" ]; then
                git -C "$ROOT" ls-files --others --exclude-standard
            fi
        } | sed '/^$/d' | sort -u)
        fe=$(printf '%s\n' "$changed" | grep -E '^frontend/(src|tests)/.+\.(ts|tsx|js|jsx|css)$' || true)
        if [ -n "$fe" ]; then
            count=$(printf '%s\n' "$fe" | wc -l | tr -d ' ')
            fe_rel=$(printf '%s\n' "$fe" | sed 's#^frontend/##')
            # shellcheck disable=SC2086  # $fe_rel 就是要分词成多个文件参数
            step "eslint（改动的 $count 个前端文件）" sh -c "cd '$ROOT/frontend' && pnpm exec eslint $fe_rel"
            # shellcheck disable=SC2086
            step "prettier --check（同样只查那几个文件）" sh -c "cd '$ROOT/frontend' && pnpm exec prettier --check $fe_rel"
            step "类型检查（tsc，全量）" pnpm --dir "$ROOT/frontend" typecheck
        else
            echo "==> 前端静态检查（跳过：本轮没有改动前端文件）"
        fi
    fi
fi

echo "==> 受影响用例（后端 pytest + 前端 vitest）"
started=$(date +%s)
# shellcheck disable=SC2086  # $MODE 只会是空或 "--run"，就是要它分词
"$VENV_PY" "$ROOT/scripts/affected_tests.py" $MODE "$@"
last=$?
echo "    exit $last（$(( $(date +%s) - started ))s）"
echo "内环用时 $(( $(date +%s) - TOTAL_STARTED ))s"

if [ "$fail" -ne 0 ] || [ "$last" -ne 0 ]; then
    exit 1
fi
exit 0
