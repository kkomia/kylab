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
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // 端口被占就**直接失败**：静默换到 5175 会留下"我改了界面却没变"的错觉（旧前端同款理由）
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  build: { outDir: 'dist', sourcemap: false },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    css: false,
  },
})
