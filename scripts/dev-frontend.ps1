# 启动前端开发服务（Vite）
# 用法：pwsh scripts/dev-frontend.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $root 'frontend')
try {
    if (-not (Test-Path 'node_modules')) { pnpm install }
    pnpm dev
}
finally {
    Pop-Location
}
