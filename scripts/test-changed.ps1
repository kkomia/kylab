# 只跑"这次改动影响到的"用例——工程规范 §5.2.1 那条内环纪律的可执行版本。
#
# （与 test-changed.sh 同一份逻辑：判定在 scripts/affected_tests.py 里，两个壳只负责
#   找解释器、借测试库、把参数原样传下去。）
#
# 跑什么（**内环整套**，顺序如下）：
#   1. emoji + 分层（全仓，带 scripts/baselines/*.txt 基线——存量不红，新增才红）
#   2. 后端 ruff（全仓；ruff 本身就是秒级）
#   3. 本轮改到了前端文件时：eslint / prettier 只查那几个文件 + tsc 全量
#   4. 受影响用例（后端受影响 pytest + 前端受影响 vitest），判定见 affected_tests.py
#
# 为什么把静态检查也放进来：它们加起来只有几秒，却能在"看行为"之前挡住最便宜的那类错。
# 全仓的 eslint / vitest / 生产构建留到收尾档（check-frontend.ps1）。
#
# 分工（与规范 §5.2.1 那张表一致，**不改变标准**）：
#   内环（写代码 → 看行为）  →  powershell -File scripts\test-changed.ps1
#   一个大版块收尾 / 交付前  →  scripts\check-backend.ps1 && scripts\check-frontend.ps1
#   CI                       →  全量（裁判地位不受影响）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\test-changed.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\test-changed.ps1 --base origin/main
#   powershell -ExecutionPolicy Bypass -File scripts\test-changed.ps1 --list
#
# 平台约束（与 lint.ps1 同）：**UTF-8 with BOM 保存**——Windows PowerShell 5.1
# 会把无 BOM 的 .ps1 当 GBK 解码，下面的中文注释直接变乱码。
#
# 不需要任何外部服务：存储只有本机一套（SQLite + 数据目录），用例自带临时目录。
$root = Split-Path -Parent $PSScriptRoot

$venvPy = Join-Path $root 'backend\.venv\Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
    $venvPy = Join-Path $root 'backend\.venv\bin\python'
}
if (-not (Test-Path $venvPy)) {
    Write-Host "找不到 venv 解释器：$venvPy" -ForegroundColor Red
    Write-Host '先建虚拟环境并装依赖（见 backend/README.md）'
    exit 2
}

# 只想看判定结果（--list / --json / --dry-run）时不要顺手跑起来：连上面那几步
# 静态检查也一起跳过，只回答"会跑哪些用例"。
$mode = @('--run')
foreach ($arg in $args) {
    if ($arg -in @('--list', '--json', '--dry-run')) {
        $mode = @()
    }
}
$reportOnly = $mode.Count -eq 0

$script:failures = 0
$total = [Diagnostics.Stopwatch]::StartNew()

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

if (-not $reportOnly) {
    $emojiBaseline = Join-Path $root 'scripts\baselines\emoji.txt'
    $layeringBaseline = Join-Path $root 'scripts\baselines\layering.txt'

    # uv 常常装了但不在 PATH 上（Desktop 安装器放在 ~/.local/bin）
    $uvExe = 'uv'
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        foreach ($candidate in @(
                (Join-Path $env:USERPROFILE '.local\bin\uv.exe'),
                (Join-Path $env:USERPROFILE '.cargo\bin\uv.exe')
            )) {
            if (Test-Path $candidate) { $uvExe = $candidate; break }
        }
    }

    Invoke-Step 'emoji 扫描（后端，基线）' 'python' @((Join-Path $root 'scripts\scan_emoji.py'), '--baseline', $emojiBaseline, (Join-Path $root 'backend\app'))
    Invoke-Step 'emoji 扫描（前端，基线）' 'python' @((Join-Path $root 'scripts\scan_emoji.py'), '--baseline', $emojiBaseline, (Join-Path $root 'frontend\src'))
    Invoke-Step '结构性规范（基线）' 'python' @((Join-Path $root 'scripts\check_layering.py'), '--baseline', $layeringBaseline, $root)
    Invoke-Step 'ruff（后端）' $uvExe @('run', '--directory', "$root/backend", 'ruff', 'check', 'app/', 'tests/')

    # 前端只查本轮改到的文件（跟着 --base 走）：全仓 eslint/prettier 是收尾档的事
    $base = 'HEAD'
    for ($i = 0; $i -lt $args.Count - 1; $i++) {
        if ($args[$i] -eq '--base') { $base = $args[$i + 1] }
    }
    $changed = @(& git -C $root diff --name-only --diff-filter=ACMR $base)
    if ($base -eq 'HEAD') {
        $changed += @(& git -C $root ls-files --others --exclude-standard)
    }
    $feFiles = @($changed |
        Where-Object { $_ -match '^frontend/(src|tests)/.+\.(ts|tsx|js|jsx|css)$' } |
        Sort-Object -Unique)
    if ($feFiles.Count -gt 0) {
        $feAbs = @($feFiles | ForEach-Object { Join-Path $root $_ })
        Invoke-Step "eslint（改动的 $($feAbs.Count) 个前端文件）" 'pnpm' (@('--dir', "$root/frontend", 'exec', 'eslint') + $feAbs)
        Invoke-Step 'prettier --check（同样只查那几个文件）' 'pnpm' (@('--dir', "$root/frontend", 'exec', 'prettier', '--check') + $feAbs)
        Invoke-Step '类型检查（tsc，全量）' 'pnpm' @('--dir', "$root/frontend", 'typecheck')
    }
    else {
        Write-Host '==> 前端静态检查（跳过：本轮没有改动前端文件）' -ForegroundColor DarkGray
    }
}

Write-Host '==> 受影响用例（后端 pytest + 前端 vitest）' -ForegroundColor Cyan
$swLast = [Diagnostics.Stopwatch]::StartNew()
& $venvPy (Join-Path $root 'scripts\affected_tests.py') @mode @args
$lastCode = $LASTEXITCODE
$swLast.Stop()
Write-Host ("    exit {0}（{1:N0}s）" -f $lastCode, $swLast.Elapsed.TotalSeconds) -ForegroundColor DarkGray

$total.Stop()
Write-Host ("内环用时 {0:N0}s" -f $total.Elapsed.TotalSeconds) -ForegroundColor Cyan
if ($script:failures -gt 0 -or $lastCode -ne 0) { exit 1 }
exit 0
