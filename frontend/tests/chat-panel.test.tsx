/**
 * 对话页右侧面板的界面用例（骨架 + 文件标签）。
 *
 * 钉的是"用户看得见的那几件事"：开关（含落盘）、空态入口、标签条（单例 / 关闭 / 左右键）、
 * 文件树的懒加载、搜索只吃已展开的层，以及**「加号 → 浏览文件」仍然开抽屉**那条分流
 * （带种子的那一条走面板，见 `ChatProvider.openFiles`）。
 *
 * 排序 / 模糊匹配 / 图标分派 / 续层定位那几件纯计算在 `chat-panel-tree.test.ts` 里逐条钉
 * ——那一层盯得住细节，这一层只验"接上了"。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { clearLiveAnchors, clearLiveTurn } from '@/features/chat/model/liveTurn'
import { ChatPage } from '@/features/chat/ChatPage'
import { usePanelStore } from '@/features/chat/panel/panelStore'

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
    filesView: { scope: 'conversation', path: '' },
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
