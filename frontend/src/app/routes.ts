/**
 * 页面的**懒加载入口**集中在一处：路由表要用它们（`React.lazy`），
 * 侧栏的 hover/focus 预热也要用它们（旧 `SideNav.vue` 就是这么预载路由 chunk 的：
 * 悬停导航项先把那一页的代码拉下来，点进去就不必等）。
 *
 * 分成两份导出是刻意的：
 * - `PAGES['notes']` 这类**函数**给 `React.lazy` 用（同一个函数引用，React 才会复用同一个 chunk）；
 * - `preloadPage(name)` 给预热用（内部吞掉失败——预热失败不该影响任何交互，真正点进去时
 *   该报的错照旧由那一页自己报）。
 */
export const PAGES = {
  // 对话页：**必须懒加载**——它带着 assistant-ui + katex + highlight.js，
  // 静态 import 会把整包打进主 chunk（实测：主 chunk 1423.9 kB、首屏合计 ~1.6 MB）。
  // 旧前端也是懒加载的（`ChatView` 走 `() => import(...)`）。
  chat: () => import('@/features/chat/ChatPage').then((m) => ({ default: m.ChatPage })),
  login: () => import('@/features/misc/auth/LoginPage').then((m) => ({ default: m.LoginPage })),
  dashboard: () =>
    import('@/features/misc/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
  knowledgeBases: () =>
    import('@/features/knowledge').then((m) => ({ default: m.KnowledgeBasesView })),
  knowledgeBase: () =>
    import('@/features/knowledge').then((m) => ({ default: m.KnowledgeBaseView })),
  wiki: () => import('@/features/knowledge').then((m) => ({ default: m.WikiView })),
  document: () => import('@/features/knowledge').then((m) => ({ default: m.DocumentView })),
  notes: () => import('@/features/notes/NotesView').then((m) => ({ default: m.NotesView })),
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
