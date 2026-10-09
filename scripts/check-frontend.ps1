# 前端门禁（**只改前端时跑这一个**）：eslint + prettier + tsc + vitest + 生产构建 + emoji
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\check-frontend.ps1
#
# 为什么要有它：全量门禁（ci.ps1）会跑后端 1100+ 用例（约 3 分钟）。
# 只改了前端美术却去跑后端，是在为"没动过的代码"付时间——门禁的范围应该等于
# 改动的范围（开发计划 §12.24）。
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

Invoke-Step 'eslint + prettier' 'pnpm' @('--dir', "$root/frontend", 'lint')
Invoke-Step '类型检查（tsc）' 'pnpm' @('--dir', "$root/frontend", 'typecheck')
Invoke-Step '前端单测（vitest）' 'pnpm' @('--dir', "$root/frontend", 'test')
Invoke-Step '生产构建' 'pnpm' @('--dir', "$root/frontend", 'build')
# emoji 与分层走 scripts/baselines/*.txt 基线：存量不算红，**新增才算**
Invoke-Step 'emoji 扫描（前端）' 'python' @("$root/scripts/scan_emoji.py", '--baseline', "$root/scripts/baselines/emoji.txt", "$root/frontend/src")
# 结构性规范里有一条是**前端规则**（U1：界面文案），所以这个门禁也要跑它
Invoke-Step '结构性规范（分层 / 测试位置 / 界面文案）' 'python' @("$root/scripts/check_layering.py", '--baseline', "$root/scripts/baselines/layering.txt", $root)

if ($script:failures -gt 0) {
    Write-Host "前端门禁未通过（$script:failures 项）" -ForegroundColor Red
    exit 1
}
Write-Host '前端门禁全绿' -ForegroundColor Green
