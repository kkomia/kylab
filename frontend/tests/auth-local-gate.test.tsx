/**
 * 登录守卫的「本机档」那条出路（R13，2026-10-04）。
 *
 * M3 / M4 / M5 三次验收记录与《交接说明》都记着同一条：**远端（NAS）不可达时前端被
 * 登录守卫拦回登录页，本机那份进不了界面** —— 而会话 / 笔记 / 设置 / 记忆就在本机，
 * 本机后端的账号体系整个不参与（`/auth/*` 压根没挂在那一档的路由表上）。
 *
 * 四种情形逐条钉住（第三条是本轮的施工内容，另外两条是**不许被改坏**的原行为）：
 *
 * | 情形 | 期望 |
 * | --- | --- |
 * | 拿到登录会话 | 进（原行为） |
 * | **远端不可达 + 本机档** | **也进** + 一条克制的 toast（"连不上服务器…"） |
 * | 远端可达但未登录 | 拦回登录页（原行为一字不改） |
 * | 远端不可达 + **不是**本机档（服务器档 / 浏览器档） | 也拦回登录页（不许放宽） |
 *
 * 判据读的是本机后端那一条 `/local/status`（`lib/sessionActions.localOnlyDeployment`），
 * 所以这里替身的是 `@/api/local`——判据本身不靠"某个端口上恰好在跑什么"。
 * 网络一律替身，一条真请求都不发出去。
 */
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  // `App` 自己挂着全局通知容器（`@/ui/sonner` 的 `Toaster`），这一条把它换成一个空组件；
  // 断言走 `toast.warning` 这一层（与 `provider-gate.test.tsx` 同一写法）
  Toaster: () => null,
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('@/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/auth')>()
  return { ...actual, getAuthBootstrapStatus: vi.fn(), me: vi.fn() }
})

// 本机档的判据：替身，用例逐档摆答案（`local.ts` 里其余导出照旧）
vi.mock('@/api/local', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/local')>()),
  getLocalStatus: vi.fn(),
}))

// 壳（侧栏）一挂载就要这几样：会话清单、项目清单、名册；概览页要统计那一条
vi.mock('@/api/conversations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/conversations')>()),
  getConversation: vi.fn(),
  listConversations: vi.fn(async () => ({ items: [], total: 0 })),
  listArtifacts: vi.fn(async () => ({ items: [] })),
  listFiles: vi.fn(async () => ({
    mode: 'object',
    label: '本会话',
    path: '',
    parent: null,
    entries: [],
    truncated: false,
  })),
}))

vi.mock('@/api/stats', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/stats')>()),
  getDashboard: vi.fn(async () => ({ cards: [], activity: [], trends: [] })),
}))

// 落地页（`/`）是概览，它按需把整个 ECharts 拉进来（`DashboardPage` 里那个 `lazy`）。
// 这一份用例只关心"守卫放没放行"，**不需要那张图**——而 jsdom 里没有 canvas：真去
// `init` 会在线程里抛 `Cannot set properties of null (setting 'dpr')`（`EChart.tsx:320`）。
//
// 为什么非替掉不可（2026-10-05 实测，就是本文件那条"远端不可达 + 本机档"）：
// 整仓并发跑（77 个用例文件各一个 worker）时它**在 12036ms 上抛**——内层等待被用满，
// 那一刻 DOM 里连侧栏都还没出来；同一轮还带出 10~23 条上面那种未捕获异常，
// 而 vitest 把"有未捕获异常"直接算成这一轮失败（1313 条断言全过也照红）。
// 替掉之后：这一条用例 **38ms**（原先单单这一条就是 0.7~12 秒），整仓跑
// 1313/1313 全过、未捕获异常 0 条、退出码 0。做法与 `tests/misc-dashboard.test.tsx`
// 逐字相同（那里也是"jsdom 没有 canvas，真 init 会把用例打挂"），
// 而"图表按需异步加载"这件事由 `DashboardPage` 自己的结构保证，不靠这份用例验。
vi.mock('@/features/misc/dashboard/EChart', () => ({ EChart: () => null }))

vi.mock('@/api/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/workspaces')>()),
  listWorkspaces: vi.fn(async () => ({ items: [] })),
}))

vi.mock('@/api/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/users')>()),
  listUsers: vi.fn(async () => ({ items: [] })),
}))

vi.mock('@/api/modelRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/modelRegistry')>()),
  getRegistry: vi.fn(async () => ({ providers: [], models: [], slots: [] })),
}))

vi.mock('@/api/knowledgeBases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/knowledgeBases')>()),
  listKnowledgeBases: vi.fn(async () => ({ items: [], total: 0 })),
}))

import { toast } from 'sonner'

import { App, OFFLINE_LOCAL_ONLY_NOTICE } from '@/app/App'
import { getAuthBootstrapStatus, me } from '@/api/auth'
import { resetBackupStore } from '@/api/backup'
import { resetSessionProbeForTest } from '@/api/client'
import { getLocalStatus, type LocalStatus } from '@/api/local'
import { resetProviderStore } from '@/api/provider'
import { resetSidecarProbe } from '@/api/sidecar'
import { SESSION_TOKEN_STORAGE_KEY, setSessionToken, useSessionStore } from '@/lib/session'

const statusMock = vi.mocked(getAuthBootstrapStatus)
const meMock = vi.mocked(me)
const localStatusMock = vi.mocked(getLocalStatus)
const warning = vi.mocked(toast.warning)

/** 本机后端对 `/local/status` 的回答（只用到判据那两栏：档位 + 形状检查要的 `imports`）。 */
function localStatus(deployment: string): LocalStatus {
  return {
    deployment,
    data_dir: 'x',
    database: 'x',
    database_exists: true,
    database_bytes: 0,
    database_wal_bytes: 0,
    server_url: null,
    imports: [],
    unfinished_imports: 0,
    unimported_file_references: 0,
    note: '',
  }
}

/** 远端问不出来：`ensureAuthStatus` 把一次失败折成空（连接不通 / 超时 / 5xx 都是这一档）。 */
function remoteUnreachable(): void {
  statusMock.mockRejectedValue(new TypeError('Failed to fetch'))
}

/** 远端答了话：这一档的账号体系在服务器上。 */
function remoteAnswered(needsSetup = false): void {
  statusMock.mockResolvedValue({ needs_setup: needsSetup })
}

function withCredential(): void {
  window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, 'kylab_st_test')
  setSessionToken('kylab_st_test')
}

function withoutCredential(): void {
  window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY)
  setSessionToken('')
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  useSessionStore.setState({ token: '', currentUser: null, authStatus: null, reloginCount: 0 })
  withoutCredential()
  resetSidecarProbe()
  resetProviderStore()
  resetBackupStore()
  resetSessionProbeForTest()
  meMock.mockResolvedValue({
    id: 'u1',
    username: 'admin',
    name: '管理员',
    role: 'admin',
    avatar_url: '',
  })
  // 网络那一层不参与：本机档那条判据由 `@/api/local` 的替身答，其余一律不可达
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('这一条用例不发真请求')
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetSidecarProbe()
  resetProviderStore()
  resetBackupStore()
})

/**
 * 进到壳里了吗（侧栏那一条主导航在，就说明守卫放行了）。
 *
 * **外层必须 ≥ 内层**：原先内层 12 秒、外层只有 vitest 默认的 5 秒，那个等待预算
 * **根本用不上**（用例先被 runner 判超时），表现就是"整仓跑红、单跑绿"。
 * 所以照 `smoke.test.tsx` / `local-backend-gate.test.tsx` 里那几条同类用例的写法
 * （同是"等整壳挂载"、同样**不动全局 `testTimeout`**）给下面两条用例各加
 * `{ timeout: 15_000 }`，内层维持 12 秒——**替掉那张图之后这条链已经不到 1 秒**，
 * 12 秒是给并发跑留的余量，不是它真的需要（见上面 `EChart` 那一段的实测数字）。
 */
async function expectInsideShell(): Promise<void> {
  await waitFor(
    () => {
      expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument()
    },
    { timeout: 12_000, interval: 50 },
  )
}

describe('登录守卫：本机档不要求远端登录（R13）', () => {
  it('拿到登录会话 → 进（原行为）', { timeout: 15_000 }, async () => {
    remoteAnswered()
    withCredential()

    render(<App />)

    await expectInsideShell()
    expect(window.location.pathname).toBe('/')
  })

  it('远端不可达 + 本机档 → **也进**，并说一句"连不上服务器"', { timeout: 15_000 }, async () => {
    // 两条同时成立：远端问不出来（NAS 不可达）+ 本机后端答了 `/local/status` 且那是本机档
    remoteUnreachable()
    localStatusMock.mockResolvedValue(localStatus('local'))

    render(<App />)

    await expectInsideShell()
    // 地址没被改成登录页——本机那份（会话 / 笔记 / 设置）就在这一屏上
    expect(window.location.pathname).toBe('/')
    expect(warning).toHaveBeenCalledWith(OFFLINE_LOCAL_ONLY_NOTICE)
    // 与知识库/备份那两条守卫同一口径：**只此一次**（守卫每次换页都会重跑）
    expect(warning).toHaveBeenCalledTimes(1)
  })

  it('远端可达但未登录 → 拦回登录页（原行为一字不改）', async () => {
    remoteAnswered()

    render(<App />)

    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    expect(window.location.search).toContain('redirect=%2F')
    expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull()
    // 远端答了话就**不问本机**：那一问只属于"远端问不出来"那一档
    expect(localStatusMock).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
  })

  it('远端不可达 + 不是本机档（服务器档 / 浏览器档）→ 也拦回登录页', async () => {
    remoteUnreachable()
    // 本机后端不在这一档：那条端点答不上来（或答的是服务器档）
    localStatusMock.mockRejectedValue(new Error('Not Found'))

    render(<App />)

    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull()
    expect(warning).not.toHaveBeenCalled()
  })

  it('远端不可达 + 后端说自己是服务器档 → 不放宽', async () => {
    remoteUnreachable()
    localStatusMock.mockResolvedValue(localStatus('server'))

    render(<App />)

    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    expect(warning).not.toHaveBeenCalled()
  })
})
