#!/usr/bin/env sh
# 启动后端开发服务（FastAPI + 热重载）
# 用法：sh scripts/dev-backend.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT/backend"

uv sync
exec uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
