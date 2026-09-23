import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * 新前端（React）的构建与开发配置。
 *
 * 与旧前端的差别只有两处，其余照旧：端口 5174（两套前端要能同时起着对照），
 * 以及 `@` 别名、`/api` 反代到后端——**路径约定与旧前端逐字一致**，
 * 这样 nginx 分流与桌面壳都不用改。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  server: {
    host: '0.0.0.0',
    port: 5174,
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
