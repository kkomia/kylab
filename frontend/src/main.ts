import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import router from './router'

import './assets/base.css'
import './assets/themes/light.css'
import './assets/themes/dark.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)

/**
 * **等首次导航解析完再挂载**。
 *
 * 路由守卫是异步的（要问一次 `/auth/status`），而外壳（侧栏）不在 `<RouterView>` 里——
 * 提前挂载会先渲染出完整侧栏，侧栏一挂载就发知识库/会话/名册请求，于是未登录用户
 * 在登录页背后白挨一串 401，还会弹出"需要控制台令牌"的提示。等 `isReady()` 之后，
 * `route.name` 已经是最终值（`login` 或目标页），侧栏该不该出现就是确定的。
 *
 * 用 `.then()` 而不是顶层 `await`：后者要求构建目标支持顶层 await，
 * 会让生产构建的 target 被迫抬到 esnext，代价大于收益。
 */
void router.isReady().then(() => app.mount('#app'))
