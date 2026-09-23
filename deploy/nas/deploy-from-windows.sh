#!/usr/bin/env sh
# **从这台 Windows 直接部署到 NAS**（在 Git Bash 里跑；密码只在你的终端里输，不落任何地方）。
#
# 用法：sh deploy/nas/deploy-from-windows.sh [分支，默认 react] [主机，默认 192.168.31.18]
#
# 它把 README 里那两条命令合成**一次 ssh**（所以只问一次密码），并且在传之前先自证
# "这次要传的确实是新前端"——传一份旧的过去再构建，最后只会得到一个老界面，
# 那种失败最难看出来（页面 200、没有报错）。
set -eu

BRANCH="${1:-react}"
HOST="${2:-192.168.31.18}"
SRC="/vol1/1000/docker/kylab/src"
APP="/vol1/1000/docker/kylab/app"

echo "== 0/3 本机自证：分支与"要传的东西""
current=$(git rev-parse --abbrev-ref HEAD)
[ "$current" = "$BRANCH" ] || { echo "!! 当前在 $current 分支，不是 $BRANCH（先 git switch $BRANCH）"; exit 2; }
git cat-file -e "$BRANCH:frontend/src/features" 2>/dev/null \
  || { echo "!! $BRANCH 的 frontend/ 里没有 src/features —— 这不是新前端，传过去只会得到老界面"; exit 2; }
echo "   分支 $BRANCH ✓；归档里含 frontend/src/features ✓（新前端）"

echo "== 1/3 推源码 + 在 NAS 上重建前端（$HOST，会问一次密码）"
# 一条 ssh 里做完：解包 → 跑升级脚本（脚本自己还会核对源码形态、docker 权限）
git archive --format=tar "$BRANCH" | ssh "$HOST" \
  "mkdir -p $SRC && tar -x -C $SRC --overwrite && cd $APP && sh $SRC/deploy/nas/update-frontend.sh $BRANCH"

echo "== 2/3 从本机核对首页"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://$HOST:8081/" || true)
echo "   http://$HOST:8081/ → HTTP $code"
[ "$code" = "200" ] || { echo "!! 不是 200：看 NAS 上 docker compose logs -f frontend"; exit 1; }

echo "== 3/3 认一下跑的是哪一版（React 的挂载点是 #root，旧 Vue 是 #app）"
if curl -s "http://$HOST:8081/" | grep -q 'id="root"'; then
  echo "   已确认是 React 前端（#root）—— 部署完成。"
else
  echo "!! 页面里没有 #root：可能镜像没重建成功，或 src 还是旧前端（看上一步 NAS 的输出）"
  exit 1
fi
