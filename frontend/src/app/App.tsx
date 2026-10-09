/**
 * 应用壳：Provider + 路由 + 本机后端门禁 + 全局 Toast。
 *
 * 路由表与旧前端 `frontend/src/router/index.ts` 逐条对应（路径、标题、重定向都照抄），
 * 因为桌面壳、书签与文档里引用的都是这些地址。两条约定同样照搬：
 *
 * 1. `/chat/:conversationId?` 与 `/notes/:noteId?` 必须写成**一条可选参数路由**——
 *    拆成两条会在选中会话/笔记时卸载重建，把刚发出去的流或未保存的正文一起带走
 *    （旧前端踩过，注释里留着现场）；
 * 2. 页面懒加载：首屏只需要当前那一页。
 *
 * ## 本机后端门禁：本机档**不问登录**（2026-10-08）
 *
 * 这一份界面只有一种形态——**背后有一个本机后端**（桌面壳里由壳拉起，浏览器里是
 * 127.0.0.1:8765 那个边车）。判据只有一处（`api/local.ts::localBackendPresent`），
 * 所以门禁只有两条分支：
 *
 * - **有本机后端 → 直接进**，一个字都不问：这一档的会话 / 笔记 / 设置 / 记忆就在本机，
 *   账号体系整个不参与（`/auth/*` 根本没挂在本机档的路由表上，后端把调用主体短路成
 *   "本机主人"）——**本机档的用户就是本机主人，永远不该要登录**。
 *
 *   2026-10-04 那版（R13）只在"远端问不出来"时才放行，于是 **NAS 一答话反而弹登录**，
 *   逻辑正好反了（远端达得到 = 拿远端那份账号体系来管本机数据）。这一版把它翻正：
 *   先认本机后端，再谈别的——而且**不再问远端一句**（那趟 `/auth/status` 连同
 *   "凭据快照 / 会话恢复"一起下线：登录页没了，这两步也就没有读者）。
 * - **没有本机后端 → 一页「本机后端未启动」**（`BackendMissingPage`）：如实说这一句，
 *   给一颗「重试」。没有第三种形态——原先"没有本机后端就只剩知识库管理台"那一套，
 *   随知识库管理台搬去 kybase 而作废。
 *
 * 于是登录页与 `/login` 这条路由**再无入口**，一并删掉；谁都不会再把用户送去登录。
 *
 * ## 知识库页面族下线（2026-10-08）
 *
 * 侧栏「知识库」那一组与 `/knowledge-bases`、`/kb/:kbId`、`/kb/:kbId/wiki`、
 * `/documents/:documentId` 四条路由连同页面组件一并删掉：**知识库的界面搬去了 kybase**
 * （那边有自己的管理台），本仓库只剩"对话里怎么用它"。旧书签落到 `*` 那页 404
 * （`/search` 那条旧地址改指 `/chat`，见下面的路由表）。
 *
 * 对话内的知识库能力照旧：输入框的选库（`api/chat.ts` 的 `kb_ids`）、
 * 回答里的引用来源、启动时那次
 * 提供者握手探测（`ProviderBoot`）——它们走**边车 HTTP 客户端连知识库服务**，
 * 与这里删掉的那几个页面没有依赖关系。
 *
 * ## 「概览」那一页下线（2026-10-09）
 *
 * `DashboardPage` 及 `features/misc/dashboard/`（含那张 ECharts 图与它那一族统计客户端
 * `api/stats.ts`）整块删掉：那一页数的全是知识库的家当（库数 / 文档 / 切块 / 入库节奏 /
 * 模型用量），而知识库的界面已经搬去 kybase——**产品不要这一页了**。
 *
 * 于是落地页改成**重定向**：`/` 与它的旧入口 `/dashboard` 都指 `/chat`
 * （敲根地址直接进对话），`/search`、`/settings`、`/workspaces` 这三条老书签
 * 也一并指 `/chat`（它们原先指 `/`，即那一页的落地地址）。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Suspense, lazy, useEffect, useRef } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'

import { refresh as refreshProvider } from '@/api/provider'
import { useLocalBackend } from '@/api/local'
import { Toaster } from '@/ui/sonner'
import { PAGES } from '@/app/routes'
import { BackendMissingPage } from '@/app/BackendMissingPage'
import { BackupRoute } from '@/features/backup/BackupRoute'
import { AppShell } from '@/features/layout'

// 懒加载的**入口函数**都在 `app/routes.ts` 里（侧栏的 hover 预热要用同一批函数，
// 同一个函数引用 React 才会复用同一个 chunk）。
const ChatPage = lazy(PAGES.chat)
const NotesView = lazy(PAGES.notes)
const BackupPage = lazy(PAGES.backup)
const MemoryPage = lazy(PAGES.memory)
const CapabilitiesPage = lazy(PAGES.capabilities)
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
  // `/` 与 `/dashboard` 都不在这一份里：它们只剩"重定向到 `/chat`"这一件事（见路由表），
  // 落地之后匹配到的就是下面这条「对话」。
  [/^\/chat/, '对话'],
  [/^\/notes/, '笔记'],
  [/^\/memory/, '记忆'],
  [/^\/capabilities/, '能力'],
  [/^\/backup/, '备份'],
]

/**
 * 本机后端门禁（见文件头）：有本机后端就渲染整壳，没有就一页「本机后端未启动」。
 *
 * 判据读 `useLocalBackend()`——与侧栏、路由表**同一个来源**（`api/local.ts`），
 * 所以"菜单里没有的、敲地址也进不去"在这一版里更彻底：没有本机后端时整个壳都不渲染。
 *
 * **它不是异步守卫**：判据本身是同步的（壳里恒真；浏览器那一份在结论回来之前按"有"
 * 渲染，见 `localBackendView` 的第三条分支），于是没有"先闪一帧目标页再跳走"的问题，
 * 也不需要启动期那一段等待骨架（`BootSkeleton` 现在只给路由懒加载用）。
 */
function LocalBackendGate({ children }: { children: React.ReactNode }) {
  const local = useLocalBackend()
  if (local.present) return <>{children}</>
  return <BackendMissingPage />
}

/**
 * **启动期的骨架**（D30，2026-09-28 走查）。
 *
 * 它是路由懒加载那一段的兜底（实测 20–62ms）：原先那一处是
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

/**
 * 启动时**探一次知识库提供者**（M3 阶段 6）。
 *
 * 不 await 渲染：这一探是"后台问一句"，首屏一个字都不等它（方案 §3.2 R1）。
 * 探一次就够（`ref` 挡 StrictMode 的双挂载；模块级单飞是第二道保险）。
 *
 * 为什么放在 `App` 而不是每一页各探一次：状态是**进程级**的（模块级单份 + 30s 缓存），
 * 谁先问都一样；放在这里，对话页（那颗「知识库」胶囊、上传上限）一露头结论就已经在了。
 * （原先任务中心的「流水线任务」那一段也吃这一探：那一段 2026-10-09 随知识库服务端
 * 剥走一起下掉了，现在只有对话页读它。）
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
    document.title = hit ? `${hit[1]} · KYLAB` : 'KYLAB'
  }, [location.pathname])
  return null
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TitleSync />
        <ProviderBoot />
        {/* 门禁在路由之外：没有本机后端时连壳都不渲染（见文件头） */}
        <LocalBackendGate>
          <Suspense fallback={<BootSkeleton />}>
            <Routes>
              {/*
                **纯重定向不套壳**（2026-10-09）：这几条只是"把旧地址改对"，没有任何内容 ——
                套在 `<Route element={<AppShell/>}>` 里的话，敲旧地址会先把整个壳（侧栏 +
                那一串读：会话 / 项目 / 名册）挂起来再跳走；本机后端还没结论的那一帧
                （`localBackendView` 第三条按"有"渲染）甚至会白打几条注定失败的请求。
                放在壳外面，重定向一落地就是目标页那一页的壳，与"直接敲 `/chat`"完全同形。
              */}
              {/* 落地页 = 对话页（2026-10-09）：`/` 与它的旧入口 `/dashboard` 都重定向过去
                  ——「概览」那一页整块删了（数知识库家当的页面，产品不要了）。 */}
              <Route path="/" element={<Navigate to="/chat" replace />} />
              <Route path="/dashboard" element={<Navigate to="/chat" replace />} />
              {/* 其余旧地址也保留成重定向，免得旧书签变 404（与旧前端同一处置）：
                  `/search` 原先指知识库首屏，那一页随知识库管理台一起下线了；
                  `/settings` 与 `/workspaces` 那两页更早就删了——这三条现在都回对话页。
                  （「工作区」那一页删掉之后"建项目"这件事仍然做得了：项目分组还在侧栏里，
                  「新增项目」的入口在侧栏那一节的标题右边，见 `features/layout/SideNav.tsx`。） */}
              <Route path="/search" element={<Navigate to="/chat" replace />} />
              <Route path="/settings" element={<Navigate to="/chat" replace />} />
              <Route path="/workspaces" element={<Navigate to="/chat" replace />} />

              {/* 业务页都在壳里：侧栏 + 内容区 + 历史会话面板（`features/layout`） */}
              <Route element={<AppShell />}>
                <Route path="/chat/:conversationId?" element={<ChatPage />} />
                <Route path="/notes/:noteId?" element={<NotesView />} />
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
                {/* 404 留在壳里：那一页给的两个出口（回对话 / 退回上一页）在侧栏旁边更好用，
                    而且"地址拼错了"时侧栏能让用户直接改道别的页（与旧前端同一处置）。 */}
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </Suspense>
        </LocalBackendGate>
        {/* 全局 Toast：各域只调 toast()，容器只此一处 */}
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
