#!/usr/bin/env sh
# 后端测试（**只在需要跑 pytest 时用它**；完整门禁是 scripts/check-backend.sh）
#
# 不需要任何外部服务：存储只有本机一套（SQLite + 数据目录），每个用例自带临时目录
# （见 `backend/tests/conftest.py` 的 isolated_data_dir）。
#
# 用法：
#   sh scripts/test-backend.sh                 # 跑整个 tests/
#   sh scripts/test-backend.sh -q -k 某个用例名   # 额外参数原样传给 pytest
#   KYLAB_TEST_TARGETS=tests/unit sh scripts/test-backend.sh  # 只跑一部分（默认 tests）
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)

VENV_PY="$ROOT/backend/.venv/Scripts/python.exe"
[ -x "$VENV_PY" ] || VENV_PY="$ROOT/backend/.venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
    echo "找不到 venv 解释器：$VENV_PY" >&2
    echo "先建虚拟环境并装依赖（见 backend/README.md）" >&2
    exit 2
fi

cd "$ROOT/backend" || exit 2
# 目标用环境变量给（默认整个 tests/）：写成位置参数的话，它会和默认的 tests
# **叠在一起**（既跑全量又跑那一个文件），所以这里不做"猜参数"的事。
# shellcheck disable=SC2086
"$VENV_PY" -m pytest ${KYLAB_TEST_TARGETS:-tests} \
    -m 'not bench and not cloud' -q "$@"
