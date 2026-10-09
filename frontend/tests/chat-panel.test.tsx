/**
 * 对话页右侧面板的界面用例（骨架 + 文件标签）。
 *
 * 钉的是"用户看得见的那几件事"：开关（含落盘）、空态入口、标签条（单例 / 关闭 / 左右键）、
 * 文件树的懒加载、搜索只吃已展开的层，以及**「加号 → 浏览文件」仍然开抽屉**那条分流
 * （带种子的那一条走面板，见 `ChatProvider.openFiles`）。
 *
 * 2026-10-09 那一轮（用户逐条批的九条）里属于这一页的另几条也在这儿钉住：
 * 开关在页面右上角（开着时由标签条右端那颗顶着）、标签条右端是「全屏 / 收起」、
 * 拖那条缝改宽度（含上下限与落盘）、范围页签撤掉之后"挂了项目读项目目录"。
 *
 * 排序 / 模糊匹配 / 图标分派 / 续层定位那几件纯计算在 `chat-panel-tree.test.ts` 里逐条钉
 * ——那一层盯得住细节，这一层只验"接上了"。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { clearLiveAnchors, clearLiveTurn } from '@/features/chat/model/liveTurn'
import { ChatPage } from '@/features/chat/ChatPage'
import { PANEL_WIDTH_KEY, usePanelStore } from '@/features/chat/panel/panelStore'

vi.mock('@/api/workspaces', () => ({
  listWorkspaces: vi.fn(async () => ({ items: [] })),
  listArchivedWorkspaces: vi.fn(async () => ({ items: [] })),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}))

vi.mock('@/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/chat')>()
  return {
    ...actual,
    chatStream: vi.fn(async () => ({ abort: vi.fn() })),
    openLiveTurn: vi.fn(async () => ({ abort: vi.fn() })),
    resumeStream: vi.fn(async () => ({ abort: vi.fn() })),
    listCommands: vi.fn(async () => []),
    getSuggestedQuestions: vi.fn(async () => ({ questions: [], generated: false })),
    getContextUsage: vi.fn(async () => ({
      items: [],
      used: 0,
      total: 0,
      ratio: 0,
      compress_at: 0,
      compress_budget: 0,
      estimated: true,
      note: '',
    })),
  }
})

vi.mock('@/api/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/conversations')>()
  return {
    ...actual,
    getConversation: vi.fn(),
    listConversations: vi.fn(async () => ({ items: [] })),
    listArtifacts: vi.fn(async () => ({ items: [] })),
    listFiles: vi.fn(async () => ({
      mode: 'object',
      label: '本会话',
      path: '',
      parent: null,
      entries: [],
      truncated: false,
    })),
    getFileUrl: vi.fn(async () => ({ url: '', expires_at: 0, name: '' })),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(async () => undefined),
    importWorkspaceFile: vi.fn(),
  }
})

vi.mock('@/api/knowledgeBases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/knowledgeBases')>()),
  listKnowledgeBases: vi.fn(async () => ({ items: [], total: 0 })),
}))

vi.mock('@/api/modelRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/modelRegistry')>()),
  getRegistry: vi.fn(async () => ({
    providers: [],
    models: [],
    slots: [],
    presets: [],
    provider_presets: [],
  })),
}))

vi.mock('@/api/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/settings')>()),
  getSettings: vi.fn(async () => ({
    groups: [],
    embedding_model_id: '',
    embedding_dim: 0,
    embedding_configured: true,
    embedding_is_development: false,
    rerank_enabled: false,
  })),
}))

vi.mock('@/api/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/capabilities')>()),
  listSkills: vi.fn(async () => ({ items: [], usable: 0 })),
}))

import { getConversation, listFiles } from '@/api/conversations'
import type { ConversationDetail, ConversationFileListing } from '@/api/conversations'

/** 一条最小会话（`title` 有值：会话条要画出来）。 */
function detail(): ConversationDetail {
  return {
    id: 'c1',
    title: '一条会话',
    kb_ids: [],
    model_pk: '',
    thinking: null,
    thinking_effort: null,
    workspace_id: null,
    pinned: false,
    archived: false,
    message_count: 0,
    created_at: null,
    updated_at: null,
    messages: [],
  } as unknown as ConversationDetail
}

/** 一层文件区（默认空）。 */
function listing(
  entries: ConversationFileListing['entries'],
  extra: Partial<ConversationFileListing> = {},
): ConversationFileListing {
  return {
    mode: 'object',
    label: '本会话',
    path: '',
    parent: null,
    entries,
    truncated: false,
    ...extra,
  }
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/chat/c1']}>
        <Routes>
          <Route path="/chat/:conversationId?" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** 打开面板（点会话条右端那颗开关），返回面板那一列。 */
async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '打开右侧面板' }))
  return screen.findByRole('complementary', { name: '右侧面板' })
}

beforeEach(() => {
  // jsdom 没有 `Element.prototype.scrollTo`（与 `chat-ui.test.tsx` 同一处兜底）
  Element.prototype.scrollTo = () => undefined
  vi.clearAllMocks()
  clearLiveTurn()
  clearLiveAnchors()
  vi.mocked(getConversation).mockResolvedValue(detail())
  vi.mocked(listFiles).mockResolvedValue(listing([]))
  /*
    面板是**模块级单例**：`localStorage.clear()`（`tests/setup.ts` 的 afterEach）清不掉
    它内存里那一位，所以每条用例开头摆回默认态。
  */
  usePanelStore.setState({
    open: false,
    tabs: [],
    activeId: '',
    currentConversationId: '',
    seed: null,
    filesView: { path: '' },
    width: 380,
    full: false,
  })
})

describe('面板开关（会话条右端那一颗）', () => {
  it('点开：面板出现、按钮翻成"收起"、偏好落盘；再点一次收回去', async () => {
    renderPage()
    const user = userEvent.setup()

    const toggle = await screen.findByRole('button', { name: '打开右侧面板' })
    // 默认收着：`aria-pressed` 说的是"它管的那件事现在开着没有"
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('complementary', { name: '右侧面板' })).toBeNull()

    const panel = await openPanel(user)
    // **常驻的一列**：不是 dialog（抽屉那套），底下那一片是 complementary
    expect(panel).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '收起右侧面板' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(window.localStorage.getItem('kylab-chat-panel-open')).toBe('1')

    await user.click(screen.getByRole('button', { name: '收起右侧面板' }))
    expect(screen.queryByRole('complementary', { name: '右侧面板' })).toBeNull()
    expect(window.localStorage.getItem('kylab-chat-panel-open')).toBe('0')
  })

  it('新会话（还没有标题）也画会话条——那颗开关不能跟着标题一起消失', async () => {
    vi.mocked(getConversation).mockResolvedValue({
      ...detail(),
      title: '',
    } as unknown as ConversationDetail)
    renderPage()

    expect(await screen.findByRole('button', { name: '打开右侧面板' })).toBeInTheDocument()
  })
})

describe('空态与「文件」标签', () => {
  it('空态给一个入口；点它开「文件」标签，树按层读、子目录展开才去取数', async () => {
    vi.mocked(listFiles).mockImplementation(async (_id, path = '') =>
      path === 'out'
        ? listing([
            {
              key: 'out/b.md',
              name: 'b.md',
              is_dir: false,
              size_bytes: 10,
              modified_at: null,
              kind: 'md',
            },
          ])
        : listing([
            { key: 'out', name: 'out', is_dir: true, size_bytes: 0, modified_at: null, kind: '' },
            {
              key: 'a.md',
              name: 'a.md',
              is_dir: false,
              size_bytes: 20,
              modified_at: null,
              kind: 'md',
            },
          ]),
    )
    renderPage()
    const user = userEvent.setup()
    const panel = await openPanel(user)

    // 空态：一个功能入口 + 一行灰字说明
    expect(within(panel).getByRole('button', { name: '文件' })).toBeInTheDocument()
    // **还没点之前不取数**（与抽屉那一条同一个口径：挂上才算要读）
    expect(listFiles).not.toHaveBeenCalled()

    await user.click(within(panel).getByRole('button', { name: '文件' }))
    // 标签条上是「文件」，正文在读会话档的根那一层
    expect(within(panel).getByRole('tab', { name: '文件' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    // 面板开了就落盘（点消息里的「预览」那条路也一样，见 panelStore 里"开合永远一起走"那段）
    expect(window.localStorage.getItem('kylab-chat-panel-open')).toBe('1')
    expect(listFiles).toHaveBeenCalledWith('c1', '', 'conversation')
    expect(await within(panel).findByText('a.md')).toBeInTheDocument()

    // 折叠目录懒加载：展开之前不读它那一层
    expect(listFiles).not.toHaveBeenCalledWith('c1', 'out', 'conversation')
    await user.click(within(panel).getByText('out'))
    await waitFor(() => expect(listFiles).toHaveBeenCalledWith('c1', 'out', 'conversation'))
    expect(await within(panel).findByText('b.md')).toBeInTheDocument()
  })

  it('「文件」是单例：再开一次只是激活它，不会多出一个标签', async () => {
    renderPage()
    const user = userEvent.setup()
    const panel = await openPanel(user)

    await user.click(within(panel).getByRole('button', { name: '文件' }))
    await user.click(within(panel).getByRole('button', { name: '打开' }))
    await user.click(await screen.findByRole('menuitem', { name: '文件' }))

    expect(within(panel).getAllByRole('tab')).toHaveLength(1)
    expect(within(panel).getByRole('tab', { name: '文件' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('关掉最后一个标签 = 空态那一屏，**面板不跟着收**（开合是用户自己那一位）', async () => {
    renderPage()
    const user = userEvent.setup()
    const panel = await openPanel(user)

    await user.click(within(panel).getByRole('button', { name: '文件' }))
    await user.click(within(panel).getByRole('button', { name: '关闭 文件' }))

    expect(within(panel).queryAllByRole('tab')).toHaveLength(0)
    expect(within(panel).getByRole('button', { name: '文件' })).toBeInTheDocument()
    expect(usePanelStore.getState().open).toBe(true)
  })
})

describe('标签条的键盘（←/→）与关闭的落点', () => {
  it('→ 走到下一个标签，← 走回来（到头绕回去）', async () => {
    renderPage()
    const user = userEvent.setup()
    const panel = await openPanel(user)
    await user.click(within(panel).getByRole('button', { name: '文件' }))

    /*
      第二个标签只能是**网页**那一档（本轮还没做视图，`+` 菜单里只有「文件」），
      所以这里直接摆进 store：要钉的是标签条的键盘，不是"怎么开一个网页标签"。
    */
    usePanelStore.setState((state) => ({
      tabs: [
        ...state.tabs,
        {
          id: 'web-9',
          kind: 'web',
          url: 'https://example.com',
          history: [],
          index: 0,
          title: '示例',
        },
      ],
    }))

    const filesTab = await within(panel).findByRole('tab', { name: '文件' })
    filesTab.focus()
    await user.keyboard('{ArrowRight}')
    expect(within(panel).getByRole('tab', { name: '示例' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await user.keyboard('{ArrowLeft}')
    expect(within(panel).getByRole('tab', { name: '文件' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('关掉当前标签时挪到**右邻**（没有右邻才取左邻）', async () => {
    renderPage()
    const user = userEvent.setup()
    const panel = await openPanel(user)
    await user.click(within(panel).getByRole('button', { name: '文件' }))
    usePanelStore.setState((state) => ({
      tabs: [
        ...state.tabs,
        {
          id: 'web-9',
          kind: 'web',
          url: 'https://example.com',
          history: [],
          index: 0,
          title: '示例',
        },
      ],
    }))
    usePanelStore.getState().activate('files-1')

    await user.click(within(panel).getByRole('button', { name: '关闭 文件' }))
    expect(within(panel).getByRole('tab', { name: '示例' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    // 右邻没了（只剩这一个）时关它：没有左邻也没有右邻，落到空态
    await user.click(within(panel).getByRole('button', { name: '关闭 示例' }))
    expect(within(panel).queryAllByRole('tab')).toHaveLength(0)
    expect(usePanelStore.getState().open).toBe(true)
  })
})

describe('搜索只在已展开的那几层里找', () => {
  it('给出如实说明，并且**搜不到没展开的目录里那份**', async () => {
    vi.mocked(listFiles).mockImplementation(async (_id, path = '') =>
      path === 'out'
        ? listing([
            {
              key: 'out/b.md',
              name: 'b.md',
              is_dir: false,
              size_bytes: 10,
              modified_at: null,
              kind: 'md',
            },
            {
              key: 'out/deep',
              name: 'deep',
              is_dir: true,
              size_bytes: 0,
              modified_at: null,
              kind: '',
            },
          ])
        : listing([
            { key: 'out', name: 'out', is_dir: true, size_bytes: 0, modified_at: null, kind: '' },
            {
              key: 'a.md',
              name: 'a.md',
              is_dir: false,
              size_bytes: 20,
              modified_at: null,
              kind: 'md',
            },
          ]),
    )
    renderPage()
    const user = userEvent.setup()
    const panel = await openPanel(user)
    await user.click(within(panel).getByRole('button', { name: '文件' }))

    // `out/deep` 还没展开（那一层根本没读过）——所以它里面的东西搜不到
    await user.click(within(panel).getByText('out'))
    expect(await within(panel).findByText('b.md')).toBeInTheDocument()

    await user.type(within(panel).getByRole('searchbox', { name: '搜索文件' }), 'b')
    expect(within(panel).getByText('只搜已展开的目录')).toBeInTheDocument()
    expect(within(panel).getByText('b.md')).toBeInTheDocument()
    expect(listFiles).not.toHaveBeenCalledWith('c1', 'out/deep', 'conversation')
  })
})

describe('分流：带种子的走面板，「浏览文件」仍走抽屉', () => {
  it('加号 → 浏览文件：开的还是「产物与文件」抽屉（上传与拖拽还在那儿）', async () => {
    renderPage()
    const user = userEvent.setup()
    await screen.findByRole('textbox', { name: '消息输入框' })

    await user.click(screen.getByRole('button', { name: '添加附件或技能' }))
    await user.click(await screen.findByRole('menuitem', { name: /浏览文件/ }))

    expect(await screen.findByRole('dialog', { name: /产物与文件/ })).toBeInTheDocument()
    // 面板**没被顺带打开**：两条路各开各的
    expect(screen.queryByRole('complementary', { name: '右侧面板' })).toBeNull()
  })
})

describe('开关与标签条右端（2026-10-09 那一轮）', () => {
  it('开关在**页面右上角**：关着画在那一格，开着时由标签条右端那颗顶着（同一颗，不重复）', async () => {
    const { container } = renderPage()
    const user = userEvent.setup()

    // 关着：那一格在页面那一行里（不在对话列的窄列内），位置上贴着右缘
    const corner = container.querySelector('.ch-panel-corner')
    expect(corner).not.toBeNull()
    expect(within(corner as HTMLElement).getByRole('button', { name: '打开右侧面板' })).toBe(
      screen.getByRole('button', { name: '打开右侧面板' }),
    )

    const panel = await openPanel(user)
    await user.click(within(panel).getByRole('button', { name: '文件' }))

    // 开着：全页**只有一颗**"收起"——它在标签条右端（也就是页面右上角那一格）
    const strip = panel.querySelector('.ch-panel-tabs') as HTMLElement
    expect(within(strip).getByRole('button', { name: '收起右侧面板' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '收起右侧面板' })).toHaveLength(1)
    // 那一格这时候**不画**（否则两颗会叠在同一个像素上）
    expect(container.querySelector('.ch-panel-corner')).toBeNull()
  })

  it('标签条右端是「全屏 / 收起」：全屏在最左、收起在最右', async () => {
    renderPage()
    const user = userEvent.setup()
    const panel = await openPanel(user)
    await user.click(within(panel).getByRole('button', { name: '文件' }))

    const strip = panel.querySelector('.ch-panel-tabs') as HTMLElement
    const full = within(strip).getByRole('button', { name: '全屏面板' })
    const collapse = within(strip).getByRole('button', { name: '收起右侧面板' })
    // 都在标签条右端那一段里，且"收起"排在最后（`compareDocumentPosition` 说它在后面）
    expect(full.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('「全屏」把这一行标成全屏（对话列收起、面板撑满），再点回到两列', async () => {
    const { container } = renderPage()
    const user = userEvent.setup()
    const panel = await openPanel(user)
    await user.click(within(panel).getByRole('button', { name: '文件' }))

    const row = container.querySelector('.ch-panel-host') as HTMLElement
    expect(row).toHaveAttribute('data-panel-full', 'false')

    await user.click(within(panel).getByRole('button', { name: '全屏面板' }))
    expect(row).toHaveAttribute('data-panel-full', 'true')
    // 按钮自己翻成"还原"（同一颗：它管的那件事现在开着）
    await user.click(within(panel).getByRole('button', { name: '还原面板' }))
    expect(row).toHaveAttribute('data-panel-full', 'false')
  })

  it('收起面板会顺手退出全屏（留着它下次开面板会直接跳成撑满）', async () => {
    renderPage()
    const user = userEvent.setup()
    const panel = await openPanel(user)
    await user.click(within(panel).getByRole('button', { name: '文件' }))
    await user.click(within(panel).getByRole('button', { name: '全屏面板' }))
    expect(usePanelStore.getState().full).toBe(true)

    await user.click(screen.getByRole('button', { name: '收起右侧面板' }))
    expect(usePanelStore.getState().full).toBe(false)
  })

  it('拖那条缝：往左变宽、往右变窄，松手落盘；上下限夹住（280–720）', async () => {
    renderPage()
    const user = userEvent.setup()
    const panel = await openPanel(user)
    await user.click(within(panel).getByRole('button', { name: '文件' }))

    const splitter = screen.getByRole('separator', { name: '调整面板宽度' })
    expect(usePanelStore.getState().width).toBe(380)

    /*
      指针事件用 `MouseEvent` 手工发：jsdom 里没有 `PointerEvent`，而 React 只听事件名
      （'pointerdown' / 'pointermove' / 'pointerup'），`clientX` 正是拖拽唯一的输入。
    */
    const drag = (type: string, clientX: number): void => {
      fireEvent(
        splitter,
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 300 }),
      )
    }

    drag('pointerdown', 800)
    drag('pointermove', 700)
    // 往左拖 100 → 面板宽 100
    expect(usePanelStore.getState().width).toBe(480)
    drag('pointermove', 1000)
    // 往右拖过头 → 180，被下限夹到 280
    expect(usePanelStore.getState().width).toBe(280)
    drag('pointermove', 200)
    // 往左拖过头 → 980，被上限夹到 720
    expect(usePanelStore.getState().width).toBe(720)
    drag('pointerup', 200)
    // 松手落盘：刷新之后还是这个宽度
    expect(window.localStorage.getItem(PANEL_WIDTH_KEY)).toBe('720')
  })

  it('宽度也能用键盘调（`←`/`→` 与 Home/End），一样落盘', async () => {
    renderPage()
    const user = userEvent.setup()
    const panel = await openPanel(user)
    await user.click(within(panel).getByRole('button', { name: '文件' }))

    const splitter = screen.getByRole('separator', { name: '调整面板宽度' })
    splitter.focus()
    await user.keyboard('{ArrowLeft}')
    expect(usePanelStore.getState().width).toBe(396)
    await user.keyboard('{End}')
    expect(usePanelStore.getState().width).toBe(720)
    await user.keyboard('{Home}')
    expect(usePanelStore.getState().width).toBe(280)
    expect(window.localStorage.getItem(PANEL_WIDTH_KEY)).toBe('280')
  })

  it('面板关着时没有那条缝（它只在两列并排时存在）', async () => {
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })
    expect(screen.queryByRole('separator', { name: '调整面板宽度' })).toBeNull()
  })
})

describe('一个范围：范围页签撤了，挂项目就读项目目录', () => {
  it('没挂项目 → 读会话产物目录；页面里再也没有那两个范围页签', async () => {
    renderPage()
    const user = userEvent.setup()
    const panel = await openPanel(user)
    await user.click(within(panel).getByRole('button', { name: '文件' }))

    await waitFor(() => expect(listFiles).toHaveBeenCalledWith('c1', '', 'conversation'))
    expect(within(panel).queryByRole('tab', { name: '项目文件' })).toBeNull()
    expect(within(panel).queryByRole('tab', { name: '本会话' })).toBeNull()
    // 根那层不画面包屑（那一颗根按钮随范围页签一起去掉了）
    expect(within(panel).queryByRole('button', { name: '本会话' })).toBeNull()
  })

  it('挂了项目 → 一棵树直接落在项目目录上（不必用户挑）', async () => {
    vi.mocked(getConversation).mockResolvedValue({
      ...detail(),
      workspace_id: 'w1',
    } as unknown as ConversationDetail)
    renderPage()
    const user = userEvent.setup()
    const panel = await openPanel(user)
    await user.click(within(panel).getByRole('button', { name: '文件' }))

    await waitFor(() => expect(listFiles).toHaveBeenCalledWith('c1', '', 'project'))
    expect(listFiles).not.toHaveBeenCalledWith('c1', '', 'conversation')
  })
})
