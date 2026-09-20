# 启动后端开发服务（FastAPI + 热重载）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\dev-backend.ps1
# 本文件须以 UTF-8 with BOM 保存（Windows PowerShell 5.1 对无 BOM 的 .ps1 按 GBK 解码）
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $root 'backend')
try {
    # **--all-extras 不是可选的**：裸 `uv sync` 会把 extras 卸掉，而后端启动时要 import duckdb
    uv sync --all-extras
    uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
}
finally {
    Pop-Location
}
