import { createRouter, createWebHistory } from 'vue-router'

/**
 * 路由路径统一 kebab-case，页面归属 views/（工程规范 §4.1 / §4.2）。
 * 懒加载：首屏只需要概览页，检索调试台与设置页按需拉取。
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
    {
      path: '/kb/:kbId',
      name: 'knowledge-base',
      component: () => import('@/views/KnowledgeBaseView.vue'),
      meta: { title: '文档列表' },
    },
    {
      path: '/documents/:documentId',
      name: 'document',
      component: () => import('@/views/DocumentView.vue'),
      meta: { title: '文档详情' },
    },
    {
      path: '/tasks',
      name: 'tasks',
      component: () => import('@/views/TasksView.vue'),
      meta: { title: '任务中心' },
    },
    {
      path: '/search',
      name: 'search',
      component: () => import('@/views/SearchView.vue'),
      meta: { title: '检索调试台' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { title: '设置' },
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
      meta: { title: '页面不存在' },
    },
  ],
})

router.afterEach((to) => {
  const title = to.meta.title as string | undefined
  document.title = title ? `${title} · KYLAB 知识库` : 'KYLAB 知识库'
})

export default router
