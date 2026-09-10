# 启动后端开发服务（FastAPI + 热重载）
# 用法：pwsh scripts/dev-backend.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $root 'backend')
try {
    uv sync
    uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
}
finally {
    Pop-Location
}
