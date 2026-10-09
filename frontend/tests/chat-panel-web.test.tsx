/**
 * 面板「网页」标签的界面用例（`panel/WebTab.tsx` + agent 抓页建标签 + 抓页行尾那颗按钮）。
 *
 * 钉住的是四组**用户看得见的行为**：
 *
 * 1. **三档互斥的自动分派**（`embed-check` 说能嵌 → iframe 一档，说不能 → 阅读模式，
 *    抓不回来 → 原因 + 一条出路）——判据只能来自**挂载之前**那次探测（HTTP 错误对 iframe
 *    也是一次"成功加载"，`onError` 认不出来），所以这里同时钉"嵌入档一次都不抓正文"；
 * 2. **地址栏与 ←/→ 写的是这个标签自己的历史栈**（不是浏览器历史）；
 * 3. **agent 抓页建标签：去重、不抢焦点、面板关着时开关上出角标**；
 * 4. **抓页清单行尾那颗「在面板里打开」**，以及**原来那个 `<a>` 一个字没动**
 *    （`chat-flow.test.tsx` 那一组断言在这里再钉一遍——它是"不要动它"的证据）。
 *
 * 后两组要一条真链路（`ChatProvider` 的流订阅、`ToolchainFlow` 那一档），所以这一份
 * 也把 `ChatPage` 整页渲染起来，与 `chat-panel.test.tsx` 用同一套替身。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatHandlers, ChatStep } from '@/api/chat'

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

/*
  网页那两条端点在**这一层**替身（不打真网络）：这一份用例要验的是"哪一档按什么画"，
  而不是 `requestLocal` 的选址（那一条在 `tests/unit/api/local-call-sites.test.ts` 里钉着）。
*/
vi.mock('@/api/web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/web')>()
  return { ...actual, fetchWebPage: vi.fn(), checkWebEmbed: vi.fn() }
})

import { chatStream } from '@/api/chat'
import { getConversation, type ConversationDetail } from '@/api/conversations'
import { checkWebEmbed, fetchWebPage, type WebEmbedCheck, type WebPage } from '@/api/web'
import { clearLiveAnchors, clearLiveTurn, startChatTurn } from '@/features/chat/model/liveTurn'
import { usePanelStore, type PanelTab } from '@/features/chat/panel/panelStore'
import { SidePanel } from '@/features/chat/panel/SidePanel'
import { FetchPages } from '@/features/chat/ui/SearchHits'
import { ChatPage } from '@/features/chat/ChatPage'

const PAGE_URL = 'https://example.com/a'

function webTab(url = PAGE_URL): Extract<PanelTab, { kind: 'web' }> {
  return { id: 'web-1', kind: 'web', url, history: [url], index: 0, title: '' }
}

function page(overrides: Partial<WebPage> = {}): WebPage {
  return {
    url: PAGE_URL,
    final_url: PAGE_URL,
    title: '示例页',
    text: '# 一级标题\n\n正文第一段。',
    truncated: false,
    fetched_at: new Date().toISOString(),
    ...overrides,
  }
}

function embed(overrides: Partial<WebEmbedCheck> = {}): WebEmbedCheck {
  return {
    url: PAGE_URL,
    embeddable: false,
    reason: 'X-Frame-Options: DENY',
    x_frame_options: 'DENY',
    frame_ancestors: '',
    ...overrides,
  }
}

/** 面板那一列单独渲染（网页标签自己的事，不需要整页）。 */
function renderPanel(tab: PanelTab = webTab(), extra: PanelTab[] = []) {
  usePanelStore.setState({
    open: true,
    tabs: [tab, ...extra],
    activeId: tab.id,
    currentConversationId: 'c1',
    seed: null,
    filesView: { path: '' },
    unread: [],
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SidePanel />
    </QueryClientProvider>,
  )
}

/** 整页（agent 抓页建标签、抓页清单那两颗按钮要真链路）。 */
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

const meta = { conversationId: 'c1', query: '问一句', thinking: null }
const turnPayload = {
  query: '问一句',
  kb_ids: [],
  history: [],
  conversation_id: 'c1',
} as never

/** 抓住一轮的 handlers（与 `chat-live-mirror.test.tsx` 同一手法）。 */
function captureTurn(): { handlers: ChatHandlers | null } {
  const box: { handlers: ChatHandlers | null } = { handlers: null }
  vi.mocked(chatStream).mockImplementation(async (_payload, handlers) => {
    box.handlers = handlers
    return { abort: () => undefined }
  })
  return box
}

function fetchStep(args: string, status = 'running'): ChatStep {
  return {
    phase: 'tool',
    label: '抓取网页',
    detail: '',
    status,
    tool: 'web_fetch',
    args,
  }
}

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined
  vi.clearAllMocks()
  clearLiveTurn()
  clearLiveAnchors()
  vi.mocked(getConversation).mockResolvedValue({
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
  } as unknown as ConversationDetail)
  vi.mocked(checkWebEmbed).mockResolvedValue(embed())
  vi.mocked(fetchWebPage).mockResolvedValue(page())
  // 面板是模块级单例：每条用例开头摆回默认态（`localStorage.clear()` 清不掉内存里那一位）
  usePanelStore.setState({
    open: false,
    tabs: [],
    activeId: '',
    currentConversationId: '',
    seed: null,
    filesView: { path: '' },
    unread: [],
  })
})

describe('① 三档互斥：探测说能嵌 → 嵌入档', () => {
  it('embeddable=true 挂 iframe（sandbox / referrerPolicy / lazy 都在），且**一次都不抓正文**', async () => {
    vi.mocked(checkWebEmbed).mockResolvedValue(embed({ embeddable: true, reason: '没有这两条头' }))
    const { container } = renderPanel()

    // 探测回来之后才挂（这一档的判据是那次结论，不是 iframe 自己报错）
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const frame = container.querySelector('iframe')!
    expect(frame).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups',
    )
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(frame).toHaveAttribute('loading', 'lazy')
    expect(frame).toHaveAttribute('src', PAGE_URL)
    // 那一档画的是原页本身：抓正文那一步连请求都不发（白跑一趟还可能拉回几百 KB）
    expect(fetchWebPage).not.toHaveBeenCalled()
    // 探测是**挂载之前**那一次结论（不是等 iframe 报错）
    expect(checkWebEmbed).toHaveBeenCalledWith(PAGE_URL)
  })
})

describe('② 三档互斥：探测说不能嵌 → 阅读档', () => {
  it('渲染抓回来的正文：标题 + 诚实口径那一句 + 标签名跟着标题走', async () => {
    renderPanel()

    expect(await screen.findByText(/这是抓回来的正文，不是那个网站本身/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '一级标题' })).toBeInTheDocument()
    expect(screen.getByText('正文第一段。')).toBeInTheDocument()
    // 标签名 = 抓回来的页面标题（没抓到才退域名，见 `SidePanel.labelOf`）
    await waitFor(() => expect(screen.getByRole('tab', { name: '示例页' })).toBeInTheDocument())
    expect(fetchWebPage).toHaveBeenCalledWith(PAGE_URL)
  })

  it('被截断时如实说一句（不让用户以为文章就那么长）', async () => {
    vi.mocked(fetchWebPage).mockResolvedValue(page({ truncated: true }))
    renderPanel()

    expect(await screen.findByText(/只读了前一段/)).toBeInTheDocument()
  })

  it('正文里的图片不自动加载（降级成链接），链接点了是**标签内导航**', async () => {
    vi.mocked(fetchWebPage).mockImplementation(async (url) =>
      url === PAGE_URL
        ? page({
            text: [
              '正文。',
              '',
              '![一张图](https://cdn.example.com/a.png)',
              '',
              '[外链](https://other.example.com/x)',
            ].join('\n'),
          })
        : page({ url, final_url: url, title: '下一页', text: '换了一页。' }),
    )
    const { container } = renderPanel()
    const user = userEvent.setup()

    const image = await screen.findByRole('link', { name: '一张图' })
    expect(image).toHaveAttribute('href', 'https://cdn.example.com/a.png')
    // **一个 `<img>` 都没有**：渲染成真图就会让浏览器照那个地址去访问第三方（用户的 IP 就交出去了）
    expect(container.querySelector('img[src^="https://cdn.example.com"]')).toBeNull()

    // 点正文里的链接：面板**不跳走**，是这个标签自己换地址（写进它的历史栈）
    await user.click(screen.getByRole('link', { name: '外链' }))
    const tab = usePanelStore.getState().tabs[0] as Extract<PanelTab, { kind: 'web' }>
    expect(tab.url).toBe('https://other.example.com/x')
    expect(tab.history).toEqual([PAGE_URL, 'https://other.example.com/x'])
    expect(tab.index).toBe(1)
    expect(await screen.findByText('换了一页。')).toBeInTheDocument()
  })
})

describe('③ 三档互斥：抓不回来 → 原因 + 一条出路', () => {
  it('显示后端那句话，并给「在系统浏览器打开」（点了就是 window.open 那三个参数）', async () => {
    vi.mocked(fetchWebPage).mockRejectedValue(new Error('抓取失败：对方返回 HTTP 503'))
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderPanel()
    const user = userEvent.setup()

    expect(await screen.findByText('抓取失败：对方返回 HTTP 503')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '在系统浏览器打开这一页' }))
    expect(open).toHaveBeenCalledWith(PAGE_URL, '_blank', 'noopener,noreferrer')
    open.mockRestore()
  })

  it('**探测自己失败**时按原因 + 出路显示；但用户挑过的那一档照样作数', async () => {
    vi.mocked(checkWebEmbed).mockRejectedValue(new Error('Not Found'))
    renderPanel()
    const user = userEvent.setup()

    // 还没挑过：自动那一档拿不到结论，就把那条请求的原因摆出来（不假装能看）
    expect(await screen.findByText('Not Found')).toBeInTheDocument()

    // 挑「阅读模式」= 一条**不需要探测**的路（真机上撞到的毛病：错误那一屏原先排在
    // 所有分支最前面，于是点了它毫无反应）
    await user.click(screen.getByRole('button', { name: '更多' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '阅读模式' }))
    expect(await screen.findByText(/这是抓回来的正文，不是那个网站本身/)).toBeInTheDocument()
    expect(screen.queryByText('Not Found')).toBeNull()
  })
})

describe('④ 地址栏与 ←/→：写的是这个标签自己的历史栈', () => {
  it('只读地址栏点一下变输入框；Enter 之后换页、后退回到上一页（不新增历史）', async () => {
    renderPanel()
    const user = userEvent.setup()
    await screen.findByText(/这是抓回来的正文/)

    // 刚打开时只有这一页：后退点不动（栈的两头要看得出来）
    expect(screen.getByRole('button', { name: '后退' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '网页地址' }))
    const input = screen.getByRole('textbox', { name: '网页地址' })
    // 没写协议也算数（地址栏里手打 `other.example.com` 是常态）
    await user.clear(input)
    await user.type(input, 'other.example.com/b{Enter}')

    const tab = usePanelStore.getState().tabs[0] as Extract<PanelTab, { kind: 'web' }>
    expect(tab.url).toBe('https://other.example.com/b')
    expect(tab.history).toEqual([PAGE_URL, 'https://other.example.com/b'])
    expect(tab.index).toBe(1)

    await user.click(screen.getByRole('button', { name: '后退' }))
    const back = usePanelStore.getState().tabs[0] as Extract<PanelTab, { kind: 'web' }>
    // 退回上一页**不压新的一条**（不然越点越深）
    expect(back.history).toEqual([PAGE_URL, 'https://other.example.com/b'])
    expect(back.index).toBe(0)
    expect(back.url).toBe(PAGE_URL)
    expect(screen.getByRole('button', { name: '前进' })).toBeEnabled()
  })

  it('认不出来的地址**当场说不认**（不是让它去请求一个必然失败的地址）', async () => {
    renderPanel()
    const user = userEvent.setup()
    await screen.findByText(/这是抓回来的正文/)

    await user.click(screen.getByRole('button', { name: '网页地址' }))
    const input = screen.getByRole('textbox', { name: '网页地址' })
    await user.clear(input)
    await user.type(input, 'javascript:alert(1){Enter}')

    expect(await screen.findByText(/这个地址认不出来/)).toBeInTheDocument()
    // 还在原地：这个标签没被导航走
    expect((usePanelStore.getState().tabs[0] as Extract<PanelTab, { kind: 'web' }>).url).toBe(
      PAGE_URL,
    )
  })
})

describe('⑤ agent 抓页 → 面板标签', () => {
  it('建标签、**不抢焦点**、同一地址只建一次；面板关着时开关上出角标', async () => {
    const box = captureTurn()
    renderPage()
    const user = userEvent.setup()
    await screen.findByRole('textbox', { name: '消息输入框' })

    await act(async () => {
      void startChatTurn(turnPayload, meta)
    })
    // 面板关着、也没有当前标签：这两个位就是"有没有被抢走焦点"的读数
    expect(usePanelStore.getState().open).toBe(false)

    act(() => {
      box.handlers!.onStep!(fetchStep('{"url": "https://example.com/a"}'))
    })
    const state = usePanelStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect((state.tabs[0] as Extract<PanelTab, { kind: 'web' }>).url).toBe('https://example.com/a')
    // 不抢焦点：没开面板、没换当前标签，只记成"还没看过"
    expect(state.open).toBe(false)
    expect(state.activeId).toBe('')
    expect(state.unread).toEqual([state.tabs[0].id])

    // 同一步的 `done` 又来一次（返回里还带着同一条网址）：**不重复建标签**
    act(() => {
      box.handlers!.onStep!(fetchStep('{"url": "https://example.com/a"}', 'done'))
    })
    expect(usePanelStore.getState().tabs).toHaveLength(1)
    expect(usePanelStore.getState().unread).toHaveLength(1)

    // 第二条网址：另建一个标签
    act(() => {
      box.handlers!.onStep!(fetchStep('{"urls": ["https://example.com/b"]}'))
    })
    expect(usePanelStore.getState().tabs).toHaveLength(2)

    // 面板关着：那颗开关上要看得见"N 个新页面"（角标 + title）
    const toggle = screen.getByRole('button', { name: '打开右侧面板' })
    expect(toggle.getAttribute('title')).toContain('2 个新页面')
    expect(document.querySelector('[data-unseen]')?.textContent).toBe('2')

    // 点开那个标签就算看过（角标跟着灭）
    await user.click(toggle)
    const firstTab = usePanelStore.getState().tabs[0].id
    await user.click(screen.getAllByRole('tab', { name: /example\.com/ })[0]!) // 标签名退到域名那一档
    expect(usePanelStore.getState().unread).not.toContain(firstTab)
    // 另一个还没看过（未读是**按标签**记的，不是"面板开过就算都看过"）
    expect(usePanelStore.getState().unread).toHaveLength(1)
  })

  it('打开历史会话不会批量补标签（那一步的入参在库里也读不出来，只能靠流）', async () => {
    // 库里的消息带一条抓页步骤，但**没有一轮在流**：`live` 是空的，一条标签都不该建
    vi.mocked(getConversation).mockResolvedValue({
      id: 'c1',
      title: '旧会话',
      kb_ids: [],
      model_pk: '',
      thinking: null,
      thinking_effort: null,
      workspace_id: null,
      pinned: false,
      archived: false,
      message_count: 1,
      created_at: null,
      updated_at: null,
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '旧回答',
          sources: [],
          steps: [fetchStep('{"url": "https://example.com/old"}', 'done')],
          thinking: '',
          created_at: null,
        },
      ],
    } as unknown as ConversationDetail)
    renderPage()

    expect(await screen.findByText('旧回答')).toBeInTheDocument()
    expect(usePanelStore.getState().tabs).toEqual([])
  })
})

describe('⑥ 抓页清单行尾那颗「在面板里打开」', () => {
  const hits = [
    {
      url: 'https://moonshot.cn/news',
      title: 'Moonshot 新闻页',
      domain: 'moonshot.cn',
      site: { id: '', domain: 'moonshot.cn', name: 'moonshot.cn', badge: '' },
    },
  ]

  it('原锚点一个字没动（href / target / 内容照旧），旁边多一颗按钮', () => {
    render(<FetchPages hits={hits} />)

    const item = document.querySelector('.ch-fetch') as HTMLAnchorElement
    expect(item).toHaveAttribute('href', 'https://moonshot.cn/news')
    expect(item).toHaveAttribute('target', '_blank')
    expect(item).toHaveTextContent('https://moonshot.cn/news')
    expect(item.querySelector('.ch-hit-logo')).not.toBeNull()
    // 按钮是**兄弟**（`<a>` 里放 `<button>` 是不合法的 HTML），不在锚点里面
    const button = screen.getByRole('button', { name: '在面板里打开' })
    expect(item.contains(button)).toBe(false)
  })

  it('点它就地开面板里的网页标签（用户动作，所以抢焦点、并落盘"面板开着"）', async () => {
    render(<FetchPages hits={hits} />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '在面板里打开' }))
    const state = usePanelStore.getState()
    expect(state.open).toBe(true)
    expect(state.activeId).toBe(state.tabs[0].id)
    expect((state.tabs[0] as Extract<PanelTab, { kind: 'web' }>).url).toBe(
      'https://moonshot.cn/news',
    )
    expect(state.unread).toEqual([])
    expect(window.localStorage.getItem('kylab-chat-panel-open')).toBe('1')
  })
})

describe('⑧ 网页那一格只长在正文区（2026-10-09）', () => {
  it('空态点「网页」→ 地址框取代正文区（不是压在文件视图上的一条带子）', async () => {
    usePanelStore.setState({
      open: true,
      tabs: [
        { id: 'files-1', kind: 'files' },
        { id: 'web-1', kind: 'web', url: PAGE_URL, history: [PAGE_URL], index: 0, title: '' },
      ],
      activeId: 'files-1',
      currentConversationId: 'c1',
      seed: null,
      filesView: { path: '' },
      unread: [],
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <SidePanel />
      </QueryClientProvider>,
    )
    const user = userEvent.setup()

    // 文件标签下先有一棵树（替身给的是空清单，空态那句话就是它的证据）
    expect(
      await screen.findByText('这里还没有文件。让 Agent 做一份，或者自己上传一个。'),
    ).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '打开' }))
    await user.click(await screen.findByRole('menuitem', { name: '打开网页…' }))

    // 那一格出现，而**文件视图整块退出**：文件标签下一个"文件区"的字样都不该再有
    expect(screen.getByRole('textbox', { name: '网页地址' })).toBeTruthy()
    expect(screen.queryByText('这里还没有文件。让 Agent 做一份，或者自己上传一个。')).toBeNull()
    expect(screen.queryByRole('searchbox', { name: '搜索文件' })).toBeNull()

    // 点「取消」就回到刚在的那一档
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('textbox', { name: '网页地址' })).toBeNull()
    expect(
      await screen.findByText('这里还没有文件。让 Agent 做一份，或者自己上传一个。'),
    ).toBeTruthy()
  })

  it('开着那一格时切标签，它也一起收掉（不是半开着的状态）', async () => {
    renderPanel(webTab(), [{ id: 'files-1', kind: 'files' }])
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '打开' }))
    await user.click(await screen.findByRole('menuitem', { name: '打开网页…' }))
    expect(screen.getByRole('textbox', { name: '网页地址' })).toBeTruthy()

    await user.click(screen.getByRole('tab', { name: '文件' }))
    expect(screen.queryByRole('textbox', { name: '网页地址' })).toBeNull()
  })
})

describe('⑨ 打开过文件之后切回「网页」标签', () => {
  it('切得过去，而且**回到文件标签是文件列表**（种子不会在重新挂载时重放一遍）', async () => {
    usePanelStore.setState({
      open: true,
      tabs: [
        { id: 'files-1', kind: 'files' },
        { id: 'web-1', kind: 'web', url: PAGE_URL, history: [PAGE_URL], index: 0, title: '示例页' },
      ],
      activeId: 'web-1',
      currentConversationId: 'c1',
      seed: null,
      filesView: { path: '' },
      unread: [],
    })
    vi.mocked(checkWebEmbed).mockResolvedValue(embed())
    vi.mocked(fetchWebPage).mockResolvedValue(page())
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <SidePanel />
      </QueryClientProvider>,
    )
    const user = userEvent.setup()

    // 「预览」那条路：带种子打开文件（面板会直接落进预览态）
    await act(async () => {
      usePanelStore.getState().openFilesTab({ key: 'a.md', name: 'a.md', kind: 'md' })
    })
    expect(await screen.findByRole('button', { name: '回到文件列表' })).toBeTruthy()

    // 切回网页：切得过去（这是用户报的那一下）
    await user.click(screen.getByRole('tab', { name: '示例页' }))
    expect(await screen.findByText('一级标题')).toBeTruthy()

    // 再切回文件：**文件列表**，不是又被种子顶回预览态（那是"回不去列表"）
    await user.click(screen.getByRole('tab', { name: '文件' }))
    expect(await screen.findByRole('searchbox', { name: '搜索文件' })).toBeTruthy()
    // 这一份清单是空的，所以树那一屏挂着那句话；再空转一拍（让所有微任务落地），
    // 预览态不该被种子重新顶出来
    expect(
      await screen.findByText('这里还没有文件。让 Agent 做一份，或者自己上传一个。'),
    ).toBeTruthy()
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByRole('button', { name: '回到文件列表' })).toBeNull()
  })
})

describe('⑦ 「+」菜单 / 空态里的「网页」：原地一格输入框', () => {
  it('空态点「网页」→ 出输入框 → Enter 建标签（没写协议也认）', async () => {
    usePanelStore.setState({
      open: true,
      tabs: [],
      activeId: '',
      currentConversationId: 'c1',
      seed: null,
      filesView: { path: '' },
      unread: [],
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <SidePanel />
      </QueryClientProvider>,
    )
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '网页' }))
    const input = screen.getByRole('textbox', { name: '网页地址' })
    await user.type(input, 'example.com{Enter}')

    const tab = usePanelStore.getState().tabs[0] as Extract<PanelTab, { kind: 'web' }>
    expect(tab.url).toBe('https://example.com/')
    expect(tab.history).toEqual(['https://example.com/'])
    expect(tab.index).toBe(0)
  })
})
