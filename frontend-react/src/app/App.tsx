/**
 * 应用壳：Provider + 路由 + 登录守卫 + 全局 Toast。
 *
 * 路由表与旧前端 `frontend/src/router/index.ts` **逐条对应**（路径、标题、重定向都照抄），
 * 因为桌面壳、书签、nginx 分流与文档里引用的都是这些地址。三条约定同样照搬：
 *
 * 1. `/chat/:conversationId?` 与 `/notes/:noteId?` 必须写成**一条可选参数路由**——
 *    拆成两条会在选中会话/笔记时卸载重建，把刚发出去的流或未保存的正文一起带走
 *    （旧前端踩过，注释里留着现场）；
 * 2. 页面懒加载：首屏只需要当前那一页；驾驶舱的 ECharts 再单独异步（见 misc 域）；
 * 3. 登录守卫的顺序不能换：**先看 `needs_setup`**（还没有账号 → 首次设置），
 *    再看有没有凭据（无 → 登录页 + `redirect`）。`ensureAuthStatus` 失败**不拦**，
 *    否则后端起不来会在守卫里死循环，用户连"后端没起"都看不到。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Suspense, lazy, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'

import { Toaster } from '@/ui/sonner'
import { ensureAuthStatus, restoreSession } from '@/lib/sessionActions'
import { hasCredential, sessionToken, useSessionStore } from '@/lib/session'
import { loadRoster } from '@/lib/operator'
import { ChatPage } from '@/features/chat/ChatPage'

const KnowledgeBasesView = lazy(() =>
  import('@/features/knowledge').then((m) => ({ default: m.KnowledgeBasesView })),
)
const KnowledgeBaseView = lazy(() =>
  import('@/features/knowledge').then((m) => ({ default: m.KnowledgeBaseView })),
)
const WikiView = lazy(() => import('@/features/knowledge').then((m) => ({ default: m.WikiView })))
const DocumentView = lazy(() =>
  import('@/features/knowledge').then((m) => ({ default: m.DocumentView })),
)
const NotesView = lazy(() =>
  import('@/features/notes/NotesView').then((m) => ({ default: m.NotesView })),
)
const LoginPage = lazy(() =>
  import('@/features/misc/auth/LoginPage').then((m) => ({ default: m.LoginPage })),
)
const TasksPage = lazy(() =>
  import('@/features/misc/tasks/TasksPage').then((m) => ({ default: m.TasksPage })),
)
const MemoryPage = lazy(() =>
  import('@/features/misc/memory/MemoryPage').then((m) => ({ default: m.MemoryPage })),
)
const WorkspacesPage = lazy(() =>
  import('@/features/misc/workspaces/WorkspacesPage').then((m) => ({ default: m.WorkspacesPage })),
)
const CapabilitiesPage = lazy(() =>
  import('@/features/misc/capabilities/CapabilitiesPage').then((m) => ({
    default: m.CapabilitiesPage,
  })),
)
const DashboardPage = lazy(() =>
  import('@/features/misc/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
)
const NotFoundPage = lazy(() =>
  import('@/features/misc/auth/NotFoundPage').then((m) => ({ default: m.NotFoundPage })),
)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 自托管的局域网服务：失败多半是"服务没起来"或"令牌过期"，两次足够让抖动自愈
      retry: 2,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})

/** 浏览器的标签标题（旧前端 `afterEach` 的口径）。 */
const TITLES: Array<[RegExp, string]> = [
  [/^\/login/, '登录'],
  [/^\/($|\?)/, '概览'],
  [/^\/knowledge-bases/, '知识库'],
  [/^\/kb\/[^/]+\/wiki/, 'Wiki'],
  [/^\/kb\//, '文档列表'],
  [/^\/documents\//, '文档详情'],
  [/^\/chat/, '对话'],
  [/^\/notes/, '笔记'],
  [/^\/tasks/, '任务中心'],
  [/^\/memory/, '记忆'],
  [/^\/workspaces/, '工作区'],
  [/^\/capabilities/, '能力'],
]

/**
 * 登录守卫（写在组件里而不是路由 `loader`）：`ensureAuthStatus` 是异步的，
 * 而在渲染之前必须知道"是放行还是跳登录页"，否则会先闪一下目标页再跳走。
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const status = await ensureAuthStatus()
      if (!alive) return
      const onLogin = location.pathname === '/login'
      if (onLogin) {
        if (!status?.needs_setup && sessionToken() && (await restoreSession())) {
          navigate('/chat', { replace: true })
          return
        }
        setReady(true)
        return
      }
      if (status?.needs_setup || !hasCredential()) {
        navigate(`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`, {
          replace: true,
        })
        return
      }
      setReady(true)
    })()
    return () => {
      alive = false
    }
    // 只在路径变化时重跑：把 location 整个放进依赖会导致每次查询参数变化都验一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  if (!ready) return <div className="h-dvh bg-canvas" />
  return <>{children}</>
}

/** 会话恢复之后拉一次名册：上传者列、归属标注都要它（拿不到不影响使用）。 */
function RosterBoot() {
  const user = useSessionStore((state) => state.currentUser)
  useEffect(() => {
    if (user) void loadRoster()
  }, [user])
  return null
}

/** 标题跟随路由（旧前端 `router.afterEach`）。 */
function TitleSync() {
  const location = useLocation()
  useEffect(() => {
    const hit = TITLES.find(([pattern]) => pattern.test(location.pathname))
    document.title = hit ? `${hit[1]} · KYLAB 知识库` : 'KYLAB 知识库'
  }, [location.pathname])
  return null
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TitleSync />
        <RosterBoot />
        <AuthGate>
          <Suspense fallback={<div className="h-dvh bg-canvas" />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/" element={<Navigate to="/chat" replace />} />
              <Route path="/chat/:conversationId?" element={<ChatPage />} />
              <Route path="/knowledge-bases" element={<KnowledgeBasesView />} />
              <Route path="/kb/:kbId" element={<KnowledgeBaseView />} />
              <Route path="/kb/:kbId/wiki" element={<WikiView />} />
              <Route path="/documents/:documentId" element={<DocumentView />} />
              <Route path="/notes/:noteId?" element={<NotesView />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/memory" element={<MemoryPage />} />
              <Route path="/workspaces" element={<WorkspacesPage />} />
              <Route path="/capabilities" element={<CapabilitiesPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              {/* 旧地址保留成重定向，免得旧书签变 404（与旧前端同一处置） */}
              <Route path="/search" element={<Navigate to="/knowledge-bases" replace />} />
              <Route path="/settings" element={<Navigate to="/dashboard" replace />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </AuthGate>
        {/* 全局 Toast：各域只调 toast()，容器只此一处 */}
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
