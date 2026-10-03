/**
 * 「备份」这一档的**门控**（M5 阶段 7）：路由守卫 + 侧栏那一组。
 *
 * ## 它钉的是什么（这一片最容易做错的一条）
 *
 * **判据是"本机档"（边车在），不是"备份提供者 ready"**：
 *
 * 1. 提供者 `unavailable` / `unconfigured` 时，`/backup` **照常进得去**，
 *    侧栏那一组**照常在**——那是"还有几份没备上去、为什么没成"的主场景；
 * 2. 不是本机档（服务器档 / 浏览器档）时：路由给一句说明（不是白屏、也不弹回对话页），
 *    侧栏与设置里那一节**根本没有入口**；
 * 3. **还没读到第一份结论**时先等一下（首屏那次读的窗口，不把深链接冤枉成"这一档没有"）。
 *
 * 网络一律替身：这些用例一条真请求都不发出去。
 */
import { createElement } from 'react'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  resetBackupStore,
  setBackupStatusForTest,
  type BackupBacklog,
  type LocalBackup,
} from '@/api/backup'
import { resetProviderStore } from '@/api/provider'
import { resetSidecarProbe } from '@/api/sidecar'
import { BackupRoute } from '@/features/backup/BackupRoute'
import { SideNav } from '@/features/layout/SideNav'
import { useConversationStore } from '@/features/layout/conversations'
import { useSidebarStore } from '@/features/layout/useSidebar'
import { useWorkspaceStore } from '@/features/layout/workspaces'

vi.mock('@/api/conversations', () => ({
  listConversations: vi.fn(async () => ({ items: [] })),
  getConversation: vi.fn(),
  updateConversation: vi.fn(),
  deleteConversation: vi.fn(),
  prefetchConversationDetail: vi.fn(),
}))

vi.mock('@/api/workspaces', () => ({
  listWorkspaces: vi.fn(async () => ({ items: [] })),
  listArchivedWorkspaces: vi.fn(async () => ({ items: [] })),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  archiveWorkspace: vi.fn(),
  restoreWorkspace: vi.fn(),
}))

function backlog(overrides: Partial<BackupBacklog> = {}): BackupBacklog {
  return {
    queued: 0,
    bytes: 0,
    failed: 0,
    discarded: 0,
    oldest_created_at: null,
    last_error: '',
    ...overrides,
  }
}

function payload(overrides: Partial<LocalBackup> = {}): LocalBackup {
  return {
    provider: {
      state: 'unavailable',
      available: false,
      reason: '连不上那台 NAS',
      checked_at: '2026-10-05T10:00:00Z',
      base_url: '',
      credential: 'missing',
      snapshot_available: false,
      snapshot_reason: '',
      enabled: true,
      include_workspace: false,
      every_hours: 24,
    },
    backlog: backlog({ queued: 2 }),
    snapshots: [],
    ...overrides,
  }
}

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={['/backup']}>
      <Routes>
        <Route
          path="/backup"
          element={
            <BackupRoute>
              <div>备份页的内容</div>
            </BackupRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  resetSidecarProbe()
  resetBackupStore()
  resetProviderStore()
  window.localStorage.clear()
  useSidebarStore.setState({ collapsed: false })
  useConversationStore.getState().reset()
  useWorkspaceStore.getState().reset()
  // 本机档：桌面壳在（`inDesktopShell()` 为真）——门控的第一条判据
  vi.stubGlobal('__TAURI__', {
    core: { invoke: vi.fn(async () => ({ port: 8766, base: 'http://127.0.0.1:8766' })) },
  })
  // 网络那一层不参与：状态由用例直接摆；`fetch` 挂一个永不回答的替身兜底
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetSidecarProbe()
  resetBackupStore()
  resetProviderStore()
})

describe('① 路由守卫：提供者不可用也进得去', () => {
  it('本机档 + 提供者连不上 + 队列里有没传上去的 → **放行**（那正是要看队列的时候）', async () => {
    setBackupStatusForTest(payload())

    renderRoute()

    expect(await screen.findByText('备份页的内容')).toBeInTheDocument()
  })

  it('本机档 + 还没配置 → 同样放行（能进去看"要不要填地址"）', async () => {
    setBackupStatusForTest(
      payload({
        provider: {
          state: 'unconfigured',
          available: false,
          reason: '还没填地址',
          checked_at: null,
          base_url: '',
          credential: 'missing',
          snapshot_available: false,
          snapshot_reason: '',
          enabled: true,
          include_workspace: false,
          every_hours: 24,
        },
      }),
    )

    renderRoute()

    expect(await screen.findByText('备份页的内容')).toBeInTheDocument()
  })

  it('还没读到第一份结论 → 先等一下（不把一条正常深链接弹回去）', async () => {
    renderRoute()

    expect(await screen.findByText('备份')).toBeInTheDocument()
    expect(screen.queryByText('备份页的内容')).toBeNull()
  })

  it('不是本机档（服务器档 / 浏览器档）→ 一句说明顶上，不渲染页面、也不跳走', async () => {
    setBackupStatusForTest(null, { unsupported: true })

    renderRoute()

    expect(await screen.findByText(/「备份」只有本机档（桌面壳）才有/)).toBeInTheDocument()
    expect(screen.queryByText('备份页的内容')).toBeNull()
  })
})

/*
  R5：侧栏那一组「备份」**整组删掉了**（用户拍板）——入口搬进「设置 → 备份」那一节
  尾部那颗去 `/backup` 的按钮（用例在 `misc-settings.test.tsx`，那里也钉了"跳之前先关
  设置"）。所以这一节不再有"组在不在 / 组头亮不亮"的用例，只留一条**反向**的：
  侧栏里不该再出现「备份」这一项——本机档也一样。
*/
describe('② 侧栏不再有「备份」这一项（R5：入口搬进设置）', () => {
  /** 侧栏要 QueryClient（悬停预取会话正文那一条用它）。 */
  function renderNav(route = '/notes'): void {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          {createElement(SideNav, { onOpenHistory: () => undefined })}
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('本机档：侧栏里没有「备份」组、也没有「备份与恢复」那条链接', async () => {
    setBackupStatusForTest(payload())

    renderNav()

    // 先等侧栏立起来（导航区在），再断言"没有"——否则可能只是还没渲染完
    await screen.findByRole('navigation', { name: '主导航' })
    expect(screen.queryByTestId('nav-backup-group')).toBeNull()
    expect(screen.queryByRole('button', { name: '备份' })).toBeNull()
    expect(screen.queryByRole('link', { name: '备份与恢复' })).toBeNull()
  })
})
