# 启动本机边车（桌面壳拉起的那个后端：对话 + 本机数据）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\dev-sidecar.ps1
# 本文件须以 UTF-8 with BOM 保存（Windows PowerShell 5.1 对无 BOM 的 .ps1 按 GBK 解码）
#
# **它是什么**：本机档那个后端，与桌面壳拉起的是**同一个入口**（`python -m app.sidecar`，
# 参数口径见 desktop/src-tauri/src/sidecar.rs::arguments）。
#
# **为什么在浏览器里迭代 web 端要用它**：对话那一轮（`POST /turn/stream`，以及审批、会话、
# 笔记、设置、记忆、工作区这些本机权威面 `/api/v1/local/*`）都挂在它身上；而 `app.main:app`
# （scripts/dev-backend.ps1 那一份）**不挂 `/turn/*`** —— 只起那一份时对话一律报
# 「这一轮没跑起来：网络没连上（这条请求没有发出去）」（2026-10-05 实测真因）。
#
# **数据落在哪**：`--data-dir` 默认就是壳的真实数据目录（Tauri `app_data_dir()` 口径：
# Windows `%APPDATA%\com.kylab.desktop`、macOS `~/Library/Application Support/com.kylab.desktop`、
# Linux `~/.local/share/com.kylab.desktop`），工作区取 `<数据目录>\workspace` —— 与壳一致，
# 于是同一个库、同一批会话、同一份设置。要一份隔离开的数据（不碰壳里的真实数据）就设
# `KYLAB_DATA_DIR`。
#
# **与 dev-backend.ps1 的关系**：两个进程可并存，同一份 SQLite 库（定时任务的认领是一次
# CAS，只会跑一遍，见 backend/app/sidecar.py::_lifespan）。`/api/**` 那条"服务器面"的请求
# 在浏览器里仍走 Vite 反代到 :8000，只起本机档时它们按各页自己的降级显示。
$ErrorActionPreference = 'Stop'

$port = if ($env:KYLAB_SIDECAR_PORT) { [int]$env:KYLAB_SIDECAR_PORT } else { 8765 }

# 数据目录按平台取（与 Tauri 的 app_data_dir() 同一个口径）
if ($env:KYLAB_DATA_DIR) {
    $dataDir = $env:KYLAB_DATA_DIR
}
elseif ($env:APPDATA) {
    $dataDir = Join-Path $env:APPDATA 'com.kylab.desktop'
}
elseif ($env:HOME -and (Test-Path (Join-Path $env:HOME 'Library'))) {
    $dataDir = Join-Path $env:HOME 'Library/Application Support/com.kylab.desktop'
}
else {
    $base = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { Join-Path $env:HOME '.local/share' }
    $dataDir = Join-Path $base 'com.kylab.desktop'
}

# 目录不存在就建（与壳一致：工作区在数据目录下面），并统一成绝对路径
$dataDir = [System.IO.Path]::GetFullPath($dataDir)
$workspace = Join-Path $dataDir 'workspace'
New-Item -ItemType Directory -Force -Path $workspace | Out-Null

# **端口先探一次**（照 dev-backend.ps1）：Windows 上 SO_REUSEADDR 会让第二个实例**绑得上**
# 同一个端口，于是"再启动一次"不会报错，而是变成两个边车同时在跑——连接落到哪一个由系统挑，
# 表现为"我明明改了后端，界面却还是旧行为"。所以这里先看端口，占了就明确拒绝启动。
$busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    $owner = ($busy | Select-Object -First 1).OwningProcess
    Write-Error "端口 $port 已经被占用（PID $owner）——先停掉那个进程再启动：Stop-Process -Id $owner -Force"
    exit 1
}

$root = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $root 'backend')
try {
    # **--all-extras 不是可选的**：裸 `uv sync` 会把 extras（duckdb / 解析器 / office 这些）
    # 卸掉，而边车启动时就 import duckdb（backend/Dockerfile 与 CI 用的都是 --all-extras，
    # 同一条理由）。`uv run` 自己会同步环境，这里把 extras 一并带上。
    uv run --all-extras python -m app.sidecar --port $port --workspace $workspace --data-dir $dataDir
}
finally {
    Pop-Location
}
