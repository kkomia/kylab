/**
 * 本机后端门禁（2026-10-08）。
 *
 * 这一份**合并了原先那两份**（`auth-local-gate.test.tsx` 的"本机档不要求远端登录"与
 * `local-backend-gate.test.tsx` 的"没有本机后端时哪几页存在"）：门禁现在只有两条分支，
 * 而原先那两份验的正是同一件事的两面。
 *
 * | 情形 | 期望 |
 * | --- | --- |
 * | 有本机后端（桌面壳 / 浏览器直连边车） | 进壳，**一个账号请求都不发**（本机档免登录） |
 * | 没有本机后端 | 一页「本机后端未启动」，**整壳不渲染**（侧栏、那些清单都不碰） |
 * | 降级页上点「重试」 | 再探一次：探到了就当场进壳 |
 *
 * ## 判据那一趟**按真 HTTP 结论喂**（不替 `getLocalStatus` 的返回值）
 *
 * 门禁读的是 `api/local.ts::localBackendPresent`，它背后是 `probeLocalBackend()` →
 * 本模块内的 `getLocalStatus()`。**同模块内的调用替不掉**（`vi.mock` 换的是导出，
 * 模块内部那句 `getLocalStatus()` 不受影响）——所以这里与
 * `tests/unit/api/local.test.ts` 用同一手法：**替网络**（`/health` 连不上、
 * `/local/status` 由用例给一条真响应）。这样验的才是判据本身，不是替身的返回值。
 *
 * 账号那一族的替身**不是为了控制行为，而是为了抓住"谁又把它接回启动路径"**：
 * 本机档那两条用例断言它一次都没被调用。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  // `App` 自己挂着全局通知容器（`@/ui/sonner` 的 `Toaster`），这里换成一个空组件
  Toaster: () => null,
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('@/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/auth')>()
  return { ...actual, getAuthBootstrapStatus: vi.fn(), me: vi.fn() }
})

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

vi.mock('@/api/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/workspaces')>()),
  listWorkspaces: vi.fn(async () => ({ items: [] })),
}))

vi.mock('@/api/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/users')>()),
  listUsers: vi.fn(async () => ({ items: [] })),
}))

vi.mock('@/api/stats', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/stats')>()),
  getDashboard: vi.fn(async () => ({ cards: [], activity: [], trends: [] })),
}))

vi.mock('@/api/modelRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/modelRegistry')>()),
  getRegistry: vi.fn(async () => ({ providers: [], models: [], slots: [] })),
}))

vi.mock('@/api/knowledgeBases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/knowledgeBases')>()),
  listKnowledgeBases: vi.fn(async () => ({ items: [], total: 0 })),
}))

// 落地页（`/`）是概览，它按需把整个 ECharts 拉进来（`DashboardPage` 里那个 `lazy`），
// 而 jsdom 里没有 canvas：真去 `init` 会在线程里抛（`Cannot set properties of null
// (setting 'dpr')`），vitest 把"有未捕获异常"直接算成这一轮失败。这一份只关心
// "门禁放不放行"，**不需要那张图**——做法与 `tests/misc-dashboard.test.tsx` 逐字相同。
vi.mock('@/features/misc/dashboard/EChart', () => ({ EChart: () => null }))

import { App } from '@/app/App'
import { getAuthBootstrapStatus, me } from '@/api/auth'
import { resetBackupStore } from '@/api/backup'
import { resetSessionProbeForTest } from '@/api/client'
import { listConversations } from '@/api/conversations'
import { resetLocalBackendForTest, type LocalStatus } from '@/api/local'
import { resetProviderStore } from '@/api/provider'
import { resetSidecarProbe } from '@/api/sidecar'
import { useSessionStore } from '@/lib/session'

const statusMock = vi.mocked(getAuthBootstrapStatus)
const meMock = vi.mocked(me)
const listConversationsMock = vi.mocked(listConversations)

/** 本机后端对 `/local/status` 的回答（判据只用到档位那一栏，其余按形状给全）。 */
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

function answer(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 本机后端**答了话**：这一档是本机档。 */
function localBackendAnswers(): Response {
  return answer(localStatus('local'))
}

/** **404**：这一档没有这条端点（服务器档那一份，2026-10-05 起退役）。 */
function notFound(): Response {
  return answer({ code: 'not_found', message: 'Not Found' }, 404)
}

/**
 * 浏览器形态那一份的网络：`/health` 一律连不上（没有桌面壳、构建期那份基址上确实没人听），
 * 而 `/local/status` 的结论由用例给（这是判据唯一的输入）。其余请求一律拒绝
 * （这一份不发真请求；各域的读都由各自的替身答）。
 */
function browserNetwork(localAnswer: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const target = String(url)
      if (target.includes('/health')) throw new TypeError('本机后端不在这一档')
      if (target.includes('/local/status')) return localAnswer()
      throw new TypeError('这一条用例不发真请求')
    }),
  )
}

beforeEach(async () => {
  // 上一条用例的树先卸掉，再让挂出去的链条落地，最后清账（顺序反了会把"晚到的调用"
  // 算进这一条头上）。
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 20))
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  useSessionStore.setState({ token: '', currentUser: null, authStatus: null, reloginCount: 0 })
  resetSidecarProbe()
  resetProviderStore()
  resetBackupStore()
  resetSessionProbeForTest()
  resetLocalBackendForTest()
  browserNetwork(() => localBackendAnswers())
})

afterEach(() => {
  resetLocalBackendForTest()
  resetSidecarProbe()
  resetProviderStore()
  resetBackupStore()
  vi.unstubAllGlobals()
})

/** 进到壳里了吗（侧栏那条主导航在，就说明门禁放行了）。 */
async function expectInsideShell(): Promise<void> {
  await waitFor(
    () => {
      expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument()
    },
    { timeout: 12_000, interval: 50 },
  )
}

describe('没有本机后端：一页「本机后端未启动」', () => {
  /*
   * ⚠️ **这一组必须在文件最前面**（2026-10-08 实测）：React 19 会在下一次渲染时"重连"
   * 上一棵树的被动 effect，于是**上一条用例留下的整壳**会把 `SideNav` 那次读
   * `listConversations` 记进**下一条用例**的账里。下面第一条断言"一笔清单都不读"，
   * 所以它前面不能有任何挂过壳的用例。（`beforeEach` 里的 `cleanup()` 挡不住这一手，
   * 试过了。）后两条会挂壳，因此排在它后面。
   */
  it('整壳不渲染，而且一笔清单都不读', { timeout: 15_000 }, async () => {
    browserNetwork(() => notFound())
    // 账从 render 之前这一刻起算：上一条用例挂出去的链条可能晚一拍才落地
    //（`beforeEach` 里那次清账与"晚到的调用"是两条独立的时间线，实测抓到过）
    const readsBefore = listConversationsMock.mock.calls.length
    const authBefore = statusMock.mock.calls.length + meMock.mock.calls.length

    render(<App />)

    expect(await screen.findByText('本机后端未启动')).toBeInTheDocument()
    // 没有侧栏（连壳都没渲染），也没有主导航
    expect(screen.queryByRole('complementary', { name: '侧栏' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull()
    // 给它机会：真要是去读了，这几笔会在这段时间里落地
    await new Promise((resolve) => setTimeout(resolve, 50))
    // 会话 / 项目 / 名册那几笔读都没有发生（读下去只会是 404）
    expect(listConversationsMock.mock.calls.length).toBe(readsBefore)
    // 账号那一族同样一次都不问
    expect(statusMock.mock.calls.length + meMock.mock.calls.length).toBe(authBefore)
  })

  it(
    '旧书签（/chat、/notes、/memory、/capabilities、/knowledge-bases）都落在这一页上',
    { timeout: 30_000 },
    async () => {
      browserNetwork(() => notFound())

      for (const path of [
        '/chat',
        '/notes',
        '/memory',
        '/capabilities',
        '/knowledge-bases',
        '/kb/kb-1',
      ]) {
        window.history.pushState({}, '', path)
        const view = render(<App />)
        expect(await screen.findByText('本机后端未启动')).toBeInTheDocument()
        // 既不是一页 404（那是"地址拼错了"的口径），也不是半截壳
        expect(screen.queryByRole('heading', { name: '页面不存在' })).toBeNull()
        expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull()
        view.unmount()
      }
    },
  )

  it(
    '探不通（连不上 / 超时）**不改结论**：仍按完整产品渲染，不误判成"没有本机后端"',
    { timeout: 15_000 },
    async () => {
      // 本机后端没起来时打的正是这一档：连接层抛 `TypeError`（不是 HTTP 状态码），
      // `localBackendView` 的既有口径是"不知道 → 按有渲染"——一次抖动不该把整壳拆成
      // 一页提示（拆掉的是"确认没有"那一支，而它要的是 404）。
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (String(url).includes('/health')) throw new TypeError('本机后端不在这一档')
          throw new TypeError('Failed to fetch')
        }),
      )

      render(<App />)

      await expectInsideShell()
    },
  )
})
describe('有本机后端：进壳，一个账号请求都不发（本机档免登录）', () => {
  it('浏览器里探到本机档 → 直接进壳，且不问远端账号体系', { timeout: 15_000 }, async () => {
    render(<App />)

    await expectInsideShell()
    expect(window.location.pathname).toBe('/')
    // **这就是"不问登录"的物证**：那两条账号请求一次都没发出去
    //（原先那版守卫正是在这里问了一次 `/auth/status`，NAS 一答话就把人送去登录页）
    expect(statusMock).not.toHaveBeenCalled()
    expect(meMock).not.toHaveBeenCalled()
  })

  it(
    '会话面那几页都在（新建会话 + 概览 / 笔记 / 记忆 / 能力 / 任务中心）',
    { timeout: 15_000 },
    async () => {
      render(<App />)

      await expectInsideShell()
      expect(screen.getByRole('link', { name: /新建会话/ })).toBeInTheDocument()
      const nav = screen.getByRole('navigation', { name: '主导航' })
      for (const label of ['概览', '笔记', '记忆', '能力', '任务中心']) {
        expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument()
      }
      // 会话清单照常读（那一档的数据面在本机）
      await waitFor(() => expect(listConversationsMock).toHaveBeenCalled())
    },
  )
})

describe('降级页上的「重试」', () => {
  it('先探到 404、起来之后再点一下 → 当场进壳，不必刷新', { timeout: 15_000 }, async () => {
    const user = userEvent.setup()
    let up = false
    browserNetwork(() => (up ? localBackendAnswers() : notFound()))

    render(<App />)
    expect(await screen.findByText('本机后端未启动')).toBeInTheDocument()

    // 边车起来了：同一个端点现在答"我是本机档"
    up = true
    await user.click(screen.getByRole('button', { name: '重试' }))

    await expectInsideShell()
  })
})
