/**
 * 应用外壳（《前端设计规范》§5 布局骨架）——与旧前端 `App.vue` 的模板部分逐条对应。
 *
 * ```
 * ┌──────────┬───────────────────────────────┐
 * │ SideNav  │ 内容区（路由页面）             │
 * └──────────┴───────────────────────────────┘
 *             历史会话面板（盖住内容区，侧栏留在左边）
 * ```
 *
 * ## 四条职责
 *
 * 1. **登录页不套侧栏**：还没有身份，侧栏上的会话、项目、设置都无从谈起；
 * 2. **历史会话面板挂在这一层**（不是某个页面里）：侧栏在每个页面都在，
 *    从任何页面点「查看全部会话」都该能打开它；
 * 3. **换页就把它关掉**（v0.26，用户报的 bug："看了历史会话之后点其他菜单没有反应"）。
 *    它是一块**盖住内容区的浮层**，而侧栏故意留在它左边——这样用户能一边翻历史一边切页。
 *    代价是：不主动关的话，点了「笔记」路由确实变了，可内容区上还压着历史会话那一屏，
 *    用户看到的就是"点了没反应，切不过去"。**浮层没关，等于菜单没坏但用不了。**
 *
 *    挂在路由上而不是逐个菜单去关：路径一变就关，拖住的是"任何一次跳转"，
 *    以后新加的页面不用记得这一条；
 * 4. **会话失效（401）送往登录页**：`api/client.ts` 在 401 时递增 `reloginCount`，
 *    壳负责把它变成"跳到登录页并记住原地址"——任何请求都可能失效，所以这条不能
 *    挂在某一个页面上（旧 `App.vue` 的 `watch(reloginCount)`）。
 *
 * ## 主控怎么接（两种都行）
 *
 * ```tsx
 * // ① 布局路由（推荐：登录页天然在壳外）
 * <Route element={<AppShell />}>
 *   <Route path="/chat/:conversationId?" element={<ChatPage />} />
 *   …其余业务路由…
 * </Route>
 *
 * // ② 直接包住路由表
 * <AppShell>
 *   <Routes>…</Routes>
 * </AppShell>
 * ```
 *
 * 两种都由 `BrowserRouter` 之内渲染（`useLocation` / `Link` / `Outlet` 都依赖路由上下文）。
 * 壳自己还会在 `/login` 上退化成"只有内容区"——即使用第二种写法把登录页包进来，
 * 也不会在登录页长出一条侧栏（与旧 `App.vue` 的 `shell-bare` 同一条）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'

import { initTheme } from '@/features/misc/settings/useTheme'
import { useSessionStore } from '@/lib/session'

import { ConversationHistoryPanel } from './ConversationHistoryPanel'
import { SideNav } from './SideNav'
import { resolveSidebarWidth, useSidebar } from './useSidebar'

/** 登录页的路径（旧 `App.vue` 判的是路由名 `login`）。 */
const LOGIN_PATH = '/login'

export function AppShell({ children }: { children?: React.ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { collapsed } = useSidebar()
  const reloginCount = useSessionStore((state) => state.reloginCount)
  const [historyOpen, setHistoryOpen] = useState(false)

  // 首屏脚本已经按存储设过主题与字号；这里把 composable 的状态与那两个值对齐，
  // 好让"当前是哪一档"在三处（首屏、设置页、本菜单那句"切换为浅色/深色"）一致。
  useEffect(() => {
    initTheme()
  }, [])

  /**
   * 换页关面板（见文件头第 3 条）。
   *
   * 依赖里放 `pathname + search`：旧版看的是 `route.fullPath`，两者等价
   * （`/chat/a` → `/chat/b` 这种"同一个路由不同参数"的跳转也要关）。
   */
  const fullPath = `${location.pathname}${location.search}`
  useEffect(() => {
    setHistoryOpen(false)
  }, [fullPath])

  /**
   * 会话失效（401）的统一出口：跳到登录页，并把原地址带在 `redirect` 上。
   *
   * 放在壳里而不是每个页面里，是因为**任何请求都可能失效**：`request()` 发现 401 会
   * 递增这个计数，壳一旦看到就送人去登录页——令牌过期于是变成"当场跳走、回来还在原处"，
   * 而不是"原地报一句登录已过期、用户只能自己刷新"（旧 `App.vue` 的 `watch(reloginCount)`）。
   *
   * **只认"计数变了"这一件事**（`handledRelogin` 那对 ref）：计数**不会**在重新登录后归零，
   * 所以不能写成"计数非零就跳"——那样用户重新登录、再点任何一个菜单都会被弹回登录页
   * （与接入层的守卫来回拉锯）。旧版的 `watch` 天然只在变化时触发，这里把那件事显式写出来；
   * 顺便也解决了"组件带着一个非零计数挂载"的情形（挂载不跳，只跟变化）。
   *
   * 已经在登录页就不动（否则会自己把自己再跳一次）。用 `replace` 与接入层的
   * `AuthGate` 同一口径：历史里不留一条"过期页面"，免得按返回又弹回来。
   */
  const handledRelogin = useRef(reloginCount)
  const target = useRef(fullPath)
  useEffect(() => {
    target.current = fullPath
  }, [fullPath])
  useEffect(() => {
    if (reloginCount === handledRelogin.current) return
    handledRelogin.current = reloginCount
    if (location.pathname === LOGIN_PATH) return
    void navigate(`/login?redirect=${encodeURIComponent(target.current)}`, { replace: true })
  }, [reloginCount, location.pathname, navigate])

  const closeHistory = useCallback(() => setHistoryOpen(false), [])

  // 侧栏在登录页不渲染（登录页撑满整个窗口）
  const bare = location.pathname === LOGIN_PATH
  // 面板左侧让位的宽度要跟着折叠态走：折叠后侧栏只有 60px，
  // 固定写 240px 会在两者之间留一条 180px 的内容区（旧版就是这样）
  const sidebarWidth = resolveSidebarWidth(collapsed)

  return (
    <div className="flex h-full">
      {!bare && <SideNav onOpenHistory={() => setHistoryOpen(true)} />}
      {/* 内容区是**暖底的地面**，面板/卡片才是抬起来的白层（Kimi 的层级方向） */}
      <main className="min-w-0 flex-1 overflow-y-auto bg-[var(--bg-canvas)]">
        {children ?? <Outlet />}
      </main>

      <ConversationHistoryPanel
        open={historyOpen}
        onClose={closeHistory}
        sidebarWidth={sidebarWidth}
      />
    </div>
  )
}
