# CI 门禁（本地复现 CI 用）：规范检查 + 后端测试 + 前端测试
# 用法：pwsh scripts/ci.ps1
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

& (Join-Path $PSScriptRoot 'lint.ps1')
if ($LASTEXITCODE -ne 0) { $script:failures++ }

Invoke-Step '后端测试' {
    uv run --project "$root/backend" pytest "$root/backend/tests" -m "not bench and not cloud" --cov=app --cov-report=term-missing
}

if (Test-Path "$root/frontend/package.json") {
    Invoke-Step '前端测试' { pnpm --dir "$root/frontend" test }
}

if ($script:failures -gt 0) {
    Write-Host "CI 门禁未通过（$script:failures 项）" -ForegroundColor Red
    exit 1
}
Write-Host 'CI 门禁全绿' -ForegroundColor Green
