import { createRouter, createWebHistory } from 'vue-router'

/**
 * 路由路径统一 kebab-case，页面归属 views/（工程规范 §4.1 / §4.2）。
 * M0 只落地骨架页；知识库树、文件列表、任务中心、调试台、设置在 M5 接入。
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/HomeView.vue'),
      meta: { title: '概览' },
    },
  ],
})

export default router
