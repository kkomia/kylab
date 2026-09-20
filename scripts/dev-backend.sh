#!/usr/bin/env sh
# 启动后端开发服务（FastAPI + 热重载）
# 用法：sh scripts/dev-backend.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT/backend"

# **--all-extras 不是可选的**：裸 `uv sync` 会把 extras（duckdb / 解析器 / office…）卸掉，
# 而后端启动时就 import duckdb。README、Dockerfile 与 CI 用的都是 --all-extras，这里对齐
uv sync --all-extras
exec uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
