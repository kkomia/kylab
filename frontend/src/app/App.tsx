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
 *
 * ## R13：本机档不要求远端登录（2026-10-04）
 *
 * M3 / M4 / M5 三次验收与《交接说明》都记着同一条：**远端（NAS）不可达时前端被守卫
 * 拦回登录页，本机那份进不了界面** —— 而这一档的会话 / 笔记 / 设置 / 记忆**就在本机**
 * （边车进程里的库），本机后端的账号体系整个不参与（`/auth/*` 压根没挂在那一档的路由表上）。
 * 把人挡在登录页外面，等于"本机数据看不见"，与"本机权威"直接冲突。
 *
 * 于是守卫多一条出路：**远端问不出来（`ensureAuthStatus` 回空）+ 这一档只连本机后端**
 * （`sessionActions.localOnlyDeployment`，判据是本机后端答不答 `/local/status`）→ 放行，
 * 并给一条克制的 toast（远端依赖的那几件各有各的降级：知识库走 `ProviderRoute`、
 * 备份页自己报远端收不收得了快照）。**远端答了话就一个字都不变**——该登录还是要登录，
 * 门禁不是被拆掉，只是不再拿远端当本机数据的门。
 *
 * ## M3 阶段 6：知识库那四条路由多一层守卫
 *
 * `ProviderRoute` 包住四条知识库路由（列表 / 库详情 / Wiki / 文档详情）：本机档里
 * 提供者不可用时**重定向到 `/chat` + 一条含原因的 toast**（方案 §3.3）。它不是登录守卫
 * 那种"挡在门口"的东西——服务器档（浏览器 / NAS 网页端）里它一个判断都不做，
 * 那一档的知识库就是它自己。`ProviderBoot` 在启动时**不挡渲染**地探一次状态。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'

import { refresh as refreshProvider } from '@/api/provider'
import { Toaster } from '@/ui/sonner'
import { ensureAuthStatus, localOnlyDeployment, restoreSession } from '@/lib/sessionActions'
import { hasCredential, sessionToken, useSessionStore } from '@/lib/session'
import { loadRoster } from '@/lib/operator'
import { PAGES } from '@/app/routes'
import { BackupRoute } from '@/features/backup/BackupRoute'
import { ProviderRoute } from '@/features/knowledge/ProviderRoute'
import { AppShell } from '@/features/layout'
import { notifyWarning } from '@/features/misc/shared/toast'

// 懒加载的**入口函数**都在 `app/routes.ts` 里（侧栏的 hover 预热要用同一批函数，
// 同一个函数引用 React 才会复用同一个 chunk）。
const ChatPage = lazy(PAGES.chat)
const KnowledgeBasesView = lazy(PAGES.knowledgeBases)
const KnowledgeBaseView = lazy(PAGES.knowledgeBase)
const WikiView = lazy(PAGES.wiki)
const DocumentView = lazy(PAGES.document)
const NotesView = lazy(PAGES.notes)
const BackupPage = lazy(PAGES.backup)
const LoginPage = lazy(PAGES.login)
const TasksPage = lazy(PAGES.tasks)
const MemoryPage = lazy(PAGES.memory)
const CapabilitiesPage = lazy(PAGES.capabilities)
const DashboardPage = lazy(PAGES.dashboard)
const NotFoundPage = lazy(PAGES.notFound)

/**
 * 查询客户端。**导出是为了让用例钉住这份网络策略**（`tests/app-query-network.test.tsx`）：
 * 策略写在这里，用例读的必须是**壳真正挂给 Provider 的那一个**，否则改回默认值也能绿。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 自托管的局域网服务：失败多半是"服务没起来"或"令牌过期"，两次足够让抖动自愈
      retry: 2,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      /*
       * **不因浏览器自报"离线"就停摆**（2026-10-04 修）。
       *
       * react-query 的默认值 `'online'` 看的是 `navigator.onLine`：浏览器/系统只要自认为
       * 没有外网，查询就停在 `paused`——那时 `isLoading` 与 `isError` **同为 false**，
       * 界面既不报错也不加载，看上去就是"一直没有数据"（「能力」页实测到过，它为此把判据
       * 改成"手里有没有 `data`"；`data ?? []` 那种写法还会把它画成一个 0）。
       *
       * 但这个前端主要跟**本机后端**说话（`/api` 反代到 127.0.0.1:8000，桌面壳里是
       * 127.0.0.1:8100）：**"有没有外网"与"本机后端在不在"根本不是一回事**，断网时
       * 本机后端照常在跑。查询照发，成败交给响应说话——连不上就是一条真的错误态。
       *
       * 将来真接远端服务的那些查询，请在**自己的调用点**上写 `networkMode: 'online'`，
       * 不要改这里的默认值：这一条是全站的兜底。
       */
      networkMode: 'always',
    },
    // 写路径是同一个病：默认值下离线时 `mutate` 挂起——调了、promise 不落地、
    // 界面既不成功也不报错（保存就是这样静默丢失的）。本机服务照样照发为上。
    mutations: { networkMode: 'always' },
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
  [/^\/backup/, '备份'],
]

/**
 * 「本机档、远端连不上」时那句 toast（R13）。
 *
 * 克制的口径：**一句话说完**——远端那几件暂时用不上、本机那几件照常。
 * 不解释机制（为什么、哪台机器、哪条链路），也不劝用户做什么（远端回来时
 * 知识库与备份各自会把状态说清）。
 */
export const OFFLINE_LOCAL_ONLY_NOTICE =
  '连不上服务器：知识库与备份上传要连上服务器才用得上，会话与笔记照常在本机。'

/**
 * 登录守卫（写在组件里而不是路由 `loader`）：`ensureAuthStatus` 是异步的，
 * 而在渲染之前必须知道"是放行还是跳登录页"，否则会先闪一下目标页再跳走。
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [ready, setReady] = useState(false)
  // 「本机档、远端连不上」那一句**一次启动只说一遍**：守卫每次换页都会重跑，
  // 而这件事没有重说的价值（刷屏反而把它淹掉，与 `ProviderRoute` 那条 toast 同一条理由）。
  const toldOffline = useRef(false)

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
        // **R13：本机档不要求远端登录**（见文件头那一段）。两个条件同时成立才放行：
        // ① `status` 空 = **远端问不出来**（远端答了话就照原行为走登录页）；
        // ② 这一档**只连本机后端**（判据见 `sessionActions.localOnlyDeployment`）。
        // 放行不等于门禁被拆：远端依赖的那几件（知识库 / 备份上传）各有各的降级。
        if (status === null && !hasCredential() && (await localOnlyDeployment())) {
          if (!alive) return
          if (!toldOffline.current) {
            toldOffline.current = true
            notifyWarning(OFFLINE_LOCAL_ONLY_NOTICE)
          }
          setReady(true)
          return
        }
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
      {/* 侧栏那一栏：宽屏才有（窄屏下真实的侧栏也是收起的，见 §12.305）。
          与真实侧栏一样**不带分隔线**——边界靠"两块不同颜色的面"（§8）。 */}
      <div className="hidden w-[var(--sidebar-width)] shrink-0 flex-col gap-[var(--space-2)] p-[var(--space-3)] sm:flex">
        {[0, 1, 2, 3, 4].map((row) => (
          <span
            key={row}
            className="block h-[28px] animate-pulse rounded-[var(--radius-control)] bg-[var(--bg-active)] motion-reduce:animate-none"
          />
        ))}
      </div>
      {/* 内容那一栏：与真实内容区**同形**（抬起的卡片：上/右/下 6px、圆角 16、surface 底，§8）——
          内容到位时从灰块换成真东西不跳。标题块 + 两段正文块，与对话页的骨架同一节奏。 */}
      <div className="my-[6px] mr-[6px] flex min-w-0 flex-1 flex-col gap-[var(--space-3)] overflow-hidden rounded-[var(--radius-panel)] bg-[var(--bg-surface)] p-[var(--page-gutter)]">
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

/**
 * 启动时**探一次知识库提供者**（M3 阶段 6）。
 *
 * 不 await 渲染：这一探是"后台问一句"，首屏一个字都不等它（方案 §3.2 R1）——
 * 侧栏那一组在结论回来之前按**缺席**渲染（不闪一个点进去报错的入口）。
 * 探一次就够（`ref` 挡 StrictMode 的双挂载；模块级单飞是第二道保险）。
 *
 * 为什么放在 `App` 而不是每一页各探一次：状态是**进程级**的（模块级单份 + 30s 缓存），
 * 谁先问都一样；放在这里，登录页/对话页都能受益（壳一露头结论就已经在了）。
 */
function ProviderBoot() {
  const probed = useRef(false)
  useEffect(() => {
    if (probed.current) return
    probed.current = true
    void refreshProvider()
  }, [])
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
        <ProviderBoot />
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
                {/*
                  四条知识库路由都包一层守卫（M3 阶段 6）：提供者不可用时
                  重定向到 `/chat` + 一条含原因的 toast——不是白屏、也不是死页面。
                  页面代码照旧随壳打包（`app/routes.ts` 不改）：这一层只决定"进不进得去"。
                */}
                <Route
                  path="/knowledge-bases"
                  element={
                    <ProviderRoute>
                      <KnowledgeBasesView />
                    </ProviderRoute>
                  }
                />
                <Route
                  path="/kb/:kbId"
                  element={
                    <ProviderRoute>
                      <KnowledgeBaseView />
                    </ProviderRoute>
                  }
                />
                <Route
                  path="/kb/:kbId/wiki"
                  element={
                    <ProviderRoute>
                      <WikiView />
                    </ProviderRoute>
                  }
                />
                <Route
                  path="/documents/:documentId"
                  element={
                    <ProviderRoute>
                      <DocumentView />
                    </ProviderRoute>
                  }
                />
                <Route path="/notes/:noteId?" element={<NotesView />} />
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/memory" element={<MemoryPage />} />
                <Route path="/capabilities" element={<CapabilitiesPage />} />
                {/*
                  「备份」也是本机档专属（M5 阶段 7），但守卫的判据**不是**"提供者 ready"：
                  连不上远端时正是要看"有几份没备上去"，所以那一档照常放行。
                */}
                <Route
                  path="/backup"
                  element={
                    <BackupRoute>
                      <BackupPage />
                    </BackupRoute>
                  }
                />
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
