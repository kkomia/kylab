# 新前端（React）的镜像——与 `frontend/Dockerfile` 同构，只换了包管理器（pnpm）。
#
# 走 pnpm 的理由：本目录的依赖树按 pnpm 解析（`pnpm-workspace.yaml` 里给 esbuild
# 放行安装脚本，缺了它 vite 起不来）；与两个前端共存的过渡期保持一致。
# P5 切换时 `deploy/docker-compose.yml` 只需把 `context: ../frontend` 改成
# `../frontend-react`、镜像名改 `kylab-web`。
FROM node:22-slim AS builder

WORKDIR /app

# pnpm 由 corepack 提供（版本跟着 package.json 的 packageManager 走，若有）
RUN corepack enable

# 先装依赖再拷源码：源码改动不该让依赖层失效
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY . .
RUN pnpm build


FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
