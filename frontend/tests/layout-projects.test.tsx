/**
 * 侧栏「项目」节那颗「新增项目」的用例（对应 `features/layout/SideNav.tsx` 的项目节与
 * 恢复出来的 `features/misc/workspaces/WorkspaceCreateDialog.tsx`）。
 *
 * 用户原话："新增项目 没有按钮可以新增了 ，应该放在 项目菜单那个菜单得右边"。
 * 这里钉住的就是这句话的三半：
 *
 * 1. 那颗按钮**在「项目」标题右边**，长相与「对话」那节的「查看全部会话」**逐字一致**
 *    （同一份类名常量，不是抄了一份样式），且**可 Tab 到**——
 *    《前端设计规范》§8 禁止"只有 hover 才够得着"的关键操作，而它是整栏唯一的建项目入口；
 * 2. 点它打开新建弹窗，提交真的调 `createWorkspace`（后端 `POST /workspaces`）；
 * 3. 建完侧栏**立刻**出现这个项目——走 `useWorkspaceStore.load()`，
 *    不是另发明一条刷新路径（`ensureWorkspacesLoaded` 那份缓存不主动拉就停在旧清单上）。
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/workspaces', () => ({
  listWorkspaces: vi.fn(async () => ({ items: [] })),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  browseDirectories: vi.fn(),
  createDirectory: vi.fn(),
  renameDirectory: vi.fn(),
}))

vi.mock('@/api/conversations', () => ({
  listConversations: vi.fn(async () => ({ items: [] })),
  updateConversation: vi.fn(),
  deleteConversation: vi.fn(async () => undefined),
  getConversation: vi.fn(),
  createConversation: vi.fn(),
  rewindConversation: vi.fn(),
}))

vi.mock('@/api/users', () => ({
  listUsers: vi.fn(async () => ({ items: [], header: 'X-Kylab-Operator' })),
}))

vi.mock('@/api/auth', () => ({
  logout: vi.fn(async () => undefined),
  getAuthBootstrapStatus: vi.fn(async () => ({ needs_setup: false, auth_enabled: true })),
  me: vi.fn(async () => null),
  changePassword: vi.fn(),
  uploadAvatar: vi.fn(),
  clearAvatar: vi.fn(),
  MIN_PASSWORD_CHARS: 8,
}))

vi.mock('@/features/misc/settings/SettingsModal', () => ({ SettingsModal: () => null }))
vi.mock('@/features/misc/settings/AvatarDialog', () => ({ AvatarDialog: () => null }))

import { listConversations } from '@/api/conversations'
import { createWorkspace, listWorkspaces, type Workspace } from '@/api/workspaces'
import { AppShell } from '@/features/layout/AppShell'
import { useConversationStore } from '@/features/layout/conversations'
import { useWorkspaceStore } from '@/features/layout/workspaces'
import { useSidebarStore } from '@/features/layout/useSidebar'
import { resetAllShortcuts } from '@/features/misc/settings/useShortcuts'
import type { Account } from '@/api/auth'
import { useSessionStore } from '@/lib/session'

const listWorkspacesMock = vi.mocked(listWorkspaces)
const createWorkspaceMock = vi.mocked(createWorkspace)
const listConversationsMock = vi.mocked(listConversations)

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'w1',
    name: '合同整理',
    root_path: 'E:/work/contracts',
    description: '',
    kb_ids: [],
    conversation_count: 0,
    created_at: null,
    updated_at: null,
    ...overrides,
  }
}

function account(role: 'admin' | 'member' = 'admin'): Account {
  return { id: 'u1', username: 'you', name: '小又', role, avatar_url: '' }
}

function renderShell(initialPath = '/notes') {
  // 侧栏里有"划过就预取会话正文"（`prefetchConversationDetail`），它要一个 QueryClient
  // ——真实应用里由 `App` 提供，夹具里补一个（retry 关掉，失败即时可见）
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/notes" element={<div>笔记页</div>} />
            <Route path="/chat/:conversationId?" element={<div>对话页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listConversationsMock.mockResolvedValue({ items: [] })
  listWorkspacesMock.mockResolvedValue({ items: [] })
  useConversationStore.getState().reset()
  useWorkspaceStore.getState().reset()
  useSidebarStore.setState({ collapsed: false })
  useSessionStore.setState({ currentUser: account(), token: '', reloginCount: 0 })
  resetAllShortcuts()
})

describe('侧栏的「新增项目」', () => {
  it('在「项目」标题右边，与「查看全部会话」同一份长相，且可 Tab 到', async () => {
    renderShell()

    const addButton = await screen.findByRole('button', { name: '新增项目' })
    const historyButton = screen.getByRole('button', { name: '查看全部会话' })

    // 长相**逐字一致**：两颗都取 `SIDE_ADD` 那一份常量。抄一份样式的话，
    // 下一次改其中一颗的悬停/尺寸这里就会分叉（这条断言正是为了不让它分叉）
    expect(addButton.className).toBe(historyButton.className)
    // 位置：与「项目」标题同一个 `.ly-side-head`，紧跟在标题按钮之后（`ml-auto` 顶到右边）
    expect(addButton.previousElementSibling).toBe(screen.getByRole('button', { name: '项目' }))

    // 可 Tab 到（§8）：不是 `tabindex="-1"`、也没被 disabled 挡在键盘之外
    expect(addButton.tabIndex).toBe(0)
    addButton.focus()
    expect(addButton).toHaveFocus()
  })

  it('点开弹窗、提交调建项目接口，建完侧栏立刻出现这个项目', async () => {
    const user = userEvent.setup()
    renderShell()
    await waitFor(() => expect(listWorkspacesMock).toHaveBeenCalledTimes(1))

    const created = workspace({ id: 'w9', name: '新项目', root_path: '/srv/new' })
    createWorkspaceMock.mockResolvedValue(created)
    // 下一次拉清单（建完那次刷新）就带上它了——这就是"后端已经建好了"
    listWorkspacesMock.mockResolvedValue({ items: [created] })

    await user.click(await screen.findByRole('button', { name: '新增项目' }))
    const dialog = await screen.findByRole('dialog', { name: '新建项目' })

    // 两格没填齐时「创建项目」是灰的：点了也不该发请求（后端那段路径校验留给填完的人）
    await user.click(within(dialog).getByRole('button', { name: '创建项目' }))
    expect(createWorkspaceMock).not.toHaveBeenCalled()

    await user.type(within(dialog).getByLabelText('名字'), '新项目')
    await user.type(within(dialog).getByLabelText('根目录'), '/srv/new')
    await user.click(within(dialog).getByRole('button', { name: '创建项目' }))

    await waitFor(() =>
      expect(createWorkspaceMock).toHaveBeenCalledWith({
        name: '新项目',
        root_path: '/srv/new',
        description: '',
      }),
    )

    // 列表刷新：第二趟 `listWorkspaces` 是 `useWorkspaceStore.load()` 发的
    await waitFor(() => expect(listWorkspacesMock.mock.calls.length).toBeGreaterThan(1))
    expect(screen.queryByRole('dialog', { name: '新建项目' })).not.toBeInTheDocument()

    // 新项目**在侧栏的项目节里**（是那条项目行，不是随便一处文字）
    const sidebar = screen.getByRole('complementary', { name: '侧栏' })
    const row = await within(sidebar).findByRole('button', { name: /^新项目/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
  })
})
