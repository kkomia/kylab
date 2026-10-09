# 后端门禁（**只改后端时跑这一个**）：ruff + 分层纪律 + emoji + API 文档同步 + pytest
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\check-backend.ps1
# 范围纪律见 check-frontend.ps1 的说明与开发计划 §12.24。
#
# 两档节奏（工程规范 §5.2.1）：**改一处**跑 scripts\test-changed.ps1（秒级）；
# 这一个是**大版块收尾**用的全量档。全量 pytest 默认并行（-n 8）。
#
# emoji 与分层两步走 scripts/baselines/*.txt 基线：存量不算红，**新增才算**；
# 修掉存量后跑一次 --write-baseline 把基线收紧（见两个脚本的头注释）。
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

# uv 常常装了但不在 PATH 上（Desktop 安装器放在 ~/.local/bin）——门禁不该因为这个变红。
$uvExe = 'uv'
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    foreach ($candidate in @(
            (Join-Path $env:USERPROFILE '.local\bin\uv.exe'),
            (Join-Path $env:USERPROFILE '.cargo\bin\uv.exe')
        )) {
        if (Test-Path $candidate) { $uvExe = $candidate; break }
    }
    if ($uvExe -eq 'uv') {
        Write-Host '!! 找不到 uv：ruff 与后端测试两步会失败。装 uv 或把它的目录加进 PATH。' -ForegroundColor Yellow
    }
}

$venvPy = Join-Path $root 'backend/.venv/Scripts/python.exe'
$emojiBaseline = "$root/scripts/baselines/emoji.txt"
$layeringBaseline = "$root/scripts/baselines/layering.txt"

Invoke-Step 'ruff' $uvExe @('run', '--directory', "$root/backend", 'ruff', 'check', 'app/', 'tests/')
Invoke-Step 'emoji 扫描（后端）' 'python' @("$root/scripts/scan_emoji.py", '--baseline', $emojiBaseline, "$root/backend/app")
Invoke-Step '结构性规范（分层 / 测试位置 / 界面文案 / 版本号）' 'python' @("$root/scripts/check_layering.py", '--baseline', $layeringBaseline, $root)
Invoke-Step '同步 API 接口规范' $venvPy @("$root/scripts/gen_api_spec.py")
# 前端类型与后端 schema 的契约核对：改后端的人最该跑它——schema 动了而前端没跟上时直接红
Invoke-Step '核对 API 类型（前端 ← OpenAPI）' $venvPy @("$root/scripts/gen_api_types.py", '--check')
# -n 8：16 核机器上的实测档位（全量 262s → ~110s）。不要写进 pyproject 的 addopts，
# 那会让定向跑也背上 worker 启动开销。
Invoke-Step '后端测试' $uvExe @('run', '--directory', "$root/backend", 'pytest', 'tests', '-m', 'not bench and not cloud', '-q', '-n', '8')

if ($script:failures -gt 0) {
    Write-Host "后端门禁未通过（$script:failures 项）" -ForegroundColor Red
    exit 1
}
Write-Host '后端门禁全绿' -ForegroundColor Green
