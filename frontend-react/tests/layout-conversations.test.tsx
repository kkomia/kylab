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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
    ...overrides,
  }
}

function account(role: 'admin' | 'member' = 'admin'): Account {
  return { id: 'u1', username: 'you', name: '小又', role, avatar_url: '' }
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/notes']}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/notes" element={<div>笔记页</div>} />
          <Route path="/chat/:conversationId?" element={<div>对话页</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
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

  it('一条会话都没有时说一句状态，不给操作指引', async () => {
    renderShell()
    expect(await screen.findByText('还没有对话')).toBeInTheDocument()
    expect(screen.getByText('还没有项目')).toBeInTheDocument()
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
      expect(titles.indexOf('会话 B')).toBeLessThan(titles.indexOf('会话 A'))
    })
  })

  it('重命名：弹窗里输入新标题，保存调 { title }；空标题不发请求', async () => {
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
  })

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

  it('空态：没搜索也没归档时说「还没有会话」，搜索无果时说「没有匹配的会话」', async () => {
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
  })

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
