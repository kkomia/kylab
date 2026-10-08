#!/usr/bin/env sh
# 只跑"这次改动影响到的"用例——工程规范 §5.2.1 那条内环纪律的**可执行版本**。
#
# 为什么要有它：规范早就写了"改一处只跑受影响的那几个文件"，但受影响的范围
# 没人能可靠地手算（前端根本没有镜像关系，规范里记着 2026-09-27 因此漏过一次）。
# 手算会漏，于是大家都退化成跑全量——而后端全量一次是十几分钟，迭代速度就没了。
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

# 只想看判定结果（--list / --json / --dry-run）时不要顺手跑起来。
MODE="--run"
for arg in "$@"; do
    case "$arg" in
        --list | --json | --dry-run) MODE="" ;;
    esac
done

# shellcheck disable=SC2086  # $MODE 只会是空或 "--run"，就是要它分词
exec "$VENV_PY" "$ROOT/scripts/affected_tests.py" $MODE "$@"
