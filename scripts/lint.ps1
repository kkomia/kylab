# 代码规范检查（提交前跑一遍）：ruff + emoji 扫描 + 分层纪律 + eslint
# 用法：pwsh scripts/lint.ps1
$root = Split-Path -Parent $PSScriptRoot
$script:failures = 0

function Invoke-Step {
    param([string]$Label, [scriptblock]$Action)
    Write-Host "==> $Label" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        Write-Host "!! $Label 失败" -ForegroundColor Red
        $script:failures++
    }
}

Invoke-Step 'ruff' { uv run --project "$root/backend" ruff check "$root/backend/app" "$root/backend/tests" }
Invoke-Step 'emoji 扫描（后端）' { python "$root/scripts/scan_emoji.py" "$root/backend/app" }
Invoke-Step '分层纪律与测试位置' { python "$root/scripts/check_layering.py" "$root" }

if (Test-Path "$root/frontend/package.json") {
    if (-not (Test-Path "$root/frontend/node_modules")) {
        Invoke-Step 'pnpm install' { pnpm --dir "$root/frontend" install }
    }
    Invoke-Step 'eslint + prettier' { pnpm --dir "$root/frontend" lint }
    Invoke-Step 'emoji 扫描（前端）' { python "$root/scripts/scan_emoji.py" "$root/frontend/src" }
}

if ($script:failures -gt 0) {
    Write-Host "共 $script:failures 项检查失败" -ForegroundColor Red
    exit 1
}
Write-Host '全部检查通过' -ForegroundColor Green
