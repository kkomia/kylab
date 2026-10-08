/**
 * 页面的**懒加载入口**集中在一处：路由表要用它们（`React.lazy`），
 * 侧栏的 hover/focus 预热也要用它们（旧 `SideNav.vue` 就是这么预载路由 chunk 的：
 * 悬停导航项先把那一页的代码拉下来，点进去就不必等）。
 *
 * 分成两份导出是刻意的：
 * - `PAGES['notes']` 这类**函数**给 `React.lazy` 用（同一个函数引用，React 才会复用同一个 chunk）；
 * - `preloadPage(name)` 给预热用（内部吞掉失败——预热失败不该影响任何交互，真正点进去时
 *   该报的错照旧由那一页自己报）。
 *
 * 2026-10-08：知识库那四页（列表 / 库详情 / Wiki / 文档详情）与登录页一并删掉
 * （知识库管理台搬去 kybase、本机档免登录，见 `app/App.tsx` 文件头）——这里是**页面
 * 清单的唯一来源**，路由表与侧栏预热都从这里取，删一处就够了。
 */
export const PAGES = {
  // 对话页：**必须懒加载**——它带着 assistant-ui + katex + highlight.js，
  // 静态 import 会把整包打进主 chunk（实测：主 chunk 1423.9 kB、首屏合计 ~1.6 MB）。
  // 旧前端也是懒加载的（`ChatView` 走 `() => import(...)`）。
  chat: () => import('@/features/chat/ChatPage').then((m) => ({ default: m.ChatPage })),
  dashboard: () =>
    import('@/features/misc/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
  notes: () => import('@/features/notes/NotesView').then((m) => ({ default: m.NotesView })),
  // 备份（M5 阶段 7）：**本机档专属**的一页，路由外面还包一层 `BackupRoute`
  // （那一层只判"这一档有没有本机后端"，不判提供者连没连上）。
  backup: () => import('@/features/backup/BackupPage').then((m) => ({ default: m.BackupPage })),
  tasks: () => import('@/features/misc/tasks/TasksPage').then((m) => ({ default: m.TasksPage })),
  memory: () =>
    import('@/features/misc/memory/MemoryPage').then((m) => ({ default: m.MemoryPage })),
  capabilities: () =>
    import('@/features/misc/capabilities/CapabilitiesPage').then((m) => ({
      default: m.CapabilitiesPage,
    })),
  notFound: () =>
    import('@/features/misc/auth/NotFoundPage').then((m) => ({ default: m.NotFoundPage })),
} as const

export type PageName = keyof typeof PAGES

/** 预热某一页的代码（失败静默：预热不是功能，别让它影响交互）。 */
export function preloadPage(name: PageName): void {
  void PAGES[name]().catch(() => undefined)
}
