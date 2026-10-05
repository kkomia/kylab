#!/usr/bin/env sh
# 启动本机边车（桌面壳拉起的那个后端：对话 + 本机数据）
# 用法：sh scripts/dev-sidecar.sh
#
# **它是什么**：本机档那个后端，与桌面壳拉起的是**同一个入口**（`python -m app.sidecar`，
# 参数口径见 desktop/src-tauri/src/sidecar.rs::arguments）。
#
# **为什么在浏览器里迭代 web 端要用它**：对话那一轮（`POST /turn/stream`，以及审批、会话、
# 笔记、设置、记忆、工作区这些本机权威面 `/api/v1/local/*`）都挂在它身上；而 `app.main:app`
# （scripts/dev-backend.sh 那一份）**不挂 `/turn/*`** —— 只起那一份时对话一律报
# 「这一轮没跑起来：网络没连上（这条请求没有发出去）」（2026-10-05 实测真因）。
#
# **数据落在哪**：`--data-dir` 默认就是壳的真实数据目录（Tauri `app_data_dir()` 口径：
# Windows `%APPDATA%\com.kylab.desktop`、macOS `~/Library/Application Support/com.kylab.desktop`、
# Linux `~/.local/share/com.kylab.desktop`），工作区取 `<数据目录>/workspace` —— 与壳一致，
# 于是同一个库、同一批会话、同一份设置。要一份隔离开的数据（不碰壳里的真实数据）就设
# `KYLAB_DATA_DIR`。
#
# **与 dev-backend.sh 的关系**：两个进程可并存，同一份 SQLite 库（定时任务的认领是一次
# CAS，只会跑一遍，见 backend/app/sidecar.py::_lifespan）。`/api/**` 那条"服务器面"的请求
# 在浏览器里仍走 Vite 反代到 :8000，只起本机档时它们按各页自己的降级显示。
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)

PORT=${KYLAB_SIDECAR_PORT:-8765}

# 数据目录按上面三档取（与 Tauri 的 app_data_dir() 同一个口径）
if [ -n "${KYLAB_DATA_DIR:-}" ]; then
    DATA_DIR=$KYLAB_DATA_DIR
else
    case "$(uname -s 2>/dev/null || echo unknown)" in
        MINGW*|MSYS*|CYGWIN*)
            # %APPDATA% 是 Windows 形式（C:\...）：换成 C:/... 这种两边都认的写法
            DATA_DIR=$(printf '%s' "${APPDATA:-$HOME/AppData/Roaming}" | tr '\\' '/')/com.kylab.desktop
            ;;
        Darwin)
            DATA_DIR="$HOME/Library/Application Support/com.kylab.desktop"
            ;;
        *)
            DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/com.kylab.desktop"
            ;;
    esac
fi

# 目录不存在就建（与壳一致：工作区在数据目录下面）
mkdir -p "$DATA_DIR/workspace"
# 统一成绝对路径：相对路径按**你调用脚本时所在的位置**解析（随后会 cd 到 backend/）
DATA_DIR=$(cd "$DATA_DIR" && pwd)
WORKSPACE=$DATA_DIR/workspace

# **端口先探一次**（照 dev-backend.sh）：Windows 上 SO_REUSEADDR 会让第二个实例**绑得上**
# 同一个端口，于是"再启动一次"不会报错，而是变成两个边车同时在跑——连接落到哪一个由系统挑，
# 表现为"我明明改了后端，界面却还是旧行为"。所以这里先看端口，占了就明确拒绝启动。
port_in_use() {
    if command -v netstat >/dev/null 2>&1; then
        netstat -an 2>/dev/null | grep -q "[:.]$PORT .*LISTEN"
    elif command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | grep -q ":$PORT "
    elif command -v lsof >/dev/null 2>&1; then
        lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
    else
        # 三样都没有（极少见）：跳过这道检查，让 uvicorn 自己去报
        return 1
    fi
}

if port_in_use; then
    echo "端口 $PORT 已经被占用——**先停掉那个进程再启动**，不要开第二个。" >&2
    echo "  查是谁：netstat -ano | grep :$PORT   （Windows 记下 PID 后 taskkill /PID <pid> /T /F）" >&2
    echo "  8765 上往往是桌面壳拉起的边车：调试时可以停掉它，或用 KYLAB_SIDECAR_PORT 换一个端口。" >&2
    exit 1
fi

cd "$ROOT/backend"

# **--all-extras 不是可选的**：裸 `uv sync` 会把 extras（duckdb / 解析器 / office 这些）卸掉，
# 而边车启动时就 import duckdb（backend/Dockerfile 与 CI 用的都是 --all-extras，同一条理由）；
# `uv run` 自己会同步环境，所以不需要单独再 sync 一次。
exec uv run --all-extras python -m app.sidecar --port "$PORT" --workspace "$WORKSPACE" --data-dir "$DATA_DIR"
