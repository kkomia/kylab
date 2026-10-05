import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * 新前端（React）的构建与开发配置。
 *
 * **端口 5173**：迁移期曾临时用 5174（两套前端并排对照），P5 切换后回到 5173——
 * 桌面壳、书签、文档与 `dev-frontend` 脚本里存的就是它。
 * `@` 别名、`/api` 反代到后端、strictPort 都与迁移前逐字一致，
 * 所以 nginx 分流与桌面壳都不用改。
 */

/**
 * `/api` 反代的目标（`KYLAB_API_TARGET`，**默认一字不变**）。
 *
 * 1. 默认 `http://127.0.0.1:8000` = "服务器档"的开发后端（`scripts/dev-backend.sh`），
 *    它自己有知识库 —— `docs/规范/部署与运行-v0.4.md` §2.2 写的就是它；
 * 2. 走**本机档 + NAS**那一套（`scripts/dev-sidecar.sh`：对话在本机边车、知识库在 NAS）时
 *    设成 NAS 地址，例如
 *    `KYLAB_API_TARGET=http://192.168.31.18:8081 pnpm dev`。
 *    这正是**桌面壳的形态**：壳把 `/api/**` 原样转发到 NAS、`Authorization` 用
 *    **页面自己的**（`desktop/src-tauri/src/resources.rs::proxy`，那一段只转发、只注入设备标记）。
 *    浏览器里没有壳，等价的做法就是这个反代 —— 再在登录页对那台 NAS 登一次，
 *    于是"服务器面"的请求（概览 / 知识库 / 设置…）都有真后端可打。
 */
const apiTarget = process.env.KYLAB_API_TARGET || 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // 端口被占就**直接失败**：静默换到 5175 会留下"我改了界面却没变"的错觉（旧前端同款理由）
    strictPort: true,
    proxy: { '/api': apiTarget },
  },
  build: { outDir: 'dist', sourcemap: false },
  // `vite preview` 是**生产构建的验收入口**：NAS 上跑的是 `dist/` + nginx 反代，
  // 这里给它同一套 `/api` 反代，就能在本机用真实后端验一遍"构建产物 + 反代"这条链
  // （`pnpm build && pnpm preview`，端口 4174 避开 dev 的 5173）。
  preview: {
    port: 4174,
    strictPort: true,
    proxy: { '/api': apiTarget },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    css: false,
  },
})
