#!/usr/bin/env sh
# NAS 上更新前端（P5 之后跑的是 React 版）。
#
# 用法（在 NAS 上）：sh /vol1/1000/docker/kylab/src/deploy/nas/update-frontend.sh [分支]
#   默认分支 react（目前只有它带新前端）；并进 main 之后不传参数也行、传 main 也行。
#
# 两处**这台机器特有的现实**（都踩过或核过，不是通用假设）：
#
# 1. **`src/` 是 `git archive` 解开的，不含 `.git`**（见 deploy/nas/README.md 的目录布局）
#    ——所以"先 git pull 再构建"在 NAS 上会直接失败。这里的做法是：**只看
#    `src/frontend` 是不是新前端**（新的有 `src/features/`，旧的 Vue 是 `src/views/ChatView.vue`），
#    是就继续构建；顺带发现 `.git` 在才做 fetch/pull（那是加分项，不是前提）。
# 2. 这台机器到境外带宽极差（§12.223：后端 `uv sync` 700 秒仍在下载）——所以
#    compose 里给前端构建传了 `NPM_REGISTRY=registry.npmmirror.com`（见 deploy/nas/docker-compose.yml）。
set -eu

BRANCH="${1:-react}"
SRC="/vol1/1000/docker/kylab/src"
APP="/vol1/1000/docker/kylab/app"
WEB="$SRC/frontend"

echo "== 0/4 源码形态"
if [ -d "$WEB/src/features" ]; then
  echo "   src/frontend 已是新前端（有 src/features/）"
elif [ -f "$WEB/src/views/ChatView.vue" ]; then
  echo "!! src/frontend 还是旧的 Vue 前端（有 src/views/ChatView.vue），构建出来会是老界面。"
  echo "   先把源码换成新前端，三选一（在**别的机器**上做第 1 条最省事）："
  echo "     a) 仓库克隆处：git archive --format=tar $BRANCH | ssh yumao@<NAS> 'tar -x -C $SRC'"
  echo "     b) NAS 上有网有凭据：git clone --depth 1 -b $BRANCH https://gitee.com/kkomia/kylab.git /tmp/kylab-src && cp -a /tmp/kylab-src/. $SRC/"
  echo "     c) 只搬前端：把新的 frontend/ 整目录覆盖到 $WEB（构建只需要这一棵）"
  exit 2
else
  echo "!! 既不是新前端也不是旧 Vue 前端（$WEB 里没有 src/features 也没有 src/views/ChatView.vue）——先确认路径"
  exit 2
fi

if [ ! -f "$APP/docker-compose.yml" ]; then
  echo "!! 找不到应用层的 compose（$APP/docker-compose.yml）——路径与这台机器对不上，先确认部署位置"
  exit 2
fi

if [ -d "$SRC/.git" ]; then
  echo "== 1/4 源码是 git 检出：切 $BRANCH 并拉取"
  cd "$SRC"
  git fetch --all --prune || echo "   （fetch 失败，继续用当前源码构建）"
  git checkout "$BRANCH" || echo "   （checkout 失败，继续用当前源码构建）"
  git pull --ff-only || echo "   （pull 失败，继续用当前源码构建）"
  git --no-pager log --oneline -1 || true
else
  echo "== 1/4 源码不是 git 检出（archive 解开的）：跳过拉取，直接用当前源码构建"
fi

echo "== 2/4 只重建前端镜像（后端不重建）"
cd "$APP"
# docker 权限自查：这台 NAS 上 docker 从普通用户就能用（README 里的命令都没有 sudo），
# 但换一台机器/换一个用户时最常见的坑就是 "permission denied ... docker.sock"——
# 与其让人对着这个报错猜，不如当场给出该敲的那一行。
if ! docker info >/dev/null 2>&1; then
  echo "!! 当前用户用不了 docker（多半是 /var/run/docker.sock 权限）。用 sudo 重跑这条就行："
  echo "     sudo sh $0 $BRANCH"
  exit 3
fi
docker compose build frontend

echo "== 3/4 重启前端容器"
docker compose up -d frontend
sleep 3

echo "== 4/4 核对"
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/ || true)
echo "   首页 HTTP：$code"
[ "$code" = "200" ] || { echo "!! 首页不是 200；看 docker compose logs -f frontend"; exit 1; }
if curl -s http://127.0.0.1:8081/ | grep -q 'id="root"'; then
  echo "   已确认是 React 前端（挂载点 #root）"
else
  echo "!! 页面里没有 #root —— 可能还是旧的 Vue 构建：确认源码确实换了、镜像确实重建了"
  exit 1
fi
echo "完成。"
