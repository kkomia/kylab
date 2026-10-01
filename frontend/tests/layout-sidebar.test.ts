/**
 * 侧栏折叠的三档偏好与窄屏默认（D29，2026-09-28 走查）。
 *
 * 走查实测：420px 下侧栏 240px、内容区只剩 **180px**、每行 **4.53 个字**，输入框那一行
 * 还会溢出（发送键落到视口外）。折叠成图标栏（60px）之后内容区有 360px——那正是用户
 * 自己会去点的那一下，所以**窄屏且用户没表过态**时把它当默认。
 *
 * 为什么要有"没表过态"这一档：旧实现里"展开"就是**删键**，于是"用户说过要展开"与
 * "用户从没管过"是同一件事——那窄屏默认就没法只在后者上生效（用户点开侧栏之后
 * 会被下一次渲染收回去）。键变成 `'1'` / `'0'` / 不存在三档之后才分得开。
 *
 * ## 后半段：知识库组的三态（M3 阶段 6）
 *
 * 「知识库」整组**只在提供者 `ready` 时渲染**（方案 §3.3），而「概览」「任务中心」
 * 已从这一组搬进主导航（决策点 D1）。三态各有一条用例：
 * `ready` 在 / `unavailable` 不在 / 还没探过也不在（按缺席），加上"服务器档不管它"
 * ——那一档知识库就是它自己，这一组一直在。
 */

import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/conversations', () => ({
  listConversations: vi.fn(async () => ({ items: [] })),
  updateConversation: vi.fn(),
  deleteConversation: vi.fn(),
  getConversation: vi.fn(),
  createConversation: vi.fn(),
  rewindConversation: vi.fn(),
}))

vi.mock('@/api/workspaces', () => ({
  listWorkspaces: vi.fn(async () => ({ items: [] })),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  browseDirectories: vi.fn(),
  createDirectory: vi.fn(),
  renameDirectory: vi.fn(),
}))

import { resetProviderStore, setProviderStatusForTest, type ProviderStatus } from '@/api/provider'
import { toggleSidebarPreference } from '@/features/chat/runtime/shortcutPrefs'
import { SideNav } from '@/features/layout/SideNav'
import { useConversationStore } from '@/features/layout/conversations'
import {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  isSidebarCollapsed,
  toggleSidebar,
  useSidebarStore,
} from '@/features/layout/useSidebar'
import { useWorkspaceStore } from '@/features/layout/workspaces'
import { useSessionStore } from '@/lib/session'

/** 让 `matchMedia` 对这条 query 回一个固定答案（其余 query 一律 false）。 */
function stubViewport(narrow: boolean, query = '(max-width: 760px)'): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((q: string) => ({
      matches: q === query ? narrow : false,
      media: q,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}

beforeEach(() => {
  window.localStorage.clear()
  // 模块级单例：用例之间必须自己复位（键不存在 = 没表过态）
  useSidebarStore.setState({ collapsed: null })
})

describe('侧栏折叠：窄屏默认（D29）', () => {
  it('宽屏 + 没表过态 → 展开（旧行为一字不变）', () => {
    stubViewport(false)
    expect(isSidebarCollapsed()).toBe(false)
  })

  it('窄屏 + 没表过态 → **折叠**（420px 下内容区因此有 360px，而不是 180px）', () => {
    stubViewport(true)
    expect(isSidebarCollapsed()).toBe(true)
  })

  it('窄屏但用户明确展开过（`0`）→ 尊重用户，保持展开', () => {
    stubViewport(true)
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '0')
    useSidebarStore.setState({ collapsed: false })
    expect(isSidebarCollapsed()).toBe(false)
  })

  it('窄屏没表态时点一下开关 → 展开，并把 `0` **写下去**（删键会被下一次渲染收回去）', () => {
    stubViewport(true)
    toggleSidebar()
    expect(isSidebarCollapsed()).toBe(false)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('0')
  })

  it('快捷键那一路（Ctrl+B）用同一条口径：窄屏没表态时是"展开"', () => {
    stubViewport(true)
    expect(toggleSidebarPreference()).toBe(false)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('0')
  })

  it('快捷键：宽屏没表态时是"折叠"（与旧行为一致）', () => {
    stubViewport(false)
    expect(toggleSidebarPreference()).toBe(true)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('1')
  })
})

/* ------------------------------------------------------------ 知识库组的三态（M3 阶段 6） */

function providerStatus(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    state: 'ready',
    available: true,
    reason: '',
    checked_at: '2026-10-03T10:00:00Z',
    base_url: 'http://nas:8000/api/v1',
    credential: 'configured',
    ...overrides,
  }
}

/** 渲染一个真的侧栏（它要 Router 与 react-query：预热会话正文那一步用得上）。 */
function renderNav() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ['/notes'] },
        createElement(SideNav, { onOpenHistory: () => undefined }),
      ),
    ),
  )
}

describe('知识库组的三态（M3 阶段 6，决策点 D1 + D3）', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useSidebarStore.setState({ collapsed: false })
    useConversationStore.getState().reset()
    useWorkspaceStore.getState().reset()
    useSessionStore.setState({ currentUser: null, token: '', reloginCount: 0 })
    resetProviderStore()
    // 这一档是**本机档**（桌面壳），而网络那一层不参与：结论由用例直接摆
    //（`fetch` 挂一个永不回答的替身，免得那一次探测真打出去）
    vi.stubGlobal('__TAURI__', {
      core: { invoke: vi.fn(async () => ({ port: 8766, base: 'http://127.0.0.1:8766' })) },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    )
  })

  it('`ready`：组在，组里只剩「所有知识库」；概览与任务中心在主导航（D1）', async () => {
    const user = userEvent.setup()
    setProviderStatusForTest(providerStatus())

    renderNav()

    const group = await screen.findByRole('button', { name: '知识库' })
    await user.click(group)
    const nav = screen.getByRole('navigation', { name: '主导航' })
    // 组里那条唯一真属于知识库的入口
    expect(screen.getByRole('link', { name: '所有知识库' })).toBeInTheDocument()
    // 概览与任务中心**不在这组里**（原先整组隐藏会把它们一起带走：D1 的由来）
    expect(within(nav).getByRole('link', { name: '概览' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: '任务中心' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: '概览' })).toHaveAttribute('href', '/')
    expect(within(nav).getByRole('link', { name: '任务中心' })).toHaveAttribute('href', '/tasks')
  })

  it('`unavailable`：导航里**没有**「知识库」这一项（概览与任务中心照旧在）', async () => {
    setProviderStatusForTest(
      providerStatus({ state: 'unavailable', available: false, reason: '连不上这台 NAS' }),
    )

    renderNav()

    const nav = await screen.findByRole('navigation', { name: '主导航' })
    expect(within(nav).queryByText('知识库')).toBeNull()
    expect(within(nav).getByRole('link', { name: '概览' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '所有知识库' })).not.toBeInTheDocument()
  })

  it('`unconfigured`：同样不摆那一组（下一步是"去设置里填地址"，不是点进去）', async () => {
    setProviderStatusForTest(
      providerStatus({ state: 'unconfigured', available: false, reason: '还没接提供者' }),
    )

    renderNav()

    const nav = await screen.findByRole('navigation', { name: '主导航' })
    expect(within(nav).queryByText('知识库')).toBeNull()
  })

  it('**还没探过**：按缺席渲染（首屏不闪一个点进去报错的入口）', async () => {
    // 模块初始态就是"还没探过"：结论一个都没有
    renderNav()

    const nav = await screen.findByRole('navigation', { name: '主导航' })
    expect(within(nav).queryByText('知识库')).toBeNull()
  })

  it('服务器档（这一档没有 /local/provider）：这一组**一直在**（知识库就是它自己）', async () => {
    setProviderStatusForTest(null, { unsupported: true })

    renderNav()

    const nav = await screen.findByRole('navigation', { name: '主导航' })
    expect(within(nav).getByText('知识库')).toBeInTheDocument()
  })
})
