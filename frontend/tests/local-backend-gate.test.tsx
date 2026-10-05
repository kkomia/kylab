/**
 * NAS 网页端退役（2026-10-05）：**没有本机后端的那一份只剩知识库管理台**。
 *
 * ## 这一份钉的是什么
 *
 * 服务器档从这一轮起不再挂会话面那几族端点（`backend/app/api/v1/router.py` 的模块头），
 * 所以"这一份有没有本机后端"不只是一个数据选址问题——它决定**哪几页存在**。
 * 界面这一侧只允许有一个判据（`api/local.ts`），而它有两处读者：
 *
 * | 读者 | 表现 |
 * | --- | --- |
 * | 侧栏（`features/layout/SideNav.tsx`） | 新建会话 / 笔记 / 记忆 / 能力 / 项目节 / 对话节**整段不渲染** |
 * | 路由表（`app/App.tsx`） | `/chat`、`/notes`、`/memory`、`/capabilities` **重定向到知识库首屏** |
 *
 * 两条要么一起成立、要么一起不成立：**菜单里没有的，敲地址也进不去**（反过来也一样）。
 * 这里把两处都钉住，因为分叉的表现是最难查的一种——"菜单藏了、书签还能进"。
 *
 * 判据本身（三态、404 才算"没有"、壳里恒真有）在 `tests/unit/api/local.test.ts` 那一份里；
 * 这一份只关心"判据为假时界面长什么样"，所以状态由 `setLocalBackendForTest` 直接摆。
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('@/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/auth')>()
  return { ...actual, getAuthBootstrapStatus: vi.fn(), me: vi.fn() }
})

// 判据那一层：本文件的用例逐档摆答案（`api/local.ts` 里其余导出照旧）
vi.mock('@/api/local', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/local')>()),
  getLocalStatus: vi.fn(),
}))

// 壳一挂载就要读的那几笔清单（有本机后端的那一档才会读，正是本文件的一条断言）
vi.mock('@/api/conversations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/conversations')>()),
  getConversation: vi.fn(),
  listConversations: vi.fn(async () => ({ items: [], total: 0 })),
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
  getDashboard: vi.fn(async () => ({
    knowledge_bases: [],
    activity: [],
    by_stage: {},
    by_suffix: {},
    by_source_kind: {},
  })),
}))

vi.mock('@/api/knowledgeBases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/knowledgeBases')>()),
  listKnowledgeBases: vi.fn(async () => ({ items: [], total: 0 })),
}))

// 落地页（`/`）是概览，它按需把整个 ECharts 拉进来（`DashboardPage` 里那个 `lazy`）；
// 而 **jsdom 没有 canvas** —— 真进到那一步就在线程里抛（两种都实测过：
// `EChart.tsx` 的 `Cannot set properties of null (setting 'dpr')`，以及它后面
// zrender 的 `Cannot read properties of null (reading 'clearRect')`）。这类异常
// **不算在任何一条断言上**，但 vitest 把"这一轮有未捕获异常"直接判成失败：
// 表现就是某个恰好同时在跑的文件被归上十几条异常、整仓退出码非 0。这一份只关心
// "哪几页存在、清单读不读"，**不需要那张图**，所以换成空组件——做法与
// `tests/misc-dashboard.test.tsx`、`tests/auth-local-gate.test.tsx` 逐字相同。
vi.mock('@/features/misc/dashboard/EChart', () => ({ EChart: () => null }))

import { App } from '@/app/App'
import { getAuthBootstrapStatus, me } from '@/api/auth'
import { resetBackupStore } from '@/api/backup'
import { resetSessionProbeForTest } from '@/api/client'
import { listConversations } from '@/api/conversations'
import { getLocalStatus } from '@/api/local'
import { resetLocalBackendForTest, setLocalBackendForTest } from '@/api/local'
import { resetProviderStore } from '@/api/provider'
import { resetSidecarProbe } from '@/api/sidecar'
import { SESSION_TOKEN_STORAGE_KEY, setSessionToken, useSessionStore } from '@/lib/session'

const statusMock = vi.mocked(getAuthBootstrapStatus)
const meMock = vi.mocked(me)
const localStatusMock = vi.mocked(getLocalStatus)
const listConversationsMock = vi.mocked(listConversations)

beforeEach(() => {
  vi.clearAllMocks()
  // 网络那一层不参与：判据由 `@/api/local` 的替身答，清单由各自的替身答，
  // 其余一律不可达（与 `auth-local-gate.test.tsx` 同一套写法）
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('这一条用例不发真请求')
    }),
  )
  // 探不通（不是 404）→ 判据**保留用例摆的那一档**（见 `api/local.ts` 的三态说明）
  localStatusMock.mockRejectedValue(new Error('这一条用例不发真请求'))
  // 服务器档的形态：远端答了话（账号体系在服务器上），而这台机器上有一个登录会话。
  // 这正是 NAS 网页端那一位用户的处境
  statusMock.mockResolvedValue({ needs_setup: false })
  meMock.mockResolvedValue({
    id: 'u1',
    username: 'kkomia',
    name: 'kkomia',
    role: 'admin',
    avatar_url: '',
  })
  window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, 'kylab_st_test')
  setSessionToken('kylab_st_test')
  useSessionStore.setState({ token: 'kylab_st_test', currentUser: null, reloginCount: 0 })
  resetSidecarProbe()
  resetProviderStore()
  resetBackupStore()
  resetSessionProbeForTest()
})

afterEach(() => {
  // **不 `vi.unstubAllGlobals()`**：`tests/setup.ts` 在模块加载时装的那几个 jsdom 兜底
  // （`ResizeObserver`、`matchMedia`…）会一起被撤掉，而这一份用例会渲染整页界面
  // （对话页要 `ResizeObserver`）。`fetch` 由 setup.ts 的 `beforeEach` 重新装回默认替身。
  resetLocalBackendForTest()
  resetSidecarProbe()
  resetProviderStore()
  resetBackupStore()
})

/** 在这个地址上渲染整个应用（真实的 `App`：路由表 + 壳 + 登录守卫）。 */
async function renderAt(path: string): Promise<void> {
  window.history.pushState({}, '', path)
  render(<App />)
  // 侧栏一到就说明登录守卫放行了（两条用例都要先到这一步才谈得上显隐）
  await waitFor(
    () => {
      expect(screen.getByRole('complementary', { name: '侧栏' })).toBeInTheDocument()
    },
    { timeout: 12_000, interval: 50 },
  )
}

function sidebar(): HTMLElement {
  return screen.getByRole('complementary', { name: '侧栏' })
}

/** 那三样会话面的东西在不在（一处判据、三条读者都靠它）。 */
function sessionEntries(): (HTMLElement | null)[] {
  const nav = screen.getByRole('navigation', { name: '主导航' })
  return [
    screen.queryByRole('link', { name: /新建会话/ }),
    within(nav).queryByRole('link', { name: '笔记' }),
    within(nav).queryByRole('link', { name: '记忆' }),
    within(nav).queryByRole('link', { name: '能力' }),
  ]
}

describe('没有本机后端（NAS 网页端那一份）', () => {
  beforeEach(() => {
    setLocalBackendForTest('absent')
  })

  // 这几条都要等整壳（登录守卫 → 懒加载的页面 chunk）才 settle，属 CPU 型重活：
  // 全量并发时默认的 5s 会超时（实测过一次），所以显式放宽——与
  // `smoke.test.tsx`、「重挂载类用例带着显式超时」那条约定同一处置。
  it('侧栏只剩「知识库」那一组，而且**默认就是展开的**', { timeout: 15_000 }, async () => {
    await renderAt('/knowledge-bases')

    expect(sessionEntries()).toEqual([null, null, null, null])
    // 整段项目节与对话节都不在（那一档里它们的数据面已经不服务了）
    expect(screen.queryByRole('button', { name: '项目' })).toBeNull()
    expect(screen.queryByRole('button', { name: '对话' })).toBeNull()
    // 留下的这一组是那一档的全部入口，所以**不用先点一下**
    expect(within(sidebar()).getByRole('link', { name: '所有知识库' })).toBeInTheDocument()
    expect(within(sidebar()).getByRole('link', { name: '概览' })).toBeInTheDocument()
    expect(within(sidebar()).getByRole('link', { name: '任务中心' })).toBeInTheDocument()
  })

  it('一笔会话 / 项目清单都不读（读下去只会是 404）', { timeout: 15_000 }, async () => {
    await renderAt('/knowledge-bases')

    expect(listConversationsMock).not.toHaveBeenCalled()
  })

  it(
    '敲 `/chat` 进来 → 落在知识库首屏（旧书签有个去处，不是一页 404）',
    { timeout: 15_000 },
    async () => {
      await renderAt('/chat')

      await waitFor(() => expect(window.location.pathname).toBe('/knowledge-bases'))
    },
  )

  it(
    '`/notes`、`/memory`、`/capabilities` 同理（逐页各渲染一次）',
    { timeout: 30_000 },
    async () => {
      for (const path of ['/notes', '/memory', '/capabilities']) {
        window.history.pushState({}, '', path)
        const view = render(<App />)
        await waitFor(() => expect(window.location.pathname).toBe('/knowledge-bases'), {
          timeout: 12_000,
        })
        view.unmount()
      }
    },
  )
})

describe('有本机后端（桌面壳 / 浏览器直连边车的那一份）', () => {
  beforeEach(() => {
    setLocalBackendForTest('local')
  })

  it(
    '会话面那几页都在，知识库那一组仍是收起（默认形态一个字没改）',
    { timeout: 15_000 },
    async () => {
      await renderAt('/knowledge-bases')

      expect(sessionEntries().every((item) => item !== null)).toBe(true)
      // 知识库那一组照旧默认收起（展开是用户的事）
      expect(within(sidebar()).queryByRole('link', { name: '所有知识库' })).toBeNull()
      expect(screen.getByRole('button', { name: '项目' })).toBeInTheDocument()
      await waitFor(() => expect(listConversationsMock).toHaveBeenCalled())
    },
  )
})
