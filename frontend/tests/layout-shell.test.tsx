/**
 * 应用壳（侧栏导航 / 折叠 / 快捷键 / 用户区 / 历史面板的开合）的用例。
 *
 * 对照的旧实现是 `frontend/src/components/layout/SideNav.vue`（1,632 行）与 `App.vue`。
 * 这一节覆盖五件**迁移里最容易被简化掉**的事：
 *
 * 1. 主导航项与当前路由高亮（旧版只有一个 CSS class，这里同时钉 `aria-current`）；
 * 2. 折叠：窄条形态、`kylab-sidebar-collapsed` 持久化、**读**这个键、以及
 *    `kylab:sidebar-toggle` 广播的联动（chat 域的快捷键就是靠它把状态传过来的）；
 * 3. 两条全局快捷键（`chat.new` / `layout.toggleSidebar`）真的能用，且**输入框里不抢**；
 * 4. 用户区：账号那一行、管理员才有的「设置」、主题翻转；
 * 5. 历史会话面板：点「查看全部会话」能开、**Esc 关**、**换页关**（§12.194 那个 bug）。
 *
 * 2026-10-08 跟着两处一起删的用例：「登录页不长出侧栏」与「知识库组」——
 * 登录页与那一族知识库页面都删了（本机档免登录、知识库界面搬去 kybase，
 * 见 `app/App.tsx` 的文件头）。
 *
 * 2026-10-09 又删掉两处：「概览」那一项（页面整块删了，`/` 改成重定向到 `/chat`）
 * 与「头像 / 退出登录」（`api/auth.ts` 那一族端点随账号死面一起下线，
 * 见 `AccountMenu.tsx` 的文件头）。
 *
 * 同一天再收一轮：会话状态里的 `currentUser` 删了（它恒为 null，见 `lib/session.ts`），
 * 所以这一份里那些"摆一个有账号的现场"的写法（`account('admin')` / `account('member')`）
 * 一并去掉——用户区那一行现在只有一个事实：**本机主人**（有本机后端时），
 * 「设置」在不在也只看那一条（`lib/useIsAdmin`）。
 */
import { render, screen, waitFor, within } from '@testing-library/react'
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

/**
 * 设置弹窗**替身**：它是邻域的件（按 import 用，不改），
 * 而设置弹窗内部要 react-query 与半个设置域才起得来。这里只钉"壳把哪个 props 交给了它"
 * ——那正是壳的契约（`open` 的开合）。
 */
vi.mock('@/features/misc/settings/SettingsModal', () => ({
  SettingsModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="settings-modal" /> : null,
}))

import { listConversations } from '@/api/conversations'
import { listWorkspaces } from '@/api/workspaces'
import { AppShell } from '@/features/layout/AppShell'
import { useConversationStore } from '@/features/layout/conversations'
import { useSidebarStore } from '@/features/layout/useSidebar'
import { useWorkspaceStore } from '@/features/layout/workspaces'
import { resetAllShortcuts } from '@/features/misc/settings/useShortcuts'
import { setLocalBackendForTest } from '@/api/local'
import { requestRelogin, setSessionToken, useSessionStore } from '@/lib/session'

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
            <Route path="/notes" element={<div>笔记页</div>} />
            <Route path="/memory" element={<div>记忆页</div>} />
            <Route path="/capabilities" element={<div>能力页</div>} />
            <Route path="/tasks" element={<div>任务中心页</div>} />
            <Route path="/workspaces" element={<LocationProbe />} />
            <Route path="/chat/:conversationId?" element={<LocationProbe />} />
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
  // 三个模块级单例（侧栏折叠 / 会话清单 / 项目清单）都要回零：它们是跨用例保留的
  useSidebarStore.setState({ collapsed: false })
  useConversationStore.getState().reset()
  useWorkspaceStore.getState().reset()
  useSessionStore.setState({ token: '', reloginCount: 0 })
  // 这一档：**有本机后端**（壳的产品形态就是它）——用户区那一行写「本机主人」、
  // 「设置」在不在都看它（`lib/useIsAdmin` 现在就是这一条判据）。
  // 要摆"没有本机后端"那一档的用例自己再摆一次。
  setLocalBackendForTest('local')
  resetAllShortcuts()
})

describe('侧栏导航', () => {
  it('渲染主导航项与当前路由高亮', async () => {
    renderShell('/notes')

    const nav = await screen.findByRole('navigation', { name: '主导航' })
    for (const label of ['笔记', '记忆', '能力', '任务中心']) {
      expect(within(nav).getByText(label)).toBeInTheDocument()
    }
    // 当前页那一项标了 aria-current（旧版只有一个 CSS class）
    expect(within(nav).getByRole('link', { name: '笔记' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: '记忆' })).not.toHaveAttribute('aria-current')
    // 「概览」那一项随页面一起删了（2026-10-09，见文件头）
    expect(within(nav).queryByRole('link', { name: '概览' })).not.toBeInTheDocument()
    // 知识库那一组与它的子项都不在了（2026-10-08，见文件头）
    expect(within(nav).queryByText('知识库')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '所有知识库' })).not.toBeInTheDocument()
  })

  it('「任务中心」在主导航里指向 `/tasks`，站在那儿时点亮', async () => {
    renderShell('/tasks')

    const nav = await screen.findByRole('navigation', { name: '主导航' })
    const tasks = within(nav).getByRole('link', { name: '任务中心' })
    expect(tasks).toHaveAttribute('href', '/tasks')
    expect(tasks).toHaveAttribute('aria-current', 'page')
    // 其余几项都不点亮（当前项整栏只有一种样子）
    expect(within(nav).getByRole('link', { name: '笔记' })).not.toHaveAttribute('aria-current')
  })

  it('能力页在主导航里有归属：当前项标 aria-current 并带选中底', async () => {
    renderShell('/capabilities')

    const nav = await screen.findByRole('navigation', { name: '主导航' })
    const link = within(nav).getByRole('link', { name: '能力' })
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(link.className).toContain('bg-[var(--bg-selected)]')
    expect(within(nav).getByRole('link', { name: '笔记' })).not.toHaveAttribute('aria-current')
  })

  it('新建会话入口指向 /chat?new=1，并带快捷键提示', async () => {
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
          archived_at: null,
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
})

describe('侧栏折叠', () => {
  it('点折叠开关：变窄条、落 kylab-sidebar-collapsed、再点回到展开', async () => {
    const user = userEvent.setup()
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
    expect(
      // 展开也**写下 `'0'`**（D29 起的新契约）：删键等于"**没表过态**"，而窄屏
      // 默认是折叠——那样用户点开侧栏之后会被下一次渲染收回去，看着像开关失灵。
      window.localStorage.getItem('kylab-sidebar-collapsed'),
    ).toBe('0')
  })

  it('挂载时读存储：预置为 1 就直接是窄条', async () => {
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
    renderShell('/notes')

    await user.keyboard('{Control>}k{/Control}')

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/chat?new=1'))
  })

  it('敲字的地方不抢：输入框里按 Ctrl+K 不跳转', async () => {
    const user = userEvent.setup()
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
  it('账号菜单：只有「设置」与主题翻转两项（头像 / 退出登录 2026-10-09 随账号族删掉）', async () => {
    const user = userEvent.setup()
    renderShell('/notes')

    // 这一档的身份只有一个事实：本机主人（后端起给它的就是这个名字）
    expect(await screen.findByText('本机主人')).toBeInTheDocument()
    // 角色徽章不再印：那是**账号体系里的角色**，而本机主人不是"管理员"这个角色
    expect(screen.queryByText('管理员')).toBeNull()
    expect(screen.queryByText('成员')).toBeNull()

    await user.click(screen.getByRole('button', { name: '账号：本机主人' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: '设置' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: '切换为深色' })).toBeInTheDocument()
    // 头像（`AvatarDialog`）与「退出登录」都不在了：它们打的 `/auth/*` 一族已经下线
    expect(within(menu).queryByRole('menuitem', { name: '头像' })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: '退出登录' })).toBeNull()
  })

  it('没有本机后端那一档：名字留白、也没有「设置」（那一档整套数据面都没有）', async () => {
    const user = userEvent.setup()
    setLocalBackendForTest('absent')
    renderShell('/notes')

    // 没有账号体系之外的"主人"：留白才是实话（原先这一行读的是恒 null 的 currentUser）
    await user.click(await screen.findByRole('button', { name: '账号' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).queryByRole('menuitem', { name: '设置' })).not.toBeInTheDocument()
    // 主题那一项与本机后端无关，照旧在
    expect(within(menu).getByRole('menuitem', { name: /切换为/ })).toBeInTheDocument()

    setLocalBackendForTest('local')
  })

  it('「设置」开 SettingsModal', async () => {
    const user = userEvent.setup()
    renderShell('/notes')

    await user.click(await screen.findByRole('button', { name: '账号：本机主人' }))
    await user.click(await screen.findByRole('menuitem', { name: '设置' }))
    expect(await screen.findByTestId('settings-modal')).toBeInTheDocument()
  })

  it('切换主题：菜单那句说清切过去是哪一边，点完写进 data-theme 与本地存储', async () => {
    const user = userEvent.setup()
    document.documentElement.dataset.theme = 'light'
    renderShell('/notes')

    await user.click(await screen.findByRole('button', { name: '账号：本机主人' }))
    await user.click(await screen.findByRole('menuitem', { name: '切换为深色' }))

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem('kylab-theme')).toBe('dark')

    // 再开一次：文案翻到另一边
    await user.click(screen.getByRole('button', { name: '账号：本机主人' }))
    expect(await screen.findByRole('menuitem', { name: '切换为浅色' })).toBeInTheDocument()
  })
})

describe('历史会话面板的开合', () => {
  it('点「查看全部会话」打开面板，Esc 关掉', async () => {
    const user = userEvent.setup()
    renderShell('/notes')

    await user.click(await screen.findByRole('button', { name: '查看全部会话' }))
    const panel = await screen.findByRole('dialog', { name: '历史会话' })
    expect(within(panel).getByLabelText('搜索历史会话')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '历史会话' })).not.toBeInTheDocument(),
    )
  })

  it('会话失效（401）：清掉本地凭据，**不跳登录页**（登录页已删）', async () => {
    useSessionStore.setState({ token: 'tok-1' })
    setSessionToken('tok-1')
    renderShell('/notes')
    await screen.findByRole('navigation', { name: '主导航' })

    // 任何请求拿到 401 都会走这一个信号（api/client.ts）
    requestRelogin()

    // 令牌被清掉（本机档照常能用），页面**留在原处**——没有登录页可去了
    await waitFor(() => expect(useSessionStore.getState().token).toBe(''))
    expect(screen.getByText('笔记页')).toBeInTheDocument()
  })

  it('计数只在"变了"那一次动手：带着一个非零计数挂载不会再清一次', async () => {
    // 计数不会归零，所以判据只能是"这个数变了"——写成"计数非零就清"的话，
    // 每次挂载都会清一遍（用户刚拿到的凭据又被抹掉）。
    useSessionStore.setState({ token: 'tok-2', reloginCount: 3 })
    setSessionToken('tok-2')
    renderShell('/notes')
    await screen.findByRole('navigation', { name: '主导航' })

    expect(useSessionStore.getState().token).toBe('tok-2')

    // 真的变了才动手
    requestRelogin()
    await waitFor(() => expect(useSessionStore.getState().token).toBe(''))
  })

  it('换页就关（§12.194：浮层没关等于菜单点不动）', async () => {
    const user = userEvent.setup()
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
  it('挂载后在空闲时预热任务列表', async () => {
    const prewarm = vi.spyOn(await import('@/features/misc/prewarm'), 'prewarmMisc')
    renderShell('/notes')

    // `onIdle` 在 jsdom 里退化成 `setTimeout(0)`：等它跑
    await waitFor(() => expect(prewarm).toHaveBeenCalledTimes(1))

    prewarm.mockRestore()
  })
})
