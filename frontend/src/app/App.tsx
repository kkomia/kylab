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
import { PAGES } from '@/app/routes'
import { AppShell } from '@/features/layout'

// 懒加载的**入口函数**都在 `app/routes.ts` 里（侧栏的 hover 预热要用同一批函数，
// 同一个函数引用 React 才会复用同一个 chunk）。
const ChatPage = lazy(PAGES.chat)
const KnowledgeBasesView = lazy(PAGES.knowledgeBases)
const KnowledgeBaseView = lazy(PAGES.knowledgeBase)
const WikiView = lazy(PAGES.wiki)
const DocumentView = lazy(PAGES.document)
const NotesView = lazy(PAGES.notes)
const LoginPage = lazy(PAGES.login)
const TasksPage = lazy(PAGES.tasks)
const MemoryPage = lazy(PAGES.memory)
const CapabilitiesPage = lazy(PAGES.capabilities)
const DashboardPage = lazy(PAGES.dashboard)
const NotFoundPage = lazy(PAGES.notFound)

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
  [/^\/dashboard/, '概览'],
  [/^\/knowledge-bases/, '知识库'],
  [/^\/kb\/[^/]+\/wiki/, 'Wiki'],
  [/^\/kb\//, '文档列表'],
  [/^\/documents\//, '文档详情'],
  [/^\/chat/, '对话'],
  [/^\/notes/, '笔记'],
  [/^\/tasks/, '任务中心'],
  [/^\/memory/, '记忆'],
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
        if (!status?.needs_setup && sessionToken() && (await restoreSession()) === 'ok') {
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
      // **恢复身份**：令牌可能还在但过期/被吊销（改密、管理员踢掉）。
      // 不验一次的话，侧栏账号区会空着（`currentUser` 一直是 null）、
      // 而每个请求各报一次 401。
      //
      // 但**只有"凭据真失效"才落登录页**（D07，2026-09-28 走查）：网络不通 / 超时 /
      // 后端 5xx 时令牌留着、界面照常起来（各请求自己报它们各自的错）。原先这里只认布尔，
      // 一次网络抖动就把人强制登出，而且**本地令牌被删了**——那才是最难补救的后果。
      const restored = await restoreSession()
      if (restored === 'expired') {
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

  if (!ready) return <BootSkeleton />
  return <>{children}</>
}

/**
 * **启动期的骨架**（D30，2026-09-28 走查）。
 *
 * 两处用过它：`AuthGate` 还没判完身份时（实测那一段是 **146–513ms** 的纯空白），
 * 以及路由懒加载那一段（`Suspense` 的兜底，20–62ms）。原先两处都是
 * `<div className="h-dvh bg-canvas" />`——**一块什么都没有的画布**，用户看到的是"白屏"，
 * 分不清是在加载还是坏了。
 *
 * 形状照着真实的应用壳摆（左侧一栏 + 右侧内容），所以内容到位时**不跳**：
 * 两块的位置与尺寸都对得上，只是从灰块换成真东西。用 `animate-pulse` 表示"在动"，
 * `motion-reduce:animate-none` 尊重系统里那个"减少动态效果"（与样式层同一条口径）。
 */
function BootSkeleton() {
  return (
    <div
      data-testid="app-boot-skeleton"
      aria-hidden="true"
      className="flex h-dvh bg-[var(--bg-canvas)]"
    >
      {/* 侧栏那一栏：宽屏才有（窄屏下真实的侧栏也是收起的，见 §12.305） */}
      <div className="hidden w-[var(--sidebar-width)] shrink-0 flex-col gap-[var(--space-2)] border-r border-[var(--border-hairline)] p-[var(--space-3)] sm:flex">
        {[0, 1, 2, 3, 4].map((row) => (
          <span
            key={row}
            className="block h-[28px] animate-pulse rounded-[var(--radius-control)] bg-[var(--bg-active)] motion-reduce:animate-none"
          />
        ))}
      </div>
      {/* 内容那一栏：标题块 + 两段正文块，与对话页的骨架同一节奏 */}
      <div className="flex min-w-0 flex-1 flex-col gap-[var(--space-3)] p-[var(--page-gutter)]">
        <span className="block h-[24px] w-[40%] animate-pulse rounded-[var(--radius-control)] bg-[var(--bg-active)] motion-reduce:animate-none" />
        <span className="block h-[120px] animate-pulse rounded-[var(--radius-panel)] bg-[var(--bg-active)] motion-reduce:animate-none" />
        <span className="block h-[120px] w-[70%] animate-pulse rounded-[var(--radius-panel)] bg-[var(--bg-active)] motion-reduce:animate-none" />
      </div>
    </div>
  )
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
          <Suspense fallback={<BootSkeleton />}>
            <Routes>
              {/* 登录页在壳外：它没有侧栏（旧前端 `/login` 也是独立一页） */}
              <Route path="/login" element={<LoginPage />} />
              {/* 其余全在壳里：侧栏 + 内容区 + 历史会话面板（`features/layout`） */}
              <Route element={<AppShell />}>
                {/* 落地页与旧前端一致：`/` 是**概览**（驾驶舱），不是对话页 */}
                <Route path="/" element={<DashboardPage />} />
                <Route path="/dashboard" element={<Navigate to="/" replace />} />
                <Route path="/chat/:conversationId?" element={<ChatPage />} />
                <Route path="/knowledge-bases" element={<KnowledgeBasesView />} />
                <Route path="/kb/:kbId" element={<KnowledgeBaseView />} />
                <Route path="/kb/:kbId/wiki" element={<WikiView />} />
                <Route path="/documents/:documentId" element={<DocumentView />} />
                <Route path="/notes/:noteId?" element={<NotesView />} />
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/memory" element={<MemoryPage />} />
                <Route path="/capabilities" element={<CapabilitiesPage />} />
                {/* 旧地址保留成重定向，免得旧书签变 404（与旧前端同一处置） */}
                <Route path="/search" element={<Navigate to="/knowledge-bases" replace />} />
                <Route path="/settings" element={<Navigate to="/" replace />} />
                {/* 「工作区」那一页已按用户要求删掉：旧书签回首页。项目分组本身还在侧栏里
                    （那一节照旧列会话）；**「新增项目」的入口也在侧栏那一节的标题右边**
                    （2026-09-28 按用户要求加回来的，见 `features/layout/SideNav.tsx`），
                    所以删掉这一页之后"建项目"这件事仍然做得了。 */}
                <Route path="/workspaces" element={<Navigate to="/" replace />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </Suspense>
        </AuthGate>
        {/* 全局 Toast：各域只调 toast()，容器只此一处 */}
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
