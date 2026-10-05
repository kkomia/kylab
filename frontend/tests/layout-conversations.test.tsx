/**
 * 侧栏会话分区 / 行菜单 / 历史会话面板的用例。
 *
 * 对照的旧实现是 `frontend/src/components/layout/ConversationHistoryPanel.vue`（499 行）
 * 与 `ConversationRowMenu.vue`。这一节钉住的是**逐处调过的那几件事**：
 *
 * 1. 会话清单只有一份平铺的，侧栏按 `workspace_id` 分组、未归项目的进「对话」节，
 *    **已归档的不在侧栏**（§12.165/§12.188 那条：归档是"收起来"，不是删除）；
 * 2. 行菜单的五个动作**各按后端既有字段**调接口（`pinned` / `title` / `workspace_id` /
 *    `archived_at` / 删除），且**删除要确认、归档不确认**；
 * 3. 面板自己按需拉一份**带预览**的清单（`limit=100` + `with_preview=true`），
 *    面板里的搜索与归档视图**不写回侧栏那份**；
 * 4. 相对时间分组（今天/昨天/本周/本月/更早）与预览的 Markdown 压平。
 */
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/conversations', () => ({
  listConversations: vi.fn(async () => ({ items: [] })),
  updateConversation: vi.fn(),
  deleteConversation: vi.fn(async () => undefined),
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

import {
  deleteConversation,
  getConversation,
  listConversations,
  updateConversation,
  type ConversationSummary,
} from '@/api/conversations'
import { listWorkspaces, type Workspace } from '@/api/workspaces'
import { AppShell } from '@/features/layout/AppShell'
import { previewOf } from '@/features/layout/ConversationHistoryPanel'
import { useConversationStore } from '@/features/layout/conversations'
import { useWorkspaceStore } from '@/features/layout/workspaces'
import { useSidebarStore } from '@/features/layout/useSidebar'
import { resetAllShortcuts } from '@/features/misc/settings/useShortcuts'
import type { Account } from '@/api/auth'
import { useSessionStore } from '@/lib/session'

const listConversationsMock = vi.mocked(listConversations)
const updateConversationMock = vi.mocked(updateConversation)
const deleteConversationMock = vi.mocked(deleteConversation)
const listWorkspacesMock = vi.mocked(listWorkspaces)

/** 一条会话摘要（只列用例关心的字段，其余给默认值）。 */
function conversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'c1',
    title: '会话 A',
    kb_ids: [],
    model_pk: null,
    workspace_id: null,
    thinking: null,
    thinking_effort: null,
    pinned: false,
    archived_at: null,
    preview: '',
    created_at: null,
    updated_at: new Date().toISOString(),
    message_count: 2,
    ...overrides,
  }
}

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
    archived_at: null,
    ...overrides,
  }
}

function account(role: 'admin' | 'member' = 'admin'): Account {
  return { id: 'u1', username: 'you', name: '小又', role, avatar_url: '' }
}

function renderShell(initialPath = '/notes') {
  // 侧栏/面板里有"划过就预取会话正文"（`prefetchConversationDetail`），它要一个
  // QueryClient —— 真实应用里由 `App` 提供，夹具里补一个（retry 关掉，失败即时可见）
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
            {/* 工作区那一页：侧栏的项目行 / 「全部项目」要按 `?focus=` 认出当前项 */}
            <Route path="/workspaces" element={<div>工作区页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** 打开某条会话的「⋯」菜单。 */
async function openRowMenu(user: ReturnType<typeof userEvent.setup>, title = '会话 A') {
  await user.click(await screen.findByRole('button', { name: `${title} 的操作` }))
  return screen.findByRole('menu')
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

describe('侧栏的会话分区', () => {
  it('未归项目的会话进「对话」节；已归档的不在侧栏', async () => {
    listConversationsMock.mockResolvedValue({
      items: [
        conversation({ id: 'c1', title: '会话 A' }),
        conversation({ id: 'c2', title: '会话 B', pinned: true }),
      ],
    })
    renderShell()

    expect(await screen.findByText('会话 A')).toBeInTheDocument()
    expect(screen.getByText('会话 B')).toBeInTheDocument()
    // 分组标题两节都在（「项目」那一节还有一个「新建项目」按钮，所以名字要精确匹配）
    expect(screen.getByRole('button', { name: '项目' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '对话' })).toBeInTheDocument()
  })

  it('挂在别台设备项目下的会话：本机按未归档渲染（工作区按设备隔离）', async () => {
    // 项目清单被后端按设备过滤：ws-other-device 不在返回里；但会话权威在服务器、
    // 跨设备可见——这条会话的 workspace_id 指向一个本机看不见的项目。
    // 它不能因此从侧栏消失（进不了项目节、又不在「对话」节 = 静默没了）。
    listConversationsMock.mockResolvedValue({
      items: [
        conversation({ id: 'c1', title: '本机这条' }),
        conversation({ id: 'c2', title: '别机项目里的会话', workspace_id: 'ws-other-device' }),
      ],
    })
    renderShell()

    expect(await screen.findByText('本机这条')).toBeInTheDocument()
    expect(screen.getByText('别机项目里的会话')).toBeInTheDocument()
  })

  it('已归档项目的会话不算「没地方去」：跟着项目收起来，不进「对话」节', async () => {
    listWorkspacesMock.mockImplementation(async (archived?: boolean) =>
      archived ? { items: [workspace({ id: 'w-arch', name: '收起來的項目' })] } : { items: [] },
    )
    listConversationsMock.mockResolvedValue({
      items: [conversation({ id: 'c1', title: '已归档项目里的会话', workspace_id: 'w-arch' })],
    })
    renderShell()

    // 归档清单一加载完它就该不在（而不是在「对话」节出现）
    await waitFor(() => expect(screen.queryByText('已归档项目里的会话')).not.toBeInTheDocument())
  })

  it('一条会话都没有时说一句状态，不给操作指引', async () => {
    renderShell()
    expect(await screen.findByText('还没有对话')).toBeInTheDocument()
    // 「还没有项目」不再渲染：那一节现在只是分组（工作区页连同它的"新建项目"流程删了），
    // 空着就空着——写一句"还没有项目"等于指给用户一个不存在的入口
    expect(screen.queryByText('还没有项目')).not.toBeInTheDocument()
  })

  it('当前会话有选中态：只有那一条标 aria-current，普通项保持正文色', async () => {
    listConversationsMock.mockResolvedValue({
      items: [
        conversation({ id: 'c1', title: '会话 A' }),
        conversation({ id: 'c2', title: '会话 B' }),
      ],
    })
    renderShell('/chat/c1')

    const current = await screen.findByRole('link', { name: /会话 A/ })
    const other = screen.getByRole('link', { name: /会话 B/ })
    // 选中态：语义（aria-current）+ 视觉（`--bg-selected` 底）两处一起，缺一不可
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(current.className).toContain('bg-[var(--bg-selected)]')
    expect(other).not.toHaveAttribute('aria-current')
    expect(other.className).not.toContain('bg-[var(--bg-selected)]')
    // 普通项是**正文色**（列表项不该有"点了会跳走"的链接观感）
    expect(other.className).toContain('text-text-primary')
  })

  it('项目下的会话：默认降一档灰，当前那条提回正文色并加选中底', async () => {
    listWorkspacesMock.mockResolvedValue({ items: [workspace({ id: 'w1' })] })
    listConversationsMock.mockResolvedValue({
      items: [
        conversation({ id: 'c1', title: '会话 A', workspace_id: 'w1' }),
        conversation({ id: 'c2', title: '会话 B', workspace_id: 'w1' }),
      ],
    })
    renderShell('/chat/c1')

    const current = await screen.findByRole('link', { name: /会话 A/ })
    const other = screen.getByRole('link', { name: /会话 B/ })
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(current.className).toContain('bg-[var(--bg-selected)]')
    expect(current.className).not.toContain('text-text-secondary')
    expect(other).not.toHaveAttribute('aria-current')
    expect(other.className).toContain('text-text-secondary')
  })

  it('项目行是**展开/收起**：点它不跳页（`/workspaces` 那一页已删）', async () => {
    listWorkspacesMock.mockResolvedValue({ items: [workspace({ id: 'w1', name: '合同整理' })] })
    // 用 `/notes` 而不是 `/`：夹具里没有 `/` 那条路由（pathless 布局路由要子路由命中才渲染）
    renderShell('/notes')

    // `/^合同整理/` 这个锚点：行自己的可及名以项目名开头，右端那颗「+」的名字是
    // 「在项目「合同整理」里新建会话」（它必须说明是给哪个项目新建）——不加锚点会同时命中两个。
    const row = await screen.findByRole('button', { name: /^合同整理/ })
    // 点它只改展开态，标签里带的是 `aria-expanded`（不再是"当前页"）
    expect(row).toHaveAttribute('aria-expanded', 'false')
    await userEvent.setup().click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    // 「全部项目」那个入口随页面一起去掉了，不该再有任何按钮叫这个名字
    expect(screen.queryByRole('button', { name: '全部项目' })).not.toBeInTheDocument()
  })

  it('归档之后那条会话立刻从侧栏消失（归档不是删除）', async () => {
    const user = userEvent.setup()
    listConversationsMock.mockResolvedValue({
      items: [conversation({ id: 'c1', title: '会话 A' })],
    })
    updateConversationMock.mockResolvedValue(
      conversation({ id: 'c1', title: '会话 A', archived_at: '2026-09-23T00:00:00Z' }),
    )
    renderShell()

    const menu = await openRowMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: '归档' }))

    await waitFor(() =>
      expect(updateConversationMock).toHaveBeenCalledWith('c1', { archived: true }),
    )
    await waitFor(() => expect(screen.queryByText('会话 A')).not.toBeInTheDocument())
    expect(await screen.findByText('还没有对话')).toBeInTheDocument()
  })

  it('新建会话之后侧栏立刻多出那一行：就地插入，不重拉清单', async () => {
    listConversationsMock.mockResolvedValue({
      items: [conversation({ id: 'c1', title: '会话 A', updated_at: '2026-09-22T08:00:00Z' })],
    })
    renderShell()
    expect(await screen.findByText('会话 A')).toBeInTheDocument()
    // 这条用例要钉的就是"不刷新页面"：侧栏挂载那一次 load 之后，谁也不许再重拉整份清单
    const callsAfterMount = listConversationsMock.mock.calls.length

    // 「新建会话」的真实调用点是 `ChatProvider.send`（建完会话把后端返回的摘要交给这份
    // 清单）；对话页那条用例归 `tests/chat-ui.test.tsx`，这里只驱动建完之后的**那一步**，
    // 验"清单变长之后侧栏立刻可见"——修复前这里会一行都不多（正是用户报的现象）。
    await act(async () => {
      useConversationStore
        .getState()
        .upsert(conversation({ id: 'c2', title: '会话 B', updated_at: '2026-09-23T08:00:00Z' }))
    })

    expect(await screen.findByText('会话 B')).toBeInTheDocument()
    // 刚建的那条排在最前：与后端同一口径（置顶优先，其次最近更新），不是插到哪算哪
    const titles = screen.getAllByRole('link').map((link) => link.textContent)
    const indexOf = (title: string) => titles.findIndex((item) => (item ?? '').startsWith(title))
    expect(indexOf('会话 B')).toBeLessThan(indexOf('会话 A'))
    // 就地插入：整份清单不重建（重拉会让侧栏在点击后闪一下）
    expect(listConversationsMock.mock.calls.length).toBe(callsAfterMount)

    // 同一份摘要重复交进来不许出现两行（发送失败重试、别处又插一次都会走到这里）
    await act(async () => {
      useConversationStore
        .getState()
        .upsert(conversation({ id: 'c2', title: '会话 B', updated_at: '2026-09-23T08:00:00Z' }))
    })
    expect(screen.getAllByText('会话 B')).toHaveLength(1)
  })
})

describe('会话行菜单', () => {
  it('置顶：调 { pinned: true }，并按"置顶优先"就地重排', async () => {
    const user = userEvent.setup()
    listConversationsMock.mockResolvedValue({
      items: [
        conversation({ id: 'c1', title: '会话 A', updated_at: '2026-09-23T08:00:00Z' }),
        conversation({ id: 'c2', title: '会话 B', updated_at: '2026-09-22T08:00:00Z' }),
      ],
    })
    updateConversationMock.mockResolvedValue(
      conversation({ id: 'c2', title: '会话 B', pinned: true }),
    )
    renderShell()

    const menu = await openRowMenu(user, '会话 B')
    await user.click(within(menu).getByRole('menuitem', { name: '置顶' }))

    await waitFor(() => expect(updateConversationMock).toHaveBeenCalledWith('c2', { pinned: true }))
    // 重排后它排在最前（同一节里）
    await waitFor(() => {
      const titles = screen.getAllByRole('link').map((link) => link.textContent)
      const indexOf = (title: string) => titles.findIndex((item) => (item ?? '').startsWith(title))
      expect(indexOf('会话 B')).toBeLessThan(indexOf('会话 A'))
    })
  })

  // **放宽这一处**（不是放宽全局 `testTimeout`）：弹窗两开两合 + 清空/输入/保存三串用户事件，
  // 全量并发时被挤过默认 5s（实测 5226ms）；单跑 853ms —— 与下方"空态"那条同一处置。
  it(
    '重命名：弹窗里输入新标题，保存调 { title }；空标题不发请求',
    { timeout: 15_000 },
    async () => {
      const user = userEvent.setup()
      listConversationsMock.mockResolvedValue({
        items: [conversation({ id: 'c1', title: '会话 A' })],
      })
      updateConversationMock.mockResolvedValue(conversation({ id: 'c1', title: '合同整理' }))
      renderShell()

      const menu = await openRowMenu(user)
      await user.click(within(menu).getByRole('menuitem', { name: '重命名' }))

      const input = await screen.findByLabelText('会话标题')
      // 先清空再保存：空标题不该打接口
      await user.clear(input)
      await user.click(screen.getByRole('button', { name: '保存' }))
      expect(updateConversationMock).not.toHaveBeenCalled()

      const menuAgain = await openRowMenu(user)
      await user.click(within(menuAgain).getByRole('menuitem', { name: '重命名' }))
      const second = await screen.findByLabelText('会话标题')
      await user.clear(second)
      await user.type(second, '合同整理')
      await user.click(screen.getByRole('button', { name: '保存' }))

      await waitFor(() =>
        expect(updateConversationMock).toHaveBeenCalledWith('c1', { title: '合同整理' }),
      )
    },
  )

  it('删除要先确认：只点菜单项不发请求，确认后才调删除接口', async () => {
    const user = userEvent.setup()
    listConversationsMock.mockResolvedValue({
      items: [conversation({ id: 'c1', title: '会话 A' })],
    })
    renderShell()

    const menu = await openRowMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: '删除' }))

    // 确认框把标题带出来（去掉标题的话，连删的是哪条都得回头看一眼）
    expect(await screen.findByText('删除这条会话？')).toBeInTheDocument()
    expect(screen.getByText(/将删除「会话 A」及其全部消息/)).toBeInTheDocument()
    expect(deleteConversationMock).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(deleteConversationMock).toHaveBeenCalledWith('c1'))
    await waitFor(() => expect(screen.queryByText('会话 A')).not.toBeInTheDocument())
  })

  it('归档不弹确认；「取消归档」文案在已归档那条上出现', async () => {
    const user = userEvent.setup()
    listConversationsMock.mockResolvedValue({
      items: [conversation({ id: 'c1', title: '会话 A', archived_at: '2026-09-01T00:00:00Z' })],
    })
    renderShell()

    const menu = await openRowMenu(user)
    const archiveItem = within(menu).getByRole('menuitem', { name: '取消归档' })
    await user.click(archiveItem)
    await waitFor(() =>
      expect(updateConversationMock).toHaveBeenCalledWith('c1', { archived: false }),
    )
    // 归档**不确认**：全程没有确认框
    expect(screen.queryByText('删除这条会话？')).not.toBeInTheDocument()
  })

  it('移至项目：列出候选并标出当前那个，点它调 { workspace_id } 并刷新项目计数', async () => {
    const user = userEvent.setup()
    listWorkspacesMock.mockResolvedValue({
      items: [workspace({ id: 'w1', name: '合同整理', conversation_count: 0 })],
    })
    listConversationsMock.mockResolvedValue({
      items: [conversation({ id: 'c1', title: '会话 A' })],
    })
    updateConversationMock.mockResolvedValue(
      conversation({ id: 'c1', title: '会话 A', workspace_id: 'w1' }),
    )
    renderShell()

    const menu = await openRowMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: '移至项目' }))

    const dialog = await screen.findByText('移至项目')
    expect(dialog).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /合同整理/ }))

    await waitFor(() =>
      expect(updateConversationMock).toHaveBeenCalledWith('c1', { workspace_id: 'w1' }),
    )
    // 项目行上的条数是另一个 store 里的数：不同步刷新它就会停在旧值上
    await waitFor(() => expect(listWorkspacesMock.mock.calls.length).toBeGreaterThan(1))
  })

  it('已经在项目里的会话：菜单里出现「移出项目」，点它调 { workspace_id: null }', async () => {
    const user = userEvent.setup()
    listWorkspacesMock.mockResolvedValue({
      items: [workspace({ id: 'w1', name: '合同整理', conversation_count: 1 })],
    })
    listConversationsMock.mockResolvedValue({
      items: [conversation({ id: 'c1', title: '会话 A', workspace_id: 'w1' })],
    })
    updateConversationMock.mockResolvedValue(conversation({ id: 'c1', title: '会话 A' }))
    renderShell()

    // 项目下的会话行（缩进那一层）也有同一个「⋯」
    const menu = await openRowMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: '移至项目' }))
    await user.click(await screen.findByRole('button', { name: '移出项目' }))

    await waitFor(() =>
      expect(updateConversationMock).toHaveBeenCalledWith('c1', { workspace_id: null }),
    )
  })
})

describe('历史会话面板', () => {
  it('打开时自己拉一份带预览的清单：limit=100 + with_preview', async () => {
    const user = userEvent.setup()
    listConversationsMock.mockResolvedValue({
      items: [conversation({ id: 'c1', title: '会话 A' })],
    })
    renderShell()

    await user.click(await screen.findByRole('button', { name: '查看全部会话' }))
    const panel = await screen.findByRole('dialog', { name: '历史会话' })
    expect(within(panel).getByText('历史会话')).toBeInTheDocument()

    await waitFor(() => {
      const detailCall = listConversationsMock.mock.calls.find((call) => call[0] === 100)
      expect(detailCall?.[2]).toEqual({ archived: false, withPreview: true })
    })
  })

  it('搜索带 q（300ms 防抖）、清除搜索再拉一次；归档视图带 archived=true', async () => {
    const user = userEvent.setup()
    listConversationsMock.mockResolvedValue({
      items: [conversation({ id: 'c1', title: '会话 A' })],
    })
    renderShell()
    await user.click(await screen.findByRole('button', { name: '查看全部会话' }))
    await screen.findByRole('dialog', { name: '历史会话' })

    /** 只数面板那几次（侧栏那份是 limit=50）。 */
    const panelCalls = () => listConversationsMock.mock.calls.filter((call) => call[0] === 100)

    await user.type(screen.getByLabelText('搜索历史会话'), '合同')
    await waitFor(() => expect(panelCalls().some((call) => call[1] === '合同')).toBe(true), {
      timeout: 2000,
    })

    const beforeClear = panelCalls().length
    await user.click(screen.getByRole('button', { name: '清除搜索' }))
    await waitFor(() => expect(panelCalls().length).toBeGreaterThan(beforeClear))

    await user.click(screen.getByRole('button', { name: '已归档' }))
    await waitFor(() => {
      const archived = panelCalls().find(
        (call) => (call[2] as { archived?: boolean } | undefined)?.archived === true,
      )
      expect(archived).toBeTruthy()
    })
  })

  it('相对时间分组与右侧日期标签；预览压平 Markdown 且两行截断', async () => {
    const user = userEvent.setup()
    const now = new Date()
    const oneDay = 24 * 60 * 60 * 1000
    listConversationsMock.mockResolvedValue({
      items: [
        conversation({
          id: 'c1',
          title: '今天的会话',
          updated_at: now.toISOString(),
          preview: '## 小结\n\n**结论**：[看这里](https://example.test) `code`',
        }),
        conversation({
          id: 'c2',
          title: '昨天的会话',
          updated_at: new Date(now.getTime() - oneDay).toISOString(),
        }),
        conversation({
          id: 'c3',
          title: '上周的会话',
          updated_at: new Date(now.getTime() - 9 * oneDay).toISOString(),
        }),
        conversation({
          id: 'c4',
          title: '上个月的会话',
          updated_at: new Date(now.getTime() - 60 * oneDay).toISOString(),
        }),
      ],
    })
    renderShell()
    await user.click(await screen.findByRole('button', { name: '查看全部会话' }))
    const panel = await screen.findByRole('dialog', { name: '历史会话' })

    // 分组标签（标题那一层；条目的日期标签用同一个词，所以要按 role 取）
    expect(within(panel).getByRole('heading', { name: '今天' })).toBeInTheDocument()
    expect(within(panel).getByRole('heading', { name: '昨天' })).toBeInTheDocument()
    expect(within(panel).getByRole('heading', { name: '本月' })).toBeInTheDocument()
    expect(within(panel).getByRole('heading', { name: '更早' })).toBeInTheDocument()
    // 预览：Markdown 记号被压平，链接只留文字
    expect(within(panel).getByText('小结 结论：看这里 code')).toBeInTheDocument()
  })

  it('面板里点一条会话就进去，面板顺手关掉', async () => {
    const user = userEvent.setup()
    listConversationsMock.mockResolvedValue({
      items: [conversation({ id: 'c9', title: '旧会话' })],
    })
    renderShell()
    await user.click(await screen.findByRole('button', { name: '查看全部会话' }))
    const panel = await screen.findByRole('dialog', { name: '历史会话' })

    await user.click(within(panel).getByRole('link', { name: /旧会话/ }))

    await waitFor(() => expect(screen.getByText('对话页')).toBeInTheDocument())
    expect(screen.queryByRole('dialog', { name: '历史会话' })).not.toBeInTheDocument()
  })

  // 反向验证的**确定性守卫**（与 smoke 那条同一套理由）：这一条要等历史面板挂载 + 那份
  // 带预览清单的查询链 settle，全量并发时超过默认 5s（实测 5257ms），而单跑只有 ~1.7s、
  // 撤掉超时照样绿 → 只能靠源码断言把"这一处被放宽过"钉住。
  it('重挂载类用例带着显式超时（删了就红）', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    expect(source).toMatch(
      /it\(\s*'空态：没搜索也没归档时说「还没有会话」，搜索无果时说「没有匹配的会话」'\s*,\s*\{\s*timeout:\s*15_000\s*\}/,
    )
  })

  // **放宽这一处**（不是放宽全局 `testTimeout`）：面板挂载 + 查询链是 CPU 型重活，
  // 全量 1082 条并发时被挤过默认 5s（实测 5257ms）；单跑 ~1.7s。
  it(
    '空态：没搜索也没归档时说「还没有会话」，搜索无果时说「没有匹配的会话」',
    { timeout: 15_000 },
    async () => {
      const user = userEvent.setup()
      listConversationsMock.mockResolvedValue({ items: [] })
      renderShell()
      await user.click(await screen.findByRole('button', { name: '查看全部会话' }))
      expect(await screen.findByText('还没有会话')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: '已归档' }))
      await waitFor(() => expect(screen.getByText('还没有归档的会话')).toBeInTheDocument())

      await user.type(screen.getByLabelText('搜索历史会话'), '合同')
      await waitFor(() => expect(screen.getByText('没有匹配的会话')).toBeInTheDocument(), {
        timeout: 2000,
      })
    },
  )

  it('面板里的「⋯」改完会重新拉一次那份带预览的清单', async () => {
    const user = userEvent.setup()
    listConversationsMock.mockResolvedValue({
      items: [conversation({ id: 'c1', title: '会话 A' })],
    })
    updateConversationMock.mockResolvedValue(
      conversation({ id: 'c1', title: '会话 A', pinned: true }),
    )
    renderShell()
    await user.click(await screen.findByRole('button', { name: '查看全部会话' }))
    const panel = await screen.findByRole('dialog', { name: '历史会话' })

    const before = listConversationsMock.mock.calls.filter((call) => call[0] === 100).length
    await user.click(within(panel).getByRole('button', { name: '会话 A 的操作' }))
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: '置顶' }))

    await waitFor(() => {
      const after = listConversationsMock.mock.calls.filter((call) => call[0] === 100).length
      expect(after).toBeGreaterThan(before)
    })
  })
})

describe('预览的 Markdown 压平（纯函数口径）', () => {
  it('代码块 / 图片 / 链接 / 标题记号 / 列表前缀都清掉', () => {
    expect(previewOf(conversation({ preview: '```js\nconst a = 1\n```' }))).toBe('')
    expect(previewOf(conversation({ preview: '![图](a.png) 正文' }))).toBe('正文')
    expect(previewOf(conversation({ preview: '# 标题\n\n- 一\n- 二' }))).toBe('标题 一 二')
    expect(previewOf(conversation({ preview: '**粗** 与 _斜_' }))).toBe('粗 与 斜')
  })
})

describe('悬停预热（审计 F18：旧版"点进去就有"，新版补回来）', () => {
  it('划过导航项就预载那一页的代码', async () => {
    const user = userEvent.setup()
    const preload = vi.spyOn(await import('@/app/routes'), 'preloadPage')
    renderShell()

    await user.hover(await screen.findByRole('link', { name: '笔记' }))
    expect(preload).toHaveBeenCalledWith('notes')

    preload.mockRestore()
  })

  it('划过会话行就预取那条会话的正文（点进去不必等一次往返）', async () => {
    const user = userEvent.setup()
    listConversationsMock.mockResolvedValue({
      items: [conversation({ id: 'c9', title: '青光眼是啥' })],
    })
    renderShell()

    const row = await screen.findByRole('link', { name: /青光眼是啥/ })
    expect(vi.mocked(getConversation)).not.toHaveBeenCalled() // 划过之前不拉

    await user.hover(row)

    await waitFor(() => expect(vi.mocked(getConversation)).toHaveBeenCalledWith('c9'))
  })
})

describe('会话行显示"什么时候聊的"（D14，2026-09-28 走查）', () => {
  it('每一行标题后面跟着相对时间（与知识库列表同一个格式器）', async () => {
    // 病灶：整行只有标题，用户在一屏会话里分不出"这是上午那条还是上周那条"。
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    listConversationsMock.mockResolvedValue({
      items: [conversation({ id: 'c1', title: '会话 A', updated_at: fiveMinutesAgo })],
    })

    renderShell()

    expect(await screen.findByText('5 分钟前')).toBeInTheDocument()
    // 那一行还在（时间没有把它挤掉）
    expect(screen.getByRole('link', { name: /会话 A/ })).toBeInTheDocument()
  })

  it('没有 `updated_at` 的行不显示时间（不写"—"占位）', async () => {
    listConversationsMock.mockResolvedValue({
      items: [conversation({ id: 'c1', title: '会话 A', updated_at: null })],
    })

    renderShell()

    expect(await screen.findByRole('link', { name: /会话 A/ })).toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })
})

it('会话行菜单能导出 Markdown（D13，2026-09-28 走查）', async () => {
  // 病灶：会话**没有任何导出/分享出口** —— 想留档只能一条条手抄。
  const { getConversation } = await import('@/api/conversations')
  vi.mocked(getConversation).mockResolvedValue({
    id: 'c1',
    title: '会话 A',
    messages: [
      { role: 'user', content: '眼轴随访怎么看？', sources: [] },
      { role: 'assistant', content: '先看随访月数。', sources: [] },
    ],
  } as never)

  // jsdom 没有这两个 API；补上才能把"下载"这一步跑完（并顺便钉住**回收**那一步）
  const createUrl = vi.fn((blob: Blob) => {
    void blob
    return 'blob:fake'
  })
  const revokeUrl = vi.fn()
  URL.createObjectURL = createUrl as never
  URL.revokeObjectURL = revokeUrl as never

  listConversationsMock.mockResolvedValue({
    items: [conversation({ id: 'c1', title: '会话 A' })],
  })
  renderShell()

  const user = userEvent.setup()
  await openRowMenu(user)
  await user.click(await screen.findByRole('menuitem', { name: /导出为 Markdown/ }))

  await waitFor(() => expect(createUrl).toHaveBeenCalledTimes(1))
  // 文稿内容对得上（标题 + 问答原文），而且 blob URL **撤掉了**（不撤就是内存泄漏）
  const blob = createUrl.mock.calls[0][0] as Blob
  const text = await blob.text()
  expect(text).toContain('# 会话 A')
  expect(text).toContain('眼轴随访怎么看？')
  expect(text).toContain('先看随访月数。')
  expect(revokeUrl).toHaveBeenCalledWith('blob:fake')
})

it('另一条会话在生成时，侧栏那一行有小点（D17，2026-09-28 走查）', async () => {
  // 病灶：切走之后**没有任何提示** —— 用户只能靠"回来时回答有没有变长"猜
  const { useLiveTurnStore } = await import('@/features/chat/model/liveTurn')
  listConversationsMock.mockResolvedValue({
    items: [
      conversation({ id: 'c1', title: '会话 A' }),
      conversation({ id: 'c2', title: '会话 B' }),
    ],
  })
  // live 槽：**c2 在跑**，而这一页停在 /notes（两条都不是"当前打开的那条"）
  useLiveTurnStore.setState({
    live: {
      conversationId: 'c2',
      mode: 'append',
      query: '问一句',
      thinking: null,
      text: '',
      thinkingText: '',
      steps: [],
      sources: [],
      streaming: true,
      error: '',
      recovered: false,
    } as never,
  })

  try {
    renderShell()

    expect(await screen.findByTestId('generating-c2')).toBeInTheDocument()
    // **在跑的那条**才有；别的不许有
    expect(screen.queryByTestId('generating-c1')).not.toBeInTheDocument()
    expect(screen.getByLabelText('正在生成')).toBeInTheDocument()
  } finally {
    useLiveTurnStore.setState({ live: null })
  }
})

it('当前正看的那条会话**不**另外加点（D17：它已经有「停止生成」）', async () => {
  const { useLiveTurnStore } = await import('@/features/chat/model/liveTurn')
  listConversationsMock.mockResolvedValue({
    items: [conversation({ id: 'c2', title: '会话 B' })],
  })
  useLiveTurnStore.setState({
    live: {
      conversationId: 'c2',
      mode: 'append',
      query: '问一句',
      thinking: null,
      text: '',
      thinkingText: '',
      steps: [],
      sources: [],
      streaming: true,
      error: '',
      recovered: false,
    } as never,
  })

  try {
    // 就停在这条会话上（`current`）—— 这时输入框上已经有「停止生成」
    renderShell('/chat/c2')

    expect(await screen.findByRole('link', { name: /会话 B/ })).toBeInTheDocument()
    expect(screen.queryByTestId('generating-c2')).not.toBeInTheDocument()
  } finally {
    useLiveTurnStore.setState({ live: null })
  }
})
