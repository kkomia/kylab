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
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $Command @Arguments
    $code = $LASTEXITCODE
    $sw.Stop()
    if ($code -ne 0) {
        Write-Host ("!! {0} 失败（exit {1}，{2:N0}s）" -f $Label, $code, $sw.Elapsed.TotalSeconds) -ForegroundColor Red
        $script:failures++
    }
    else {
        Write-Host ("    OK（{0:N0}s）" -f $sw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
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

# uv 常常装了但不在 PATH 上（Desktop 安装器放在 ~/.local/bin）——门禁不该因为这个变红。
$uvExe = 'uv'
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    foreach ($candidate in @(
            (Join-Path $env:USERPROFILE '.local\bin\uv.exe'),
            (Join-Path $env:USERPROFILE '.cargo\bin\uv.exe')
        )) {
        if (Test-Path $candidate) { $uvExe = $candidate; break }
    }
}

# 存储只有本机一套（SQLite + 数据目录），用例自带临时目录，不需要任何外部服务
# -n 8：16 核机器上的实测档位（全量 262s → ~110s）
Invoke-Step '后端测试' $uvExe @(
    'run', '--directory', "$root/backend", 'pytest', 'tests',
    '-m', 'not bench and not cloud', '--cov=app', '--cov-report=term-missing', '-n', '8'
)

if (Test-Path "$root/frontend/package.json") {
    Invoke-Step '前端测试' 'pnpm' @('--dir', "$root/frontend", 'test')
    Invoke-Step '前端生产构建' 'pnpm' @('--dir', "$root/frontend", 'build')
}

if ($script:failures -gt 0) {
    Write-Host "CI 门禁未通过（$script:failures 项）" -ForegroundColor Red
    exit 1
}
Write-Host 'CI 门禁全绿' -ForegroundColor Green
