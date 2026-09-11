import { createRouter, createWebHistory } from 'vue-router'

import { consoleToken } from '@/composables/useConsoleToken'
import { ensureAuthStatus, restoreSession } from '@/composables/useSession'
import { hasCredential, sessionToken } from '@/composables/useSessionToken'

declare module 'vue-router' {
  interface RouteMeta {
    /** 浏览器标签标题；缺省时只显示产品名。 */
    title?: string
  }
}

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
 *
 * `/login` 是唯一一个例外：它不在"五个页面"里，因为**没有它就进不来**——
 * 登录不是一份清单，是门。
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { title: '登录' },
    },
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

/**
 * 登录守卫。
 *
 * 判定链（顺序不能换）：
 * 1. **还没有任何账号**（`needs_setup`）→ 首次设置向导。例外：已经存着控制台令牌的
 *    老部署放行——令牌是应急恢复钥匙，不能因为升级就被挡在门外。
 * 2. **鉴权已启用且没有任何凭据** → 去登录页，并把原地址塞进 `redirect`。
 * 3. 其余情况放行（本机未启用鉴权的开发态连 `/auth/status` 都不必成功）。
 *
 * `ensureAuthStatus` 失败返回 null：后端没起时**不拦**，否则会在守卫里
 * 反复重定向成一个死循环，而用户连"后端没起"这句话都看不到。
 */
router.beforeEach(async (to) => {
  if (to.name === 'login') {
    const status = await ensureAuthStatus()
    if (!status?.needs_setup) {
      // 本地有会话令牌则验一次；验证失败会自己清掉，停在登录页
      if (sessionToken()) {
        if (await restoreSession()) return { name: 'home' }
      } else if (consoleToken()) {
        return { name: 'home' }
      }
    }
    return true
  }

  const status = await ensureAuthStatus()
  if (status?.needs_setup && !consoleToken()) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (status?.auth_enabled && !hasCredential()) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  return true
})

router.afterEach((to) => {
  const title = to.meta.title
  document.title = title ? `${title} · KYLAB 知识库` : 'KYLAB 知识库'
})

export default router
