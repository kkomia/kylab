import { createRouter, createWebHistory } from 'vue-router'

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
      /**
       * 历史会话用**路径**而不是查询参数：侧栏点进去要能前进/后退，
       * 也要能直接收藏某一次对话。
       *
       * **必须写成"一条可选参数路由"，不能拆成 `/chat` + `/chat/:id` 两条**：
       * 两条就是两条不同的路由记录，从 `/chat` 跳到 `/chat/:id` 时 Vue 会把
       * ChatView **卸载重建**（同一位置、不同类型 → patch 不了）。
       * 旧实例的 `onBeforeUnmount` 会掐掉刚发出去的那条流，于是"新建会话问第一句"
       * 永远拿不到回答：会话建出来了、路径也变了，但库里 0 条消息、界面弹回欢迎页
       * （实测复现）。可选参数下是**同一条记录**，Vue 复用实例、只更新参数，
       * 由 ChatView 里那个 watch 负责重新装载。
       */
      path: '/chat/:conversationId?',
      name: 'chat',
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
      /**
       * Wiki 是知识库的**一种阅读形态**，挂在库下面而不是新增一个全局页面：
       * 它读的就是这个库的内容，离开库上下文没有意义（《界面信息架构草案》§1）。
       * 当前选中哪一页走查询参数 `?page=`，与文档页的 `?doc=` 同一约定——
       * 刷新、分享链接、浏览器后退都能回到同一页。
       */
      path: '/kb/:kbId/wiki',
      name: 'kb-wiki',
      component: () => import('@/views/WikiView.vue'),
      meta: { title: 'Wiki' },
    },
    {
      path: '/documents/:documentId',
      name: 'document',
      component: () => import('@/views/DocumentView.vue'),
      meta: { title: '文档详情' },
    },
    {
      /**
       * 与对话同样写成"一条可选参数路由"：列表与编辑器共用一个视图，
       * 拆成两条会在选中笔记时把编辑器连同未保存的内容一起卸载重建。
       */
      path: '/notes/:noteId?',
      name: 'notes',
      component: () => import('@/views/NotesView.vue'),
      meta: { title: '笔记' },
    },
    {
      path: '/tasks',
      name: 'tasks',
      component: () => import('@/views/TasksView.vue'),
      meta: { title: '任务中心' },
    },
    {
      /**
       * 记忆是**独立的一页**，不挂在某个库下面：它跟知识库是两个池子
       * （记忆="你说的"、无出处；知识库="文献说的"、有出处），共用一页会让
       * "我要找的是哪一种"变成一个先得回答的问题。见《记忆层设计 v0.1》§2.1。
       *
       * 页内三块（文件 / 图谱 / 召回）走分段控件而不是路由：它们是同一份数据的
       * 三种看法，切来切去不该产生历史记录，也不该让"刷新后回到哪一屏"变成问题。
       */
      path: '/memory',
      name: 'memory',
      component: () => import('@/views/MemoryView.vue'),
      meta: { title: '记忆' },
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
 * 1. **还没有任何账号**（`needs_setup`）→ 首次设置向导（创建管理员）。
 * 2. **没有任何凭据** → 去登录页，并把原地址塞进 `redirect`。
 * 3. 其余情况放行。
 *
 * v0.11 起没有"未启用鉴权所以放行"这条支路：唯一的管理员身份来源是账号。
 *
 * `ensureAuthStatus` 失败返回 null：后端没起时**不拦**，否则会在守卫里
 * 反复重定向成一个死循环，而用户连"后端没起"这句话都看不到。
 */
router.beforeEach(async (to) => {
  if (to.name === 'login') {
    const status = await ensureAuthStatus()
    if (!status?.needs_setup && sessionToken()) {
      // 本地有会话令牌则验一次；验证失败会自己清掉，停在登录页
      if (await restoreSession()) return { name: 'home' }
    }
    return true
  }

  const status = await ensureAuthStatus()
  // v0.11 起鉴权永远生效：没有账号就去首次设置，有账号就必须带凭据。
  if (status?.needs_setup || !hasCredential()) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  return true
})

router.afterEach((to) => {
  const title = to.meta.title
  document.title = title ? `${title} · KYLAB 知识库` : 'KYLAB 知识库'
})

export default router
