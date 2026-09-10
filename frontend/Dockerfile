# 前端镜像（M7 / T7.1）。
#
# 构建出静态文件，交给 nginx 提供，并让 nginx **把 /api 反代到后端**。
#
# 为什么不由后端直接提供静态文件：那要给 FastAPI 挂静态目录、处理 SPA 回退、
# 配缓存头——都是 nginx 一句话的事。而且分开之后前端可以独立重建与部署。
FROM node:22-slim AS builder

WORKDIR /app

# 先装依赖再拷源码：源码改动不该让依赖层失效
COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .
RUN npm run build


FROM nginx:1.27-alpine AS runtime

# 站点配置：SPA 回退 + /api 反代 + 静态资源缓存
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
