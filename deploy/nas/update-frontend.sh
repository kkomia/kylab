#!/usr/bin/env sh
# NAS 上更新前端（P5 之后跑的是 React 版）。
#
# 用法（在 NAS 上）：sh /vol1/1000/docker/kylab/src/deploy/nas/update-frontend.sh [分支]
#   默认分支 react（目前只有它带新前端）；合并进 main 之后不传参数也行、传 main 也行。
#
# 为什么单独一个脚本：手工那三步（fetch/checkout、build、up -d）里最容易漏的是
# **"只重建 frontend"**——整仓 up -d --build 会把后端一起重建（慢得多，而且没必要）。
# 再就是这次要认一下"跑的是哪一版"：React 的挂载点是 #root、旧的 Vue 是 #app，
# 镜像没真的换掉时，页面会安静地还是旧的那一版。
set -eu

BRANCH="${1:-react}"
SRC="/vol1/1000/docker/kylab/src"
APP="/vol1/1000/docker/kylab/app"

echo "== 1/4 源码：切到 $BRANCH 并拉取"
cd "$SRC"
git fetch --all --prune
git checkout "$BRANCH"
git pull --ff-only
git --no-pager log --oneline -1

echo "== 2/4 只重建前端镜像"
cd "$APP"
docker compose build frontend

echo "== 3/4 重启前端容器"
docker compose up -d frontend
sleep 3

echo "== 4/4 核对"
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/ || true)
echo "首页 HTTP：$code"
[ "$code" = "200" ] || { echo "!! 首页不是 200；看 docker compose logs -f frontend"; exit 1; }
if curl -s http://127.0.0.1:8081/ | grep -q 'id="root"'; then
  echo "已确认是 React 前端（挂载点 #root）"
else
  echo "注意：页面里没有 #root——可能还是旧的 Vue 构建（确认镜像是否真的重建了）"
  exit 1
fi
echo "完成。"
