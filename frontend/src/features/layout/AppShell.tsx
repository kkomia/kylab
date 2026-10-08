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
 * 顶上原本还有一条「我的数据在哪」的状态带（M2 阶段 4 的 `LocalDataStrip`）：会话 /
 * 笔记 / 设置从 M2 起落**本机**（边车进程里的 SQLite），"我的数据在哪"要一直看得见
 * （方案 §4.3 的"回退不许静默"）。**R5 起整条删掉**（用户拍板）：那一行要回答的事
 * 在「设置 → 备份」那一节里读得到，顶栏不必常驻一条状态带。
 *
 * ## 四条职责
 *
 * 1. **壳里只有业务页**：登录页已删（本机档免登录，见 `app/App.tsx` 的文件头），
 *    所以这一层不再有"某条路由不套侧栏"那一种形态；
 * 2. **历史会话面板挂在这一层**（不是某个页面里）：侧栏在每个页面都在，
 *    从任何页面点「查看全部会话」都该能打开它；
 * 3. **换页就把它关掉**（v0.26，用户报的 bug："看了历史会话之后点其他菜单没有反应"）。
 *    它是一块**盖住内容区的浮层**，而侧栏故意留在它左边——这样用户能一边翻历史一边切页。
 *    代价是：不主动关的话，点了「笔记」路由确实变了，可内容区上还压着历史会话那一屏，
 *    用户看到的就是"点了没反应，切不过去"。**浮层没关，等于菜单没坏但用不了。**
 *
 *    挂在路由上而不是逐个菜单去关：路径一变就关，拖住的是"任何一次跳转"，
 *    以后新加的页面不用记得这一条；
 * 4. **会话失效（401）清掉本地凭据**：`api/client.ts` 在 401 时递增 `reloginCount`，
 *    壳负责把那个信号变成"这份本地凭据已经不认了"——**不再跳登录页**（没有登录页了，
 *    见 `app/App.tsx` 的文件头）：本机档照常能用，而留着一条死凭据只会让它继续
 *    贴在每个请求的头上（原先这一步由 `restoreSession` 的 `expired` 分支顺手做，
 *    那条链随登录页一起下线了）。
 *
 * ## 主控怎么接
 *
 * ```tsx
 * <Route element={<AppShell />}>
 *   <Route path="/chat/:conversationId?" element={<ChatPage />} />
 *   …其余业务路由…
 * </Route>
 * ```
 *
 * 由 `BrowserRouter` 之内渲染（`useLocation` / `Link` / `Outlet` 都依赖路由上下文）。
 */
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router'

import { initTheme } from '@/features/misc/settings/useTheme'
import { clearSessionToken, useSessionStore } from '@/lib/session'

import { ConversationHistoryPanel } from './ConversationHistoryPanel'
import { onIdle, prewarmMisc } from '@/features/misc/prewarm'
import { SideNav } from './SideNav'
import { resolveSidebarWidth, useSidebar } from './useSidebar'

export function AppShell({ children }: { children?: React.ReactNode }) {
  const queryClient = useQueryClient()

  // 启动后**空闲预热**：任务列表与概览统计（旧 `SideNav.vue` 的 idle 预热口径）。
  // 每个 client 只做一次（`useRef` 挡 StrictMode 的二次挂载）。
  const prewarmed = useRef(false)
  useEffect(() => {
    if (prewarmed.current) return
    prewarmed.current = true
    onIdle(() => prewarmMisc(queryClient))
  }, [queryClient])

  const location = useLocation()
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
   * 会话失效（401）的统一出口：**清掉本地凭据**，不再跳登录页（见文件头第 4 条）。
   *
   * 放在壳里而不是每个页面里，是因为**任何请求都可能失效**：`request()` 发现 401 会
   * 递增这个计数（`api/client.ts`），壳负责把它变成一件具体的事。
   *
   * **只认"计数变了"这一件事**（`handledRelogin` 那个 ref）：计数不会归零，所以不能写成
   * "计数非零就清"——那会让每次挂载都清一次（旧版 `watch` 天然只在变化时触发，
   * 这里把那件事显式写出来；也顺带解决了"组件带着一个非零计数挂载"的情形）。
   */
  const handledRelogin = useRef(reloginCount)
  useEffect(() => {
    if (reloginCount === handledRelogin.current) return
    handledRelogin.current = reloginCount
    clearSessionToken()
  }, [reloginCount])

  const closeHistory = useCallback(() => setHistoryOpen(false), [])

  // 面板左侧让位的宽度要跟着折叠态走：折叠后侧栏只有 60px，
  // 固定写 240px 会在两者之间留一条 180px 的内容区（旧版就是这样）
  const sidebarWidth = resolveSidebarWidth(collapsed)

  return (
    <div className="flex h-full">
      <SideNav onOpenHistory={() => setHistoryOpen(true)} />
      {/* 内容区那一列 = 抬起来的卡片（M2 阶段 4）。
          卡片是 Kimi 的层级方向（§8）：上/右/下留 6px 露出画布底，左侧与侧栏相接
          —— 边界就是"两块不同颜色的面"，没有分隔线（Kimi 实测无 border-right）。
          顶上原本摆着那条 6px 画布带上的状态带（`LocalDataStrip`，R5 删掉），
          卡片因此升到最上面。 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="mb-[6px] mr-[6px] min-h-0 min-w-0 flex-1 overflow-y-auto rounded-[var(--radius-panel)] bg-[var(--bg-surface)]">
          {children ?? <Outlet />}
        </main>
      </div>

      <ConversationHistoryPanel
        open={historyOpen}
        onClose={closeHistory}
        sidebarWidth={sidebarWidth}
      />
    </div>
  )
}
