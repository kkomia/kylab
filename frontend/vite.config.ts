import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)

/**
 * `@vue-office/*` 的 `main` 指向 `lib/index.js`——那是它 **postinstall** 生成的
 * vue-demi 切换产物（`vue-demi-switch 3`）。pnpm 默认拦截依赖的构建脚本，
 * 于是那个文件根本不存在，直接 import 会解析失败。
 *
 * 所以显式指向 Vue 3 构建（`lib/v3/index.js`）。这与 WeKnora 的处理一致——
 * 它们也得在 vite 配置里把 pptx 指到 v3 入口。
 */
function vueOfficeV3(pkg: string): string {
  try {
    const root = dirname(require.resolve(`${pkg}/package.json`))
    const entry = resolve(root, 'lib/v3/index.js')
    return existsSync(entry) ? entry : pkg
  } catch {
    return pkg
  }
}

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // 用**锚定正则**而不是字符串前缀：字符串别名会连
      // `@vue-office/excel/lib/v3/index.css` 一起改写，拼出个不存在的路径。
      {
        find: /^@vue-office\/excel$/,
        replacement: vueOfficeV3('@vue-office/excel'),
      },
      {
        find: /^@vue-office\/pptx$/,
        replacement: vueOfficeV3('@vue-office/pptx'),
      },
    ],
  },
  server: {
    // 绑定 0.0.0.0：用户经 VPN 从局域网访问，只监听 localhost 将无法打开页面
    host: '0.0.0.0',
    port: 5173,
    // **端口被占用时直接失败，不要自动换到 5174**（v0.37）：自动换端口会留下
    // 一个"旧实例还在 5173 上"的状态，而桌面壳与书签都指着 5173——
    // 表现为"我改了前端，界面却没变"（与后端那个重复启动的坑同一类，见《开发计划》§12.218）
    strictPort: true,
    // 后端 REST 统一走 /api/v1，开发期代理到本地服务（架构设计 v0.2 §3.1）
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    globals: false,
    // jsdom 缺几个浏览器 API（ResizeObserver 等），组件用它做尺寸自适应。
    // 补丁写在 tests/setup.ts 里，理由见那个文件。
    setupFiles: ['tests/setup.ts'],
  },
})
