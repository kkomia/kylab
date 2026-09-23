/**
 * 应用壳（侧栏导航 / 折叠 / 快捷键 / 用户区 / 历史面板的开合）的用例。
 *
 * 对照的旧实现是 `frontend/src/components/layout/SideNav.vue`（1,632 行）与 `App.vue`。
 * 这一节覆盖六件**迁移里最容易被简化掉**的事：
 *
 * 1. 主导航项与当前路由高亮（旧版只有一个 CSS class，这里同时钉 `aria-current`）；
 * 2. 折叠：窄条形态、`kylab-sidebar-collapsed` 持久化、**读**这个键、以及
 *    `kylab:sidebar-toggle` 广播的联动（chat 域的快捷键就是靠它把状态传过来的）；
 * 3. 两条全局快捷键（`chat.new` / `layout.toggleSidebar`）真的能用，且**输入框里不抢**；
 * 4. 用户区：账号、管理员多一项「设置」、主题翻转、退出登录三件事（清令牌 + 清缓存 + 跳登录）；
 * 5. 历史会话面板：点「查看全部会话」能开、**Esc 关**、**换页关**（§12.194 那个 bug）；
 * 6. 登录页不长出侧栏。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
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

vi.mock('@/api/users', () => ({
  listUsers: vi.fn(async () => ({ items: [], header: 'X-Kylab-Operator' })),
}))

vi.mock('@/api/auth', () => ({
  logout: vi.fn(async () => undefined),
  getAuthBootstrapStatus: vi.fn(async () => ({ needs_setup: false, auth_enabled: true })),
  me: vi.fn(async () => null),
  login: vi.fn(),
  setup: vi.fn(),
  changePassword: vi.fn(),
  uploadAvatar: vi.fn(),
  clearAvatar: vi.fn(),
  MIN_PASSWORD_CHARS: 8,
}))

/**
 * 设置弹窗与头像弹窗**替身**：它们是邻域的件（按 import 用，不改），
 * 而设置弹窗内部要 react-query 与半个设置域才起得来。这里只钉"壳把哪个 props 交给了它"
 * ——那正是壳的契约（`open` 的开合、`name` / `url` 的来源）。
 */
vi.mock('@/features/misc/settings/SettingsModal', () => ({
  SettingsModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="settings-modal" /> : null,
}))
vi.mock('@/features/misc/settings/AvatarDialog', () => ({
  AvatarDialog: ({ open, name, url }: { open: boolean; name: string; url: string }) =>
    open ? <div data-testid="avatar-dialog" data-name={name} data-url={url} /> : null,
}))

import { logout } from '@/api/auth'
import { listConversations } from '@/api/conversations'
import { listWorkspaces } from '@/api/workspaces'
import { AppShell } from '@/features/layout/AppShell'
import { useConversationStore } from '@/features/layout/conversations'
import { useSidebarStore } from '@/features/layout/useSidebar'
import { useWorkspaceStore } from '@/features/layout/workspaces'
import { resetAllShortcuts } from '@/features/misc/settings/useShortcuts'
import type { Account } from '@/api/auth'
import { requestRelogin, setSessionToken, useSessionStore } from '@/lib/session'
import { useOperatorStore } from '@/lib/operator'

const logoutMock = vi.mocked(logout)
const listConversationsMock = vi.mocked(listConversations)
const listWorkspacesMock = vi.mocked(listWorkspaces)

/** 让用例能读到"现在在哪个地址"（快捷键跳转、面板里点会话都要断言它）。 */
function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>
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
            <Route path="/" element={<div>概览页</div>} />
            <Route path="/notes" element={<div>笔记页</div>} />
            <Route path="/memory" element={<div>记忆页</div>} />
            <Route path="/capabilities" element={<div>能力页</div>} />
            <Route path="/knowledge-bases" element={<div>知识库列表页</div>} />
            <Route path="/kb/:kbId" element={<div>知识库详情页</div>} />
            <Route path="/dashboard" element={<div>概览页</div>} />
            <Route path="/tasks" element={<div>任务中心页</div>} />
            <Route path="/workspaces" element={<LocationProbe />} />
            <Route path="/chat/:conversationId?" element={<LocationProbe />} />
          </Route>
          <Route path="/login" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function account(role: 'admin' | 'member' = 'admin'): Account {
  return { id: 'u1', username: 'you', name: '小又', role, avatar_url: '' }
}

beforeEach(() => {
  vi.clearAllMocks()
  listConversationsMock.mockResolvedValue({ items: [] })
  listWorkspacesMock.mockResolvedValue({ items: [] })
  // 三个模块级单例（侧栏折叠 / 会话清单 / 项目清单）都要回零：它们是跨用例保留的
  useSidebarStore.setState({ collapsed: false })
  useConversationStore.getState().reset()
  useWorkspaceStore.getState().reset()
  useSessionStore.setState({ currentUser: null, token: '', reloginCount: 0 })
  useOperatorStore.setState({ operatorId: '', roster: [] })
  resetAllShortcuts()
})

describe('侧栏导航', () => {
  it('渲染主导航项与当前路由高亮', async () => {
    useSessionStore.setState({ currentUser: account('member') })
    renderShell('/notes')

    const nav = await screen.findByRole('navigation', { name: '主导航' })
    for (const label of ['笔记', '记忆', '能力', '知识库']) {
      expect(within(nav).getByText(label)).toBeInTheDocument()
    }
    // 当前页那一项标了 aria-current（旧版只有一个 CSS class）
    expect(within(nav).getByRole('link', { name: '笔记' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: '记忆' })).not.toHaveAttribute('aria-current')
  })

  it('知识库是可折叠的子菜单：默认收起，展开后三条子项都在（不列库名）', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ currentUser: account('member') })
    renderShell('/knowledge-bases')

    const group = await screen.findByRole('button', { name: '知识库' })
    expect(group).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: '所有知识库' })).not.toBeInTheDocument()

    await user.click(group)
    expect(group).toHaveAttribute('aria-expanded', 'true')
    for (const label of ['所有知识库', '概览', '任务中心']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument()
    }
    // 选中态：当前就在知识库列表页
    expect(screen.getByRole('link', { name: '所有知识库' })).toHaveAttribute('aria-current', 'page')
  })

  it('「概览」指向 `/`（与旧前端一致：落地页就是驾驶舱，书签不用改）', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ currentUser: account('member') })
    renderShell('/')

    await user.click(await screen.findByRole('button', { name: '知识库' }))
    const overview = screen.getByRole('link', { name: '概览' })
    expect(overview).toHaveAttribute('href', '/')
    expect(overview).toHaveAttribute('aria-current', 'page')
  })

  it('新建会话入口指向 /chat?new=1，并带快捷键提示', async () => {
    useSessionStore.setState({ currentUser: account('member') })
    renderShell('/notes')

    const entry = await screen.findByRole('link', { name: /新建会话/ })
    expect(entry).toHaveAttribute('href', '/chat?new=1')
    // 提示与绑定同源：默认绑定是 Mod+K，界面上就该出现这两枚小片
    expect(entry.querySelectorAll('kbd')).toHaveLength(2)
    expect(entry.textContent).toContain('Ctrl')
    expect(entry.textContent).toContain('K')
  })

  it('项目节：列出项目与条数，会话超过 5 条先收起，点「展开」看全部', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ currentUser: account('member') })
    listWorkspacesMock.mockResolvedValue({
      items: [
        {
          id: 'w1',
          name: '合同整理',
          root_path: 'E:/work/contracts',
          description: '',
          kb_ids: [],
          conversation_count: 7,
          created_at: null,
          updated_at: null,
        },
      ],
    })
    listConversationsMock.mockResolvedValue({
      items: Array.from({ length: 7 }, (_, index) => ({
        id: `c${index}`,
        title: `会话 ${index}`,
        kb_ids: [],
        model_pk: null,
        workspace_id: 'w1',
        thinking: null,
        thinking_effort: null,
        pinned: false,
        archived_at: null,
        preview: '',
        created_at: null,
        updated_at: '2026-09-20T10:00:00Z',
        message_count: 1,
      })) as any,
    })
    renderShell('/notes')

    expect(await screen.findByTitle('E:/work/contracts')).toBeInTheDocument()
    expect(screen.getByText('合同整理')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    // 只露前 5 条，其余收在「展开（还有 N 条）」后面
    expect(screen.getByText('会话 0')).toBeInTheDocument()
    expect(screen.queryByText('会话 6')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '展开（还有 2 条）' }))
    expect(screen.getByText('会话 6')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^展开（还有/ })).not.toBeInTheDocument()
  })

  it('登录页不长出侧栏', async () => {
    renderShell('/login')
    expect(await screen.findByTestId('location')).toHaveTextContent('/login')
    expect(screen.queryByRole('navigation', { name: '主导航' })).not.toBeInTheDocument()
  })
})

describe('侧栏折叠', () => {
  it('点折叠开关：变窄条、落 kylab-sidebar-collapsed、再点回到展开', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ currentUser: account('member') })
    renderShell('/notes')

    const toggle = await screen.findByRole('button', { name: '收缩侧栏' })
    await user.click(toggle)

    const aside = screen.getByRole('complementary', { name: '侧栏' })
    expect(aside.className).toContain('ly-sidebar-collapsed')
    expect(window.localStorage.getItem('kylab-sidebar-collapsed')).toBe('1')
    // 窄条形态：新建会话那一块整条收起（与旧版 `v-if="!collapsed"` 同一条）
    expect(screen.queryByRole('link', { name: /新建会话/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '展开侧栏' }))
    expect(screen.getByRole('complementary', { name: '侧栏' }).className).not.toContain(
      'ly-sidebar-collapsed',
    )
    expect(window.localStorage.getItem('kylab-sidebar-collapsed')).toBeNull()
  })

  it('挂载时读存储：预置为 1 就直接是窄条', async () => {
    useSessionStore.setState({ currentUser: account('member') })
    window.localStorage.setItem('kylab-sidebar-collapsed', '1')
    useSidebarStore.setState({ collapsed: true })
    renderShell('/notes')

    await waitFor(() =>
      expect(screen.getByRole('complementary', { name: '侧栏' }).className).toContain(
        'ly-sidebar-collapsed',
      ),
    )
  })

  it('监听 kylab:sidebar-toggle：chat 域的快捷键广播能让侧栏当场收/开', async () => {
    useSessionStore.setState({ currentUser: account('member') })
    renderShell('/notes')
    await screen.findByRole('navigation', { name: '主导航' })

    window.dispatchEvent(new CustomEvent('kylab:sidebar-toggle', { detail: { collapsed: true } }))
    await waitFor(() =>
      expect(screen.getByRole('complementary', { name: '侧栏' }).className).toContain(
        'ly-sidebar-collapsed',
      ),
    )

    window.dispatchEvent(new CustomEvent('kylab:sidebar-toggle', { detail: { collapsed: false } }))
    await waitFor(() =>
      expect(screen.getByRole('complementary', { name: '侧栏' }).className).not.toContain(
        'ly-sidebar-collapsed',
      ),
    )
  })
})

describe('全局快捷键', () => {
  it('Ctrl/Cmd+B 切换侧栏（落存储 + 侧栏当场变窄）', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ currentUser: account('member') })
    renderShell('/notes')
    await screen.findByRole('navigation', { name: '主导航' })

    await user.keyboard('{Control>}b{/Control}')

    await waitFor(() =>
      expect(screen.getByRole('complementary', { name: '侧栏' }).className).toContain(
        'ly-sidebar-collapsed',
      ),
    )
    expect(window.localStorage.getItem('kylab-sidebar-collapsed')).toBe('1')
  })

  it('Ctrl/Cmd+K 新建会话：跳到 /chat?new=1', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ currentUser: account('member') })
    renderShell('/notes')

    await user.keyboard('{Control>}k{/Control}')

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/chat?new=1'))
  })

  it('敲字的地方不抢：输入框里按 Ctrl+K 不跳转', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ currentUser: account('member') })
    renderShell('/notes')

    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    await user.keyboard('{Control>}k{/Control}')

    expect(screen.queryByTestId('location')).not.toBeInTheDocument()
    expect(screen.getByText('笔记页')).toBeInTheDocument()
    input.remove()
  })
})

describe('用户区', () => {
  it('管理员：菜单四项在（头像 / 设置 / 切换为深色 / 退出登录）', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ currentUser: account('admin') })
    renderShell('/notes')

    expect(await screen.findByText('小又')).toBeInTheDocument()
    expect(screen.getByText('管理员')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '账号：小又' }))
    const menu = await screen.findByRole('menu')
    for (const label of ['头像', '设置', '切换为深色', '退出登录']) {
      expect(within(menu).getByRole('menuitem', { name: label })).toBeInTheDocument()
    }
  })

  it('成员：没有「设置」这一项（后端对成员一律 403）', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ currentUser: account('member') })
    renderShell('/notes')

    await user.click(await screen.findByRole('button', { name: '账号：小又' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: '头像' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: '设置' })).not.toBeInTheDocument()
    // 身份那一行写着"成员"（角色由 currentUser 推出来）
    expect(screen.getByText('成员')).toBeInTheDocument()
  })

  it('「头像」开 AvatarDialog，名字 / 链接由壳交过去', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({
      currentUser: { ...account('member'), avatar_url: 'https://example.test/a.png' },
    })
    renderShell('/notes')

    await user.click(await screen.findByRole('button', { name: '账号：小又' }))
    await user.click(await screen.findByRole('menuitem', { name: '头像' }))

    const dialog = await screen.findByTestId('avatar-dialog')
    expect(dialog).toHaveAttribute('data-name', '小又')
    expect(dialog).toHaveAttribute('data-url', 'https://example.test/a.png')
  })

  it('「设置」开 SettingsModal', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ currentUser: account('admin') })
    renderShell('/notes')

    await user.click(await screen.findByRole('button', { name: '账号：小又' }))
    await user.click(await screen.findByRole('menuitem', { name: '设置' }))
    expect(await screen.findByTestId('settings-modal')).toBeInTheDocument()
  })

  it('切换主题：菜单那句说清切过去是哪一边，点完写进 data-theme 与本地存储', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ currentUser: account('member') })
    document.documentElement.dataset.theme = 'light'
    renderShell('/notes')

    await user.click(await screen.findByRole('button', { name: '账号：小又' }))
    await user.click(await screen.findByRole('menuitem', { name: '切换为深色' }))

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem('kylab-theme')).toBe('dark')

    // 再开一次：文案翻到另一边
    await user.click(screen.getByRole('button', { name: '账号：小又' }))
    expect(await screen.findByRole('menuitem', { name: '切换为浅色' })).toBeInTheDocument()
  })

  it('退出登录：吊销会话 + 清会话清单与名册 + 跳登录页', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ currentUser: account('admin') })
    setSessionToken('tok-1')
    useOperatorStore.setState({ operatorId: 'u1', roster: [{ id: 'u1', name: '小又' }] as never })
    useConversationStore.setState({ items: [], query: 'x' })
    renderShell('/notes')

    await user.click(await screen.findByRole('button', { name: '账号：小又' }))
    await user.click(await screen.findByRole('menuitem', { name: '退出登录' }))

    await waitFor(() => expect(logoutMock).toHaveBeenCalledTimes(1))
    // 令牌清了、清单与名册也清了（不清的话换个人登录先看到前一个人的数据）
    await waitFor(() => expect(useSessionStore.getState().token).toBe(''))
    expect(useConversationStore.getState().query).toBe('')
    expect(useOperatorStore.getState().roster).toEqual([])
    expect(window.localStorage.getItem('kylab-session-token')).toBeNull()
    // 落在登录页（壳在登录页不长侧栏）
    expect(await screen.findByTestId('location')).toHaveTextContent('/login')
  })
})

describe('历史会话面板的开合', () => {
  it('点「查看全部会话」打开面板，Esc 关掉', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ currentUser: account('member') })
    renderShell('/notes')

    await user.click(await screen.findByRole('button', { name: '查看全部会话' }))
    const panel = await screen.findByRole('dialog', { name: '历史会话' })
    expect(within(panel).getByLabelText('搜索历史会话')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '历史会话' })).not.toBeInTheDocument(),
    )
  })

  it('会话失效（401）：跳登录页并把原地址带在 redirect 上', async () => {
    useSessionStore.setState({ currentUser: account('member'), token: 'tok-1' })
    renderShell('/notes')
    await screen.findByRole('navigation', { name: '主导航' })

    // 任何请求拿到 401 都会走这一个信号（api/client.ts）
    requestRelogin()

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        `/login?redirect=${encodeURIComponent('/notes')}`,
      ),
    )
  })

  it('计数只在"变了"那一次动手：重新登录后（计数还没归零）再进来不会被弹回登录页', async () => {
    useSessionStore.setState({ currentUser: account('member'), token: 'tok-2' })
    renderShell('/notes')
    await screen.findByRole('navigation', { name: '主导航' })

    requestRelogin()
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'))

    // 从登录页回到业务页 = 重新登录成功（`login()` 只重置令牌，不碰这个计数）。
    // 若把这条判成"计数非零就跳"，这里会被再弹一次、与接入层的守卫来回拉锯。
    cleanup()
    renderShell('/notes')
    expect(await screen.findByText('笔记页')).toBeInTheDocument()
    expect(screen.queryByTestId('location')).not.toBeInTheDocument()
  })

  it('换页就关（§12.194：浮层没关等于菜单点不动）', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ currentUser: account('member') })
    renderShell('/notes')

    await user.click(await screen.findByRole('button', { name: '查看全部会话' }))
    expect(await screen.findByRole('dialog', { name: '历史会话' })).toBeInTheDocument()

    // 点侧栏另一个菜单：路由变了，盖在内容区上的浮层必须一起消失
    await user.click(screen.getByRole('link', { name: '记忆' }))
    await waitFor(() => expect(screen.getByText('记忆页')).toBeInTheDocument())
    expect(screen.queryByRole('dialog', { name: '历史会话' })).not.toBeInTheDocument()
  })
})

describe('启动后空闲预热（旧 SideNav 的 idle 预热口径）', () => {
  it('挂载后在空闲时预热任务列表与概览统计（各一次）', async () => {
    useSessionStore.setState({ currentUser: account('member') })
    const prewarm = vi.spyOn(await import('@/features/misc/prewarm'), 'prewarmMisc')
    renderShell('/notes')

    // `onIdle` 在 jsdom 里退化成 `setTimeout(0)`：等它跑
    await waitFor(() => expect(prewarm).toHaveBeenCalledTimes(1))

    prewarm.mockRestore()
  })
})
