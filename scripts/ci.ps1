# CI 门禁（本地复现 CI 用）：规范检查 + 后端测试 + 前端测试
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\ci.ps1
#      （装了 PowerShell 7 也可用 pwsh -File scripts\ci.ps1）
#
# 平台约束（与 lint.ps1 同）：UTF-8 with BOM 保存；调用外部命令不重定向输出流，
# 只读 $LASTEXITCODE 判断成败，输出直接透传控制台。
$root = Split-Path -Parent $PSScriptRoot
$script:failures = 0

function Invoke-Step {
    param([string]$Label, [string]$Command, [string[]]$Arguments)

    Write-Host "==> $Label" -ForegroundColor Cyan

    & $Command @Arguments
    $code = $LASTEXITCODE

    if ($code -ne 0) {
        Write-Host "!! $Label 失败（exit $code）" -ForegroundColor Red
        $script:failures++
    }
    else {
        Write-Host '    OK' -ForegroundColor DarkGray
    }
}

# 用当前 PowerShell 宿主执行 lint.ps1，拿到它真实的退出码（用 & 调用会在其 exit 时打断本脚本）
if ($PSVersionTable.PSEdition -eq 'Core') {
    $hostExe = Join-Path $PSHOME 'pwsh.exe'
}
else {
    $hostExe = Join-Path $PSHOME 'powershell.exe'
}
Invoke-Step '规范检查（scripts/lint.ps1）' $hostExe @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'lint.ps1')
)

Invoke-Step '后端测试' 'uv' @(
    'run', '--directory', "$root/backend", 'pytest', 'tests',
    '-m', 'not bench and not cloud', '--cov=app', '--cov-report=term-missing'
)

if (Test-Path "$root/frontend/package.json") {
    Invoke-Step '前端测试' 'pnpm' @('--dir', "$root/frontend", 'test')
}

if ($script:failures -gt 0) {
    Write-Host "CI 门禁未通过（$script:failures 项）" -ForegroundColor Red
    exit 1
}
Write-Host 'CI 门禁全绿' -ForegroundColor Green
