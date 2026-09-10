import { createRouter, createWebHistory } from 'vue-router'

/**
 * 路由路径统一 kebab-case，页面归属 views/（工程规范 §4.1 / §4.2）。
 * 懒加载：首屏只需要驾驶舱，其余按需拉取。
 *
 * 页面收敛到五个（《界面信息架构草案》§1：不新增全局页面，除非它自己是一份清单）：
 * 概览=驾驶舱、知识库=卡片清单、对话=问答记录、文档详情=阅读、任务中心=流水线清单。
 * 检索是"在某个库里查东西"，收在知识库详情页；对话是"跨库问答"，
 * 它的结果本身就是一份带引用的记录，放得进一个页面。
 * 设置是动作，收在弹窗里。
 * 旧地址 `/search`、`/settings` 保留成重定向，免得旧书签变 404。
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/DashboardView.vue'),
      meta: { title: '概览' },
    },
    {
      path: '/knowledge-bases',
      name: 'knowledge-bases',
      component: () => import('@/views/KnowledgeBasesView.vue'),
      meta: { title: '知识库' },
    },
    {
      path: '/chat',
      name: 'chat',
      component: () => import('@/views/ChatView.vue'),
      meta: { title: '对话' },
    },
    {
      // 历史会话用**路径**而不是查询参数：侧栏点进去要能前进/后退，
      // 也要能直接收藏某一次对话。/chat/:id 让这两件事都成立。
      path: '/chat/:conversationId',
      name: 'conversation',
      component: () => import('@/views/ChatView.vue'),
      meta: { title: '对话' },
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
      redirect: { name: 'knowledge-bases' },
    },
    {
      path: '/settings',
      redirect: { name: 'home' },
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
