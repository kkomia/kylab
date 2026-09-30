/**
 * 对话页（P1，A 域）——**界面那一层的用例**。
 *
 * 五条覆盖的是"用户看得见的那几件事"，每条都对着旧 `ChatView.vue` 的行为：
 *
 * 1. 发一句 → 增量 → done：回答进气泡、过程面板出步骤；
 * 2. 工具步骤按 `kind` 出图标、同一个工具并成一行 + 计数；
 * 3. **带参数的 `/plan` 出回答**：回答照常进对话流，而不是只在"只回一句"面板里
 *    （旧前端 §12.226 修的那个 bug）；
 * 4. 审批条三个按钮，**拒绝理由传给 `decideApproval`**；
 * 5. 降级（`degraded` 步骤）显示服务端给的原因；正文里的工具标记不当回答渲染。
 *
 * 网络全在 `src/api/chat` 那一层 mock 掉（`chatStream` 抓 handlers，用例自己推事件）——
 * 与 `tests/chat-model-live-turn.test.ts` 同一套手法：**事件形状就是真实那一套**，
 * 所以界面里的"事件 → 画面"这条链路是真的在跑。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, Link } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  chatStream,
  decideApproval,
  getContextUsage,
  getSuggestedQuestions,
  listCommands,
  openLiveTurn,
  type ChatHandlers,
} from '@/api/chat'
import { clearLiveAnchors, clearLiveTurn } from '@/features/chat/model/liveTurn'
import { ChatPage } from '@/features/chat/ChatPage'
import { useWorkspaceStore } from '@/features/layout/workspaces'
import { useFollowStore } from '@/features/chat/ui/followStore'
import { AssistantAvatar } from '@/features/chat/ui/AssistantAvatar'

vi.mock('@/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/chat')>()
  return {
    ...actual,
    chatStream: vi.fn(),
    openLiveTurn: vi.fn(async () => ({ abort: vi.fn() })),
    resumeStream: vi.fn(async () => ({ abort: vi.fn() })),
    decideApproval: vi.fn(async () => ({ accepted: true, detail: '' })),
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
    // 对话区上传走的是**会话文件区**（2026-09-27 用户报的："上传图片会直接传到知识库"）：
    // `uploadFile` 给个假实现，而 `@/api/documents` 的 `uploadDocument` 再也不该被调到
    // （它连 mock 都不再需要——真被调到时是真网络请求，用例会直接红）
    uploadFile: vi.fn(async () => ({ key: 'f1', name: 'a.png' })),
    listFiles: vi.fn(async () => ({
      mode: 'object',
      label: '本会话',
      path: '',
      parent: null,
      entries: [],
      truncated: false,
    })),
    createConversation: vi.fn(),
    rewindConversation: vi.fn(async () => undefined),
    ingestArtifact: vi.fn(),
    getFileUrl: vi.fn(async () => ({ url: '', expires_at: 0, name: '' })),
    downloadFile: vi.fn(async () => undefined),
  }
})

vi.mock('@/api/knowledgeBases', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/knowledgeBases')>()
  return {
    ...actual,
    listKnowledgeBases: vi.fn(async () => ({
      items: [{ id: 'kb1', name: '我的资料' }],
      total: 1,
    })),
  }
})

vi.mock('@/api/modelRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/modelRegistry')>()
  return {
    ...actual,
    getRegistry: vi.fn(async () => ({
      providers: [],
      models: [],
      slots: [],
      presets: [],
      provider_presets: [],
    })),
  }
})

vi.mock('@/api/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/settings')>()
  return {
    ...actual,
    getSettings: vi.fn(async () => ({
      groups: [],
      embedding_model_id: '',
      embedding_dim: 0,
      embedding_configured: true,
      embedding_is_development: false,
      rerank_enabled: false,
    })),
  }
})

vi.mock('@/api/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/capabilities')>()
  return { ...actual, listSkills: vi.fn(async () => ({ items: [], usable: 0 })) }
})

vi.mock('@/api/notes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/notes')>()
  return { ...actual, createNote: vi.fn(async () => ({ id: 'n1', title: 't', content_md: '' })) }
})

vi.mock('@/api/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/documents')>()
  // **失败要响**：对话区上传走的是会话文件区（2026-09-27 用户报的 bug），
  // 哪天又有人把它接回知识库，这条 mock 会当场把话说清楚
  return {
    ...actual,
    uploadDocument: vi.fn(async () => {
      throw new Error('对话区上传不该往知识库里塞文档')
    }),
  }
})

// 复制这条路只关心"交给剪贴板的到底是哪段文字"（两级兜底本身由 `lib-clipboard` 钉）
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn(async () => true) }))

import { getConversation, rewindConversation, type ConversationDetail } from '@/api/conversations'
import { useSessionStore } from '@/lib/session'
import { copyText } from '@/lib/clipboard'

/** 抓走 handlers：用例自己按需要推事件（与真实链路同一形状）。 */
function capture(): { handlers: ChatHandlers | null; abort: () => void } {
  // `abort` 的类型按契约写死（`() => void`）：`vi.fn()` 的类型是 Mock，与
  // `ChatStreamHandle.abort` 不兼容，会让 mockImplementation 报错
  const box: { handlers: ChatHandlers | null; abort: () => void } = {
    handlers: null,
    abort: () => undefined,
  }
  vi.mocked(chatStream).mockImplementation(async (_payload, handlers) => {
    box.handlers = handlers
    return { abort: box.abort }
  })
  return box
}

const liveDone = { recovered: false, detail: '' }

/** 一份"库里那条会话"的骨架（各用例只改 messages）。 */
function detail(messages: ConversationDetail['messages']): ConversationDetail {
  return {
    id: 'c1',
    title: '一条会话',
    kb_ids: ['kb1'],
    model_pk: '',
    thinking: null,
    thinking_effort: null,
    workspace_id: null,
    pinned: false,
    archived: false,
    message_count: messages.length,
    created_at: null,
    updated_at: null,
    messages,
  } as unknown as ConversationDetail
}

/** 一条库里的消息（只写用得上的字段，其余按契约给默认值）。 */
function stored(
  role: 'user' | 'assistant',
  content: string,
  extra: Record<string, unknown> = {},
): ConversationDetail['messages'][number] {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    role,
    content,
    sources: [],
    steps: [],
    thinking: '',
    created_at: null,
    ...extra,
  } as unknown as ConversationDetail['messages'][number]
}

function renderPage(route = '/chat/c1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        {/* 与 `src/app/App.tsx` 里那条路由同一条：`/chat/:conversationId?`——
            会话 id 是**路径参数**，这一页从 useParams 读它 */}
        <Routes>
          <Route path="/chat/:conversationId?" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/**
 * 带**跳转入口**的壳：用例要模拟"点侧栏里的另一条会话，再点回来"。
 *
 * 与 `renderPage` 同一套（同一条路由、同一个 provider），只是多挂两个 `<Link>`——
 * 这个 bug 只在**同一次挂载内换会话**时出现，卸载重挂（`renderPage` 再 render 一次）
 * 走的是另一条路，复现不出来。
 */
function renderNavigable() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/chat/c1']}>
        <Routes>
          <Route
            path="/chat/:conversationId?"
            element={
              <>
                <ChatPage />
                <Link to="/chat?new=1">去新对话</Link>
                <Link to="/chat/c1">回 c1</Link>
                <Link to="/chat/c2">去 c2</Link>
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/**
 * 输入并发送（回车那条路，与用户实际动作一致）。
 *
 * 先等发送键亮起来：知识库清单到手之后"默认全选"才成立（旧前端同一条），
 * 在那之前 `canSend` 是假的——这正是用户看到"按了回车没反应"的唯一时刻。
 */
async function ask(text: string): Promise<void> {
  const user = userEvent.setup()
  const field = screen.getByRole('textbox', { name: '消息输入框' })
  await user.click(field)
  await user.type(field, text)
  // 打完字之后**发送键才该亮起来**（它有话可发、且库范围有效）：
  // 那一下就是"可以发出去了"的判据，比自己去读一堆状态稳
  await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
  await user.keyboard('{Enter}')
}

beforeEach(() => {
  // jsdom 没有 `Element.prototype.scrollTo`，而 assistant-ui 的视口自动滚动会调它
  // （`tests/setup.ts` 只补了 ResizeObserver / matchMedia）。这里补一个空实现：
  // 用例不测像素级滚动，但不补的话每条都会在控制台刷一串 TypeError
  Element.prototype.scrollTo = () => undefined
  vi.clearAllMocks()
  clearLiveTurn()
  clearLiveAnchors()
  vi.mocked(listCommands).mockResolvedValue([])
  vi.mocked(getConversation).mockResolvedValue(detail([]))
})

describe('对话流（发一句 → 增量 → done）', () => {
  it('回答进气泡，过程面板出步骤', async () => {
    const box = capture()
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })

    await ask('这些资料的结论是什么？')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))

    // 提问那一刻界面上就该有那一对（提问 + 占位回答）——用户不必等模型开口
    expect(screen.getByText('这些资料的结论是什么？')).toBeInTheDocument()

    await act(async () => {
      box.handlers!.onStep!({
        phase: 'intent',
        label: '理解问题',
        detail: '',
        status: 'running',
      } as never)
      box.handlers!.onDelta!('资料里')
      box.handlers!.onDelta!('反复提到同一件事。')
    })

    const reply = screen.getByTestId('reply-text')
    expect(reply).toHaveTextContent('资料里反复提到同一件事。')

    // 过程面板：步骤行按后端给的标签显示
    expect(screen.getByText('理解问题')).toBeInTheDocument()

    await act(async () => {
      box.handlers!.onDone!('资料里反复提到同一件事。', liveDone)
    })
    expect(screen.getByTestId('reply-text')).toHaveTextContent('资料里反复提到同一件事。')
  })

  it('发送的请求里带着这一轮的范围与思考档（协议是我们自己的）', async () => {
    const box = capture()
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })

    await ask('问一句')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))

    expect(chatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        query: '问一句',
        conversation_id: 'c1',
        kb_ids: ['kb1'],
        thinking: true,
        thinking_effort: 'medium',
      }),
      expect.anything(),
    )
    expect(box.handlers).toBeTruthy()
  })
})

/**
 * 「知识库」开关与「全部 N 个」多选**合并成一颗胶囊**（2026-09-24）；
 * **2026-09-27 起触发器不再印状态**（用户："就写「知识库」，用一个打开关闭的按钮就可以了，
 * 不要显示「已关」"）。所以用例钉两件事：
 * 1. **触发器 = 开关 + 名字**：开/关只由开关的 `aria-checked` 表达，名字恒为「知识库」——
 *    一个字的状态文字都不许出现（原先那三态 `全部 N 个` / `已选 N 个` / `已关` 每变一次，
 *    这一颗的宽度就跟着跳一次）；
 * 2. **面板里改的是同一份状态**（勾选 / 全选 / 清空），并且**既有数据语义一条不动**：
 *    `kylab-chat-use-kb` 那个键与默认值、`selectedKbIds` 默认全选、按 `detail.kb_ids`
 *    非空回填、`canSend` 的门槛（开着且一个都没选 → 不许发）。
 */
describe('知识库：一颗胶囊 = 开关 + 名字，选择在面板里', () => {
  const THREE_KBS = {
    items: [
      { id: 'kb1', name: '我的资料' },
      { id: 'kb2', name: '笔记' },
      { id: 'kb3', name: '论文库' },
    ],
    total: 3,
  }

  /** 三只库 + 详情里没有 `kb_ids`（回填不介入）的对话页。 */
  async function renderWithThreeKbs(): Promise<void> {
    const { listKnowledgeBases } = await import('@/api/knowledgeBases')
    vi.mocked(listKnowledgeBases).mockResolvedValue(THREE_KBS as never)
    const conv = detail([stored('user', '在吗')])
    conv.kb_ids = []
    vi.mocked(getConversation).mockResolvedValue(conv)
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })
    // 名字现在恒为「知识库」，所以等"库清单到手"要等**面板里那几只认得出来**
    const user = userEvent.setup()
    await openPanel(user)
    await user.keyboard('{Escape}')
  }

  /** 那一颗上的**开关**（状态只从 `aria-checked` 读，与可见文本无关）。 */
  function kbSwitch(): HTMLElement {
    return screen.getByRole('switch', { name: /知识库/ })
  }

  /** 名字那一半：点它展开面板。**它自己不带任何状态**（这是这一轮改掉的东西）。 */
  function kbPill(): HTMLElement {
    return screen.getByRole('button', { name: '知识库范围' })
  }

  /** 打开面板（开关已经搬到触发器上，这一层里只剩"查哪几个"）。 */
  async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(kbPill())
    await screen.findByRole('menuitemcheckbox', { name: '我的资料' })
  }

  /** 面板里勾着的那些名字——"这一轮查哪几个"现在唯一的读数。 */
  function checkedInPanel(): string[] {
    return ['我的资料', '笔记', '论文库'].filter(
      (name) =>
        screen.getByRole('menuitemcheckbox', { name }).getAttribute('aria-checked') === 'true',
    )
  }

  it('触发器上不印状态：名字恒为「知识库」，开/关只由开关表达', async () => {
    await renderWithThreeKbs()
    const user = userEvent.setup()

    // 名字那一半逐字就是「知识库」：三态文字（全部 N 个 / 已选 N 个 / 已关）一个都不许出现
    expect(kbPill()).toHaveTextContent(/^知识库$/)
    expect(kbSwitch()).toHaveAttribute('aria-checked', 'true') // 本机没存过 → 默认开着

    // 关掉再开：只有开关动，名字一个字不变
    await user.click(kbSwitch())
    expect(kbSwitch()).toHaveAttribute('aria-checked', 'false')
    expect(kbPill()).toHaveTextContent(/^知识库$/)
    await user.click(kbSwitch())
    expect(kbSwitch()).toHaveAttribute('aria-checked', 'true')
    expect(kbPill()).toHaveTextContent(/^知识库$/)
  })

  it('换会话再点回来看过的那条：内容跟着重画（曾经会画成空白）', async () => {
    // 用户报的 bug（2026-09-27）：看一条会话 → 去新对话/别的会话 → 再点回来，
    // 只有标题换了，内容还是"新对话那一页"。两个原因叠在一起：
    // ① `appliedDetail` 那道闸（详情只画一次）换会话时没复位；
    // ② "换会话清空"那个 effect 声明在"应用详情"之后，返回看过的会话时详情命中缓存、
    //    在切换那一轮就被后面的清空擦掉。
    //
    // 路径要**照用户那条**：中间那一步是"新对话页"（`?new=1`）——那一轮没有任何 detail
    // 被应用，`appliedDetail` 还是 `c1`，所以回 c1 时会被那道闸挡住。
    // （先答 c2 再回 c1 的路径挡不住，用它当用例是假绿的：反向验证时它照样过。）
    const first = detail([stored('user', '甲问题'), stored('assistant', '甲的答案')])
    vi.mocked(getConversation).mockResolvedValue(first as never)
    renderNavigable()
    expect(await screen.findByText('甲的答案')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('link', { name: '去新对话' }))
    await waitFor(() => expect(screen.queryByText('甲的答案')).not.toBeInTheDocument())

    // 回 c1：详情从缓存里来（同一次挂载内必命中）——以前这一步是**一片空白**
    await user.click(screen.getByRole('link', { name: '回 c1' }))
    expect(await screen.findByText('甲的答案')).toBeInTheDocument()
  })

  it('对话区上传进的是**会话文件区**，不是知识库（用户报的那个 bug）', async () => {
    const { uploadFile } = await import('@/api/conversations')
    const { uploadDocument } = await import('@/api/documents')
    // 本机偏好与库都备着：**即使开着知识库、也有可选的库**，上传也不该往库里塞
    capture()
    await renderWithThreeKbs()
    const user = userEvent.setup()
    await screen.findByRole('textbox', { name: '消息输入框' })

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    await user.upload(input, file)

    // v0.55：选完**先摆在输入框里**（发送前不上传）。用户报的"直接发送、然后上传到工作区"
    // 从这里开始改：这一步之后接口一次都还没发。
    expect(vi.mocked(uploadFile)).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '移除 a.png' })).toBeInTheDocument()

    // 发送那一刻才落到**这条会话**（'c1' 是 fixture 里那条）的文件区，文件本身原样交给它
    await user.type(screen.getByRole('textbox', { name: '消息输入框' }), '看图')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(uploadFile).mock.calls[0][0]).toBe('c1')
    expect(vi.mocked(uploadFile).mock.calls[0][1]).toBe(file)
    // 知识库那条接口**一次都不许被调到**——"上传图片会直接传到知识库"就是从这里来的
    expect(vi.mocked(uploadDocument)).not.toHaveBeenCalled()
  })

  it('面板：清空之后范围空掉，这一轮**不让发**（开着且一个都没选）', async () => {
    capture()
    await renderWithThreeKbs()
    const user = userEvent.setup()
    const field = screen.getByRole('textbox', { name: '消息输入框' })

    await openPanel(user)
    await user.click(screen.getByRole('menuitem', { name: '清空' }))
    expect(checkedInPanel()).toEqual([])

    await user.keyboard('{Escape}')
    await user.click(field)
    await user.type(field, '问一句')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(chatStream).not.toHaveBeenCalled()
  })

  it('面板：全选回到全部，发出去的那一轮就是全选那几个', async () => {
    capture()
    await renderWithThreeKbs()
    const user = userEvent.setup()

    // 先清掉：不然「全选」此刻没有可做的事（全勾着时它是禁用的）
    await openPanel(user)
    await user.click(screen.getByRole('menuitem', { name: '清空' }))
    await user.click(screen.getByRole('menuitem', { name: '全选' }))
    expect(checkedInPanel()).toEqual(['我的资料', '笔记', '论文库'])
    await user.keyboard('{Escape}')

    await ask('问一句')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))
    expect(vi.mocked(chatStream).mock.calls[0][0]).toMatchObject({ kb_ids: ['kb1', 'kb2', 'kb3'] })
  })

  it('关掉开关：清单置灰但勾还留着（关掉的只是"用不用"）', async () => {
    await renderWithThreeKbs()
    const user = userEvent.setup()

    await user.click(kbSwitch())
    await openPanel(user)
    // 关掉之后清单**还在、勾也还在**，只是不让改（置灰 = 这一轮它们不生效）
    for (const name of ['我的资料', '笔记', '论文库']) {
      const item = screen.getByRole('menuitemcheckbox', { name })
      expect(item).toHaveAttribute('aria-disabled', 'true')
      expect(item).toHaveAttribute('aria-checked', 'true')
    }
    await user.keyboard('{Escape}')
    expect(kbSwitch()).toHaveAttribute('aria-checked', 'false')
    expect(kbPill()).toHaveTextContent(/^知识库$/)

    // 再打开看一眼：三个勾还都在——这就是"关掉不清空选择"
    await user.click(kbSwitch())
    await openPanel(user)
    for (const name of ['我的资料', '笔记', '论文库']) {
      expect(screen.getByRole('menuitemcheckbox', { name })).toHaveAttribute('aria-checked', 'true')
    }
  })

  it('关掉开关之后发出去的那一轮：kb_ids 是空（纯对话）', async () => {
    // 直接用本机偏好进"关"这一档（与上一个用例同一个状态，这里要的是"发出去长什么样"）
    window.localStorage.setItem('kylab-chat-use-kb', '0')
    capture()
    await renderWithThreeKbs()
    expect(kbSwitch()).toHaveAttribute('aria-checked', 'false')

    await ask('纯聊一句')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))
    // 关着 = 这一轮一个库都不查（`effectiveKbIds` 那一句），但仍然发得出去
    expect(vi.mocked(chatStream).mock.calls[0][0]).toMatchObject({ kb_ids: [] })
  })

  it('开关写进本机偏好：本机没存过时默认开着，关掉之后落 `0`（键与取值口径都没变）', async () => {
    const box = capture()
    await renderWithThreeKbs()
    const user = userEvent.setup()

    // `tests/setup.ts` 每个用例后清一次 localStorage，所以这里就是"本机没存过"
    expect(window.localStorage.getItem('kylab-chat-use-kb')).toBeNull()
    expect(kbSwitch()).toHaveAttribute('aria-checked', 'true')

    await user.click(kbSwitch())
    expect(kbSwitch()).toHaveAttribute('aria-checked', 'false')
    // 与合并前那颗开关**同一个键、同一个取值口径**（`'0'` = 关；见 `prefs.ts`）
    expect(window.localStorage.getItem('kylab-chat-use-kb')).toBe('0')
    expect(box.handlers).toBeNull()
  })

  it('本机存着 `0` 时进来就是关着，清单里的勾还都在（这条偏好读得回来）', async () => {
    window.localStorage.setItem('kylab-chat-use-kb', '0')
    await renderWithThreeKbs()

    // 关着不影响"默认全选"：清单到手之后三个都是勾上的（只是置灰不让改）
    const user = userEvent.setup()
    await openPanel(user)
    for (const name of ['我的资料', '笔记', '论文库']) {
      expect(screen.getByRole('menuitemcheckbox', { name })).toHaveAttribute('aria-checked', 'true')
    }
  })

  it('进已有会话：按 detail.kb_ids 非空回填；空列表不回填（保持默认全选）', async () => {
    const { listKnowledgeBases } = await import('@/api/knowledgeBases')
    vi.mocked(listKnowledgeBases).mockResolvedValue(THREE_KBS as never)

    // 详情里记着两个 → 这一轮的范围就是那两个（不是"全部 3 个"）
    const kept = detail([stored('user', '在吗')])
    kept.kb_ids = ['kb1', 'kb2']
    vi.mocked(getConversation).mockResolvedValue(kept)
    const first = renderPage()
    await waitFor(() => expect(kbPill()).toBeInTheDocument())
    const user = userEvent.setup()
    await openPanel(user)
    expect(checkedInPanel()).toEqual(['我的资料', '笔记'])
    await user.keyboard('{Escape}')
    first.unmount()

    // 详情里是空列表 → **不回填**（空不是一次选择，是"这条会话没记"），默认全选照旧
    const empty = detail([stored('user', '在吗')])
    empty.kb_ids = []
    vi.mocked(getConversation).mockResolvedValue(empty)
    renderPage()
    await waitFor(() => expect(kbPill()).toBeInTheDocument())
    await openPanel(user)
    expect(checkedInPanel()).toEqual(['我的资料', '笔记', '论文库'])
  })

  it('开关的滑块靠 transform 滑（原先位移写在 `left` 上，而它不在过渡属性里）', async () => {
    await renderWithThreeKbs()
    const user = userEvent.setup()

    /** 滑块 = 槽（`aria-hidden`）里那一颗。 */
    const knob = (): HTMLElement =>
      kbSwitch().querySelector('span[aria-hidden="true"] > span') as HTMLElement
    const ON = 'translate-x-[12px]'

    // `left` 恒为 2px、位移只有一档 12px（28px 的槽 − 12px 的滑块 − 两侧各 2px）。
    // 原先写的是 `left-[14px]` + `transition-all [transition:var(--transition-ui)]`，
    // 而 `--transition-ui` 里没有 `left`——点开关时滑块是"啪"地跳过去，不是滑过去
    // （同一排「思考」那颗是滑的，用户看到的正是这个不一致）。
    expect(knob().className).toContain('left-[2px]')
    expect(knob().className).toContain('transition-transform')
    expect(knob().className).not.toContain('transition-all')
    expect(knob().className).not.toContain('left-[14px]')

    const wasOn = kbSwitch().getAttribute('aria-checked') === 'true'
    expect(knob().className).toContain(wasOn ? ON : 'translate-x-0')

    // 拨一下：状态与那一档位移一起翻
    await user.click(kbSwitch())
    expect(kbSwitch()).toHaveAttribute('aria-checked', wasOn ? 'false' : 'true')
    expect(knob().className).toContain(wasOn ? 'translate-x-0' : ON)
  })

  it('面板里一条分隔线都没有：第一条就是内容（原先最上面一条孤零零的横线）', async () => {
    await renderWithThreeKbs()
    const user = userEvent.setup()
    await openPanel(user)

    const panel = screen.getByRole('menu')
    // 那条线的上面什么都没有，打开面板第一眼是一条孤零零的横线，读起来像"内容漏了一段"
    expect(panel.querySelectorAll('[role="separator"]')).toHaveLength(0)
    // 第一件东西就是「全选 / 清空」那一行动作
    expect(panel.firstElementChild).toHaveTextContent('全选')
    expect(panel.firstElementChild).toHaveTextContent('清空')
  })
})

describe('过程面板：图标按 kind、同类工具并成一行', () => {
  it('工具步骤按 kind 出图标，同一个工具并成一行（标题是与对象绑定的聚合句）', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '查一下'),
        stored('assistant', '查到了。', {
          steps: [
            { phase: 'intent', label: '理解问题', detail: '', status: 'done', kind: 'think' },
            {
              phase: 'tool',
              label: '联网搜索',
              detail: '「芯片 出口」命中 3 条',
              status: 'done',
              tool: 'web_search',
              kind: 'search',
            },
            {
              phase: 'tool',
              label: '联网搜索',
              detail: '「光刻机」命中 5 条',
              status: 'done',
              tool: 'web_search',
              kind: 'search',
            },
            {
              phase: 'tool',
              label: '写笔记',
              detail: '已建笔记「摘要」',
              status: 'done',
              tool: 'create_note',
              kind: 'write',
            },
          ],
        }),
      ]),
    )
    renderPage()

    /*
      P0 起**完成的一轮默认收起**（过程不再常驻正文），所以这一节先点开面板——
      这里钉的仍然是原来那几件事：kind → 图标、同工具并成一行、展开后逐条保序。
      点开的那一下走的是真按钮（`trace-toggle`），顺带钉住"收起态点得开"。
    */
    await userEvent.setup().click(await screen.findByTestId('trace-toggle'))

    /*
      同一工具两次 → **一行**，标题换成与对象绑定的聚合句（§12.333 的组行标题）：
      原先这里写「联网搜索 2 次」，用户看到"2 次"会以为都成功了、也不知道是对什么做的；
      现在数的是**对象**、并且把对象列出来（"合并的是入口，不是信息"仍然成立）。
      合并这件事就钉在"只有一个组头按钮"与那一句上——两次调用各占一行时，
      组头按钮一个都不会有。
    */
    expect(document.querySelectorAll('button[aria-controls^="flow-group-"]')).toHaveLength(1)
    expect(
      await screen.findByText('联网搜索 2 个关键词 · 「芯片 出口」命中 3 条、「光刻机」命中 5 条'),
    ).toBeInTheDocument()
    // 只调用一次的工具不并（那一档不该多一层点击）
    expect(screen.getByText('写笔记')).toBeInTheDocument()

    /*
      图标按语义种类选：**联网**是地球（`data-icon="web"`）、写入是笔（write）、思考是脑子（think）。
      联网那一步与"检索知识库"在后端同归 `kind=search`（都是只读 + 影响面 network），
      而 §12.334 要的是"检索 → 放大镜、联网 → 地球"，所以**图形只多一层按工具名的分档**：
      `data-icon` 报画出来的那一张（web），`data-kind` 仍然是语义种类（search）——
      两条一起钉，两个口径都不会被悄悄改掉。
    */
    expect(document.querySelector('.ch-row[data-kind="search"] [data-icon="web"]')).not.toBeNull()
    expect(document.querySelector('[data-icon="write"]')).not.toBeNull()
    expect(document.querySelector('[data-icon="think"]')).not.toBeNull()

    // 展开这一组：里面每一次调用**保持原来的先后**，逐条给结论
    await userEvent.setup().click(screen.getByRole('button', { name: /联网搜索/ }))
    // 只看组里那一块：标题上也出现了同样两个对象（那是聚合句的一部分），
    // 所以这里按容器缩进查，钉的仍然是"展开后逐条保序"
    const groupBody = document.querySelector('[id^="flow-group-"]') as HTMLElement
    expect(within(groupBody).getByText(/「芯片 出口」命中 3 条/)).toBeInTheDocument()
    expect(within(groupBody).getByText(/「光刻机」命中 5 条/)).toBeInTheDocument()
  })
})

/**
 * P0①：过程默认收起、答案常显（照 LobeHub `WorkflowCollapse`；判定在
 * `turns.ts::isTraceOpen`，接线在 `ChatProvider`）。
 *
 * 这两条走真宿主（不是桩）：要钉的正是"面板 + 宿主 + 本机记忆"这条线上有没有接错——
 * 纯函数单测与面板桩测都测不出接线被删（D19 的教训）。
 */
describe('过程面板的默认档与强制展开（P0）', () => {
  it('完成的一轮过程默认收起，但**正文照旧常显**；点一下才摊开', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '查一下'),
        stored('assistant', '查到了。', {
          steps: [
            {
              phase: 'tool',
              label: '联网搜索',
              detail: '「芯片 出口」命中 3 条',
              status: 'done',
              tool: 'web_search',
              kind: 'search',
            },
          ],
        }),
      ]),
    )
    renderPage()

    // 规则 d：回答**永远留在折叠之外**（它是面板的兄弟节点，不在那一块里）
    expect(await screen.findByTestId('reply-text')).toHaveTextContent('查到了。')
    // 默认收起：步骤行一条都不在文档里
    expect(screen.queryByText('联网搜索')).toBeNull()

    const toggle = screen.getByTestId('trace-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.setup().click(toggle)
    expect(await screen.findByText('联网搜索')).toBeInTheDocument()
  })

  /*
   * §12.335（D）：用户原话"那个记忆可以不要"——`kylab-trace-open` 与它的读写函数**整档删掉**，
   * 豁免只作用于这一轮。所以哪怕本机留着一个旧版本的"开过"（老键还躺在 localStorage 里），
   * 新打开一条会话时那一轮也该是自动折的。走真宿主，钉的正是"本机那一头有没有接线"。
   */
  it('§12.335：本机留着旧键也不影响——没点过的完成轮一律自动折', async () => {
    window.localStorage.setItem('kylab-trace-open', '1')
    try {
      vi.mocked(getConversation).mockResolvedValue(
        detail([
          stored('user', '查一下'),
          stored('assistant', '查到了。', {
            steps: [
              {
                phase: 'tool',
                label: '联网搜索',
                detail: '「芯片 出口」命中 3 条',
                status: 'done',
                tool: 'web_search',
                kind: 'search',
              },
            ],
          }),
        ]),
      )
      renderPage()

      expect(await screen.findByTestId('reply-text')).toHaveTextContent('查到了。')
      expect(screen.getByTestId('trace-toggle')).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText('联网搜索')).toBeNull()
    } finally {
      window.localStorage.clear()
    }
  })

  it('规则 c：有步骤在等人工介入时强制摊开，点标题也收不起来', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '跑一下'),
        stored('assistant', '等你确认。', {
          steps: [
            {
              phase: 'tool',
              label: '执行命令',
              detail: '等待确认',
              status: 'done',
              tool: 'run_command',
              outcome: 'awaiting',
            },
          ],
        }),
      ]),
    )
    renderPage()
    await screen.findByTestId('reply-text')

    // forceExpanded：完成的一轮也摊开（这一步说的是"卡住了，在等你"）
    const toggle = screen.getByTestId('trace-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('执行命令')).toBeInTheDocument()

    // 拒绝收起：点它还是摊着（折起来等于把"要你动手"藏进一次点击后面）
    await userEvent.setup().click(toggle)
    expect(screen.getByTestId('trace-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('执行命令')).toBeInTheDocument()
  })
})

/**
 * §12.333 约束 1：**用户手动开合过就完全听他的**。
 *
 * 这一条走**真宿主**（不是桩）：要钉的正是"他选过的那一档存在哪儿"——存在宿主上
 * （`ChatProvider` 的 `openGroups`，开与收两档都记），所以收起面板再打开、换会话再回来
 * 都还认得。P0 收尾批之前那一档是"翻转型 Set"（只记得开过），他收起一个**默认展开**
 * （还在跑）的组时那一下没地方记，回来又按默认档弹开。
 */
describe('组级开合记在宿主上（§12.333 约束 1）', () => {
  it('他展开一个跑完的组 → 换会话再回来仍然是展开的', async () => {
    /*
     * 这一条原先叫"他收起一个**还在跑**的组"：那时一个"存在库里的 `running` 步骤"
     * 会让组默认展开。2026-09-29 用户报了"回答都已经结束了为啥还显示进行中"之后，
     * 一轮结束的残留 `running` 会被收掉（`turns.settleStaleRunning`）——
     * 历史回放里**不存在**"还在跑"的组，默认档因此是收起。
     *
     * 这一条要钉的那件事没变：**用户点过的那一档记在宿主上，换会话再回来还在**。
     * 只是方向反过来（默认收起 → 他展开 → 回来仍然展开）。
     */
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '查一下'),
        stored('assistant', '查到了。', {
          steps: [
            {
              phase: 'tool',
              label: '联网搜索',
              detail: '「芯片 出口」命中 3 条',
              status: 'done',
              tool: 'web_search',
              kind: 'search',
            },
            {
              phase: 'tool',
              label: '联网搜索',
              detail: '「光刻机」命中 5 条',
              status: 'running',
              tool: 'web_search',
              kind: 'search',
            },
          ],
        }),
      ]),
    )
    renderNavigable()

    /** 组那一行与它的展开容器（组头是带 aria-controls 的那颗；标题里也会出现同样的对象）。 */
    function group() {
      const head = document.querySelector('button[aria-controls^="flow-group-"]') as HTMLElement
      const body = document.getElementById(
        head.getAttribute('aria-controls') as string,
      ) as HTMLElement
      return { head, body }
    }

    // 跑完的一轮：**块级先收起**（真链路修：原始 steps 里的残留 running 不再让它永远摊着），
    // 组级在块内默认也收起——先点块头摊开，才看得到组那一行
    expect(await screen.findByTestId('reply-text')).toHaveTextContent('查到了。')
    const user = userEvent.setup()
    await user.click(screen.getByTestId('trace-toggle'))
    expect(group().head).toHaveAttribute('aria-expanded', 'false')

    // 他展开这一组。§12.335 起"收起/展开"读的是那一块的行高与 `data-fold`
    //（内容为双向动效常驻，见 `FlowFold`），不再用"内容在不在文档里"来读。
    await user.click(group().head)
    expect(group().head).toHaveAttribute('aria-expanded', 'true')
    expect(within(group().body).getByText(/「芯片 出口」命中 3 条/)).toBeInTheDocument()

    // 换会话再回来：内容重画、块又默认收起，但**他对组选的那一档还在**
    await user.click(screen.getByRole('link', { name: '去新对话' }))
    await waitFor(() => expect(screen.queryByTestId('reply-text')).not.toBeInTheDocument())
    await user.click(screen.getByRole('link', { name: '回 c1' }))

    expect(await screen.findByTestId('reply-text')).toHaveTextContent('查到了。')
    await user.click(screen.getByTestId('trace-toggle'))
    expect(group().head).toHaveAttribute('aria-expanded', 'true')
    expect(group().body).toHaveAttribute('data-fold', 'open')
    expect(within(group().body).getByText(/「芯片 出口」命中 3 条/)).toBeInTheDocument()
  })
})

describe('斜杠命令：带参数的 /plan', () => {
  it('回答照常进对话流，而不是只在"只回一句"面板里', async () => {
    const box = capture()
    vi.mocked(listCommands).mockResolvedValue([
      {
        name: 'plan',
        summary: '先给计划再动手',
        usage: '/plan <描述>',
        group: 'builtin',
        details: [],
        argument_hint: '<描述>',
        short_circuit: true,
        shadowed_by: '',
        error: '',
        path: '',
      },
    ])
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })

    await ask('/plan 帮我整理这份资料')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))

    await act(async () => {
      // 回话是**系统的回话**（不进模型历史），它不进对话流
      box.handlers!.onCommand!({ name: 'plan', text: '已切到计划模式', ok: true })
      box.handlers!.onStep!({
        phase: 'intent',
        label: '理解问题',
        detail: '',
        status: 'done',
      } as never)
      box.handlers!.onDelta!('先看资料结构。')
      box.handlers!.onDone!('先看资料结构。', liveDone)
    })

    // ① 回答是**一条正常回答**：进气泡（`reply-text` 里）
    await waitFor(() => {
      expect(within(screen.getByTestId('reply-text')).getByText(/先看资料结构/)).toBeInTheDocument()
    })
    // ② 系统回话在输入框上沿那一块，且**回答不在里面**（这正是"只回一句"那条路的反面）
    const panel = await screen.findByTestId('command-result')
    expect(panel).toHaveTextContent('已切到计划模式')
    expect(panel).not.toHaveTextContent('先看资料结构')
    // ③ 这一轮的提问也照常留在对话流里（带参数的 /plan 就是一次普通问答）
    expect(screen.getByText('/plan 帮我整理这份资料')).toBeInTheDocument()
  })
})

describe('命令结果：回填与多行（/rewind 与 /context /status /skills）', () => {
  /** 一条命令（菜单要的那几个字段，其余按契约给默认值）。 */
  function command(name: string, usage: string, hint = '') {
    return {
      name,
      summary: `${name} 的说明`,
      usage,
      group: 'builtin' as const,
      details: [],
      argument_hint: hint,
      short_circuit: true,
      shadowed_by: '',
      error: '',
      path: '',
    }
  }

  it('/rewind 带着 refill：被撤的那句提问回填进输入框，光标在末尾且输入框拿到焦点', async () => {
    const box = capture()
    vi.mocked(listCommands).mockResolvedValue([command('rewind', '/rewind [n]', '[n]')])
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })

    await ask('/rewind 2')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))

    await act(async () => {
      box.handlers!.onCommand!({
        name: 'rewind',
        text: '已撤回最近 2 轮',
        ok: true,
        // 被撤掉的**上一句提问**：后端随结果给回来，界面原样回填
        refill: '帮我整理这份资料',
      })
      box.handlers!.onDone!('', liveDone)
    })

    // 类型收窄成 textarea：下面两条读的是**选区**（`selectionStart/End` 只在它上面有）
    const field = screen.getByRole('textbox', { name: '消息输入框' }) as HTMLTextAreaElement
    await waitFor(() => expect(field).toHaveValue('帮我整理这份资料'))
    // 「光标落在末尾 + 焦点在输入框」：用户改一版就能直接回车重发，不必先点一下
    await waitFor(() => expect(field).toHaveFocus())
    expect(field.selectionStart).toBe('帮我整理这份资料'.length)
    expect(field.selectionEnd).toBe('帮我整理这份资料'.length)
    // 回填的是**命令的那一句**，不是命令本身（输入框里不该还留着 /rewind 2）
    expect(field).not.toHaveValue('/rewind 2')
  })

  it('/rewind 撤掉的轮次：命令收尾后按库重画，被撤的那一轮从屏幕上消失', async () => {
    const box = capture()
    vi.mocked(listCommands).mockResolvedValue([command('rewind', '/rewind [n]', '[n]')])
    // 库里**被撤之前**有两轮，撤回之后只剩第一轮（这才是库里的权威那份）
    let calls = 0
    vi.mocked(getConversation).mockImplementation(async () =>
      calls++ === 0
        ? detail([
            stored('user', '第一问'),
            stored('assistant', '第一答'),
            stored('user', '被撤的这问'),
            stored('assistant', '被撤的这答'),
          ])
        : detail([stored('user', '第一问'), stored('assistant', '第一答')]),
    )
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })
    // 断言**只看消息流那一列**：回填进输入框的正是同一句话，全文查会查到自己
    const list = () => within(screen.getByTestId('message-list'))
    // 消息流那一列要等库里的历史画上来（画之前是骨架屏）
    await screen.findByTestId('message-list')
    expect(await list().findByText('被撤的这问')).toBeInTheDocument()

    await ask('/rewind 1')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))

    await act(async () => {
      box.handlers!.onCommand!({
        name: 'rewind',
        text: '已撤回最近 1 轮',
        ok: true,
        refill: '被撤的这问',
      })
      box.handlers!.onDone!('', liveDone)
    })

    // 服务端那几轮已经删了：不重读一次库，它们会一直挂在屏幕上（直到刷新）。
    await waitFor(() => expect(list().queryByText('被撤的这问')).toBeNull())
    expect(list().getByText('第一问')).toBeInTheDocument()
  })

  it('结果没有 refill 时一个字都不回填（/context 只摆结果）', async () => {
    const box = capture()
    vi.mocked(listCommands).mockResolvedValue([command('context', '/context')])
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })

    await ask('/context')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))

    await act(async () => {
      box.handlers!.onCommand!({ name: 'context', text: '上下文：12% 已用', ok: true })
      box.handlers!.onDone!('', liveDone)
    })

    const panel = await screen.findByTestId('command-result')
    expect(panel).toHaveTextContent('上下文：12% 已用')
    // **没有那个字段就不猜**：不从文案里抠，也不动输入框
    expect(screen.getByRole('textbox', { name: '消息输入框' })).toHaveValue('')
  })

  it('多行结果原样摆出来（换行不塌、等宽对齐）', async () => {
    const box = capture()
    vi.mocked(listCommands).mockResolvedValue([command('skills', '/skills')])
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })

    await ask('/skills')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))

    // 多行是**后端拼好的**：两列之间靠空格对齐，界面不许自己重排
    const text = ['可用技能 2 个：', '  摘要     1,024 tok', '  翻译     2,048 tok'].join('\n')
    await act(async () => {
      box.handlers!.onCommand!({ name: 'skills', text, ok: true })
      box.handlers!.onDone!('', liveDone)
    })

    const panel = await screen.findByTestId('command-result')
    const pre = panel.querySelector('pre')
    expect(pre).not.toBeNull()
    // 换行与空格一个字不少（多行结果塌成一行 = 这一块没用了）
    expect(pre!.textContent).toBe(text)
    // 排版：保留换行（`pre-wrap`）、等宽（数字与两列才对得齐）、
    // 放不下的长 token 在面板里折行（`break-words`，量过溢出才加的）
    expect(pre).toHaveClass('whitespace-pre-wrap')
    expect(pre).toHaveClass('font-mono')
    expect(pre).toHaveClass('break-words')
    // 面板仍然只有这一块（不新造卡片），且不是一条助手回答
    expect(screen.queryByTestId('reply-text')).toBeNull()
  })
})

describe('审批条', () => {
  it('三个按钮都在；拒绝时把理由一起交给 decideApproval', async () => {
    const box = capture()
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })

    await ask('清一下临时目录')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))

    await act(async () => {
      box.handlers!.onApproval!({
        approval_id: 'a1',
        tool: 'run_command',
        label: '执行命令',
        args: 'rm -rf /tmp/kylab',
        detail: '在隔离环境里跑，断网',
        rule: 'run_command(rm -rf /tmp/*)',
        timeout_seconds: 30,
      })
    })

    const bar = await screen.findByTestId('approval-bar')
    // 命令原文给用户**核对**，一个字都不能少
    expect(bar).toHaveTextContent('rm -rf /tmp/kylab')
    // 「这类都允许」要写下的那行规则先摆出来（不摆就是让用户盲签）
    expect(bar).toHaveTextContent('run_command(rm -rf /tmp/*)')

    const user = userEvent.setup()
    await user.type(within(bar).getByPlaceholderText(/拒绝时补一句理由/), '这条别动生产库')
    await user.click(within(bar).getByRole('button', { name: '拒绝' }))

    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith('a1', 'deny', '这条别动生产库'))
    // 决定一旦送出，确认条就收起来（后端那一头等的是它自己的超时）
    await waitFor(() => expect(screen.queryByTestId('approval-bar')).toBeNull())
  })

  it('没写理由时请求形状与加这个输入框之前逐字相同', async () => {
    const box = capture()
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })
    await ask('跑一下')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))

    await act(async () => {
      box.handlers!.onApproval!({
        approval_id: 'a2',
        tool: 'run_command',
        label: '执行命令',
        args: 'ls',
        detail: '',
        rule: '',
        timeout_seconds: 30,
      })
    })
    const bar = await screen.findByTestId('approval-bar')
    const user = userEvent.setup()
    await user.click(within(bar).getByRole('button', { name: '允许一次' }))
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith('a2', 'allow_once'))
  })
})

describe('降级与"工具标记"两种异常收尾', () => {
  it('降级把服务端给的原因原样说出来，并给「继续 / 重试」两个出口', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '把这些都查一遍'),
        stored('assistant', '先按手上的资料说。', {
          steps: [
            {
              phase: 'answer',
              label: '组织回答',
              detail: '共 9 字',
              status: 'done',
              degraded: true,
            },
          ],
        }),
      ]),
    )
    renderPage()

    expect(await screen.findByText(/这次没跑完/)).toBeInTheDocument()
    // 原因**由服务端给**（那一步的 detail），前端不写死"工具步数用尽"这类话
    expect(screen.getByText(/这次没跑完（共 9 字）/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('正文里的工具调用标记**剥离**：只剩标记时给一句说明，不把它当回答渲染', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '帮我查'),
        stored('assistant', '<tool_call>{"name":"web_search","arguments":{}}</tool_call>'),
      ]),
    )
    renderPage()

    /*
      2026-09-30 起的新口径（《对话UI-重做-设计》§5.1，用户：「调用工具思考也放到正文里面去」）：
      标记**永远不进正文**——剥掉再排（只动显示，库里的原文不改）。这一条钉三件事：
      整段都是标记时只剩一句安静的说明、标记原文一个字符都不上屏、Markdown 那条路不走空。
    */
    expect(await screen.findByTestId('reply-raw-tools')).toHaveTextContent(
      '这一轮只返回了工具调用标记，没有正文。',
    )
    expect(screen.queryByText(/web_search/)).toBeNull()
    expect(screen.queryByTestId('reply-text')).toBeNull()
  })

  it('正文里混着工具调用标记：标记剥掉、正文照常走 Markdown', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '帮我查'),
        stored(
          'assistant',
          '查到了，重点是这一条。\n<tool_call>{"name":"web_search","arguments":{"q":"x"}}</tool_call>\n引用见上。',
        ),
      ]),
    )
    renderPage()

    const reply = await screen.findByTestId('reply-text')
    expect(reply).toHaveTextContent('查到了，重点是这一条。')
    expect(reply).toHaveTextContent('引用见上。')
    expect(reply.textContent).not.toContain('tool_call')
    expect(reply.textContent).not.toContain('web_search')
  })

  it('助手头像：品牌行星标（环 + 行星点两层）；不在流式时 data-live 不挂', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '你好'), stored('assistant', '你好呀')]),
    )
    renderPage()
    await screen.findByTestId('reply-text')

    const avatar = document.querySelector('.ch-avatar')
    expect(avatar).not.toBeNull()
    // 标的两层都在：轨道椭圆（静止的轨道线）与行星点（沿轨道跑的那颗）
    expect(avatar!.querySelector('ellipse')).not.toBeNull()
    expect(avatar!.querySelector('.ch-planet')).not.toBeNull()
    expect(avatar!.querySelector('svg')).not.toBeNull()
    // 回放的历史轮：不在流式，不许带着"还在跑"的动画
    expect(avatar!).not.toHaveAttribute('data-live')
  })

  it('工具链与正文之间有灰色分隔线（Kimi 最初设计）；直接作答的那轮没有', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '查一下'),
        stored('assistant', '查到了。', {
          steps: [
            { phase: 'tool', label: '联网搜索', detail: '', status: 'done', tool: 'web_search' },
          ],
        }),
        stored('user', '你好'),
        stored('assistant', '你好呀'),
      ]),
    )
    renderPage()
    await screen.findAllByTestId('reply-text')

    // 只有"有过程"的那一轮摆线：两轮里恰好一条（直接作答不该有）
    expect(document.querySelectorAll('.ch-divider')).toHaveLength(1)
    expect(document.querySelector('.ch-divider')).toHaveAttribute('role', 'separator')
  })

  it('助手头像：卫星绕轨与呼吸**常驻**（不在流式也在跑），data-live 只留给声纳', () => {
    // 常驻（用户批注"常驻动效"）：idle 也挂着沿轨走的 SMIL——那是二版用 CSS
    // offset-path 时"卫星消失"的修法（真机复验过）
    const idle = render(<AssistantAvatar live={false} />)
    expect(idle.container.querySelector('.ch-avatar')).not.toHaveAttribute('data-live')
    expect(idle.container.querySelector('animateMotion')).not.toBeNull()
    idle.unmount()

    // 干活中：多一声纳（外圈扩散环由 `[data-live]::after` 承担）
    const live = render(<AssistantAvatar live />)
    expect(live.container.querySelector('.ch-avatar')).toHaveAttribute('data-live')
    expect(live.container.querySelector('animateMotion')).not.toBeNull()
  })
})

describe('停止与回到最新', () => {
  /**
   * 第三批评审 A①：那个"无标签的孤立「∨」"就是这枚浮标。
   *
   * **2026-09-30 重做后它换了自己的实现**（不再用 `ThreadPrimitive.ScrollToBottom`）：
   * 出不出由共享位 `followStore.atBottom` 决定（写只有一处——`ChatThread` 的跟随
   * 状态机），点它是**平滑滚过去**（Kimi 设计文档 §11；库那枚是瞬时跳）。
   *
   * jsdom 不算版面（`vite.config.ts` 里 `test.css: false`）：视口的一切尺寸都是 0，
   * 于是默认状态就是"贴底"——这一条同时钉住"贴底时浮标**不在文档里**"（不是靠
   * `disabled:hidden` 藏着），再用假尺寸把它翻成"翻上去了"，钉它出现、点它调
   * `scrollTo`。
   */
  it('「回到最新」：贴底时不渲染；翻上去才出现，点它平滑滚到底', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '你好'), stored('assistant', '你好呀')]),
    )
    renderPage()
    await screen.findByTestId('reply-text')

    // jsdom 尺寸全 0 = 贴底：浮标不出现（不是挂着禁用）
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull()

    // 把它翻成"用户翻上去了"：量"离底多远"的三个数由我们说了算。
    // **走真实入口**：滚轮向上 = 停跟随（`stopFollowing` 是所有"别抢"的同一个入口），
    // 再补一次位置读数——只发 scroll 而不停跟随的话，下一次内容增长会把人落回底部
    const viewport = screen.getByLabelText('对话内容') as HTMLDivElement
    Object.defineProperty(viewport, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(viewport, 'clientHeight', { value: 400, configurable: true })
    viewport.scrollTop = 100 // 离底 500px > 阈值
    fireEvent.wheel(viewport, { deltaY: -120 })
    fireEvent.scroll(viewport)

    const jump = await screen.findByRole('button', { name: '回到最新' })
    expect(jump).toHaveAttribute('title', '回到最新')
    // 入场：轻块那一下（ch-in）
    expect(jump.className).toContain('ch-in')

    // 共享位里交上来的就是这一只视口（静态导入：中途 `await` 会让一次 rAF
    // 把浮标收回去，抓住的节点就成了游离节点，点击再也到不了处理器）
    expect(useFollowStore.getState().viewport).toBe(viewport)

    // 点它：平滑滚到底（行为的取值也钉住——`smooth`，reduced-motion 下才是 `auto`）
    const scrollTo = vi.fn()
    Object.defineProperty(viewport, 'scrollTo', { value: scrollTo, configurable: true })
    expect(jump.isConnected).toBe(true)
    fireEvent.click(jump)
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' })
  })

  /**
   * 第三批评审 A（P0）：**输入卡片在有消息的会话里整块在折叠线以下**——想打字得先滚一下页面。
   *
   * 根因是这一列原来写死 `h-full`：它被钉在容器高度上，只要会话里有内容，这一列的
   * "内容最小高度"就超过容器，于是再也不肯让位，把输入卡片顶出视口（实测 900 的窗口：
   * 卡片落在 y=900..1054，`main.scrollHeight` 1054）。改成 `flex-1 + min-h-0` 之后，
   * 视口自己滚（`overflow-y-auto`）、输入卡片常驻底部。
   *
   * jsdom 不算版面，所以"卡片真的在视口里"由真浏览器量测作证
   * （`.shots/batch3/measure-layout.json`：900/700/1200 三档 composer 的 bottom 都等于窗口高、
   * `main.scrollHeight == main.clientHeight`）；这里守的是那两个类别被改回去——
   * 它们就是"这一列可以让位"本身（与 `misc-tasks` 里钉 `tabShape` 同一个手法）。
   */
  it('对话列可以被压缩（flex-1 + min-h-0），输入卡片在它之后、常驻在视口里', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '你好'), stored('assistant', '你好呀')]),
    )
    renderPage()
    await screen.findByTestId('reply-text')

    const thread = document.querySelector('[data-running]') as HTMLElement
    expect(thread.className).toContain('min-h-0')
    expect(thread.className).toContain('flex-1')
    // `h-full` 是那个病本身：它让这一列钉死在容器高度上、不给输入卡片让位
    expect(thread.className).not.toContain('h-full')
    // 输入卡片是它的**下一个兄弟**（同一列里紧跟着），所以"视口滚、卡片固定"
    const composer = document.querySelector('#chat-query')
    expect(thread.nextElementSibling?.contains(composer)).toBe(true)
  })

  it('权限那一颗：加号右边、知识库左边，档名从 /settings 读出来', async () => {
    // 管理员 + 设置里那一项有值，控件才渲染（读不到就不显示这个入口，与旧控件同一口径）
    useSessionStore.setState({
      currentUser: { id: 'u1', username: 'admin', name: '管理员', role: 'admin', avatar_url: '' },
      token: '',
      reloginCount: 0,
    })
    const { getSettings } = await import('@/api/settings')
    vi.mocked(getSettings).mockResolvedValueOnce({
      groups: [
        {
          key: 'chat',
          label: '聊天',
          fields: [{ key: 'chat.permission', label: '权限', type: 'select', value: 'smart' }],
        },
      ],
    } as never)
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '你好'), stored('assistant', '你好呀')]),
    )
    renderPage()
    await screen.findByTestId('reply-text')

    // 触发器上**只写档名**（用户 2026-09-28 的原话："这个权限按钮不要加权限俩字"），
    // "这是什么"留给无障碍名字（`权限：<档名>`）；位置仍然在加号与知识库之间。
    // 档名 2026-09-29 改成四档，默认档 =「默认」（智能）——这里跟着改成新档名。
    const pill = await screen.findByRole('button', { name: '权限：默认' })
    expect(pill).toHaveTextContent('默认')
    expect(pill).not.toHaveTextContent('权限')
    const siblings = [...(pill.parentElement?.children ?? [])]
    expect(siblings.indexOf(pill)).toBe(1)
  })

  it('输入卡片控制行按旧版收成三颗：+ / 知识库 / 模型，两侧都带 min-w-0', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '你好'), stored('assistant', '你好呀')]),
    )
    renderPage()
    await screen.findByTestId('reply-text')

    // 2026-09-27 收窄（用户拿着旧版截图："我觉得很简洁美观"）：「上下文用量」进了模型浮层；
    // 同一天权限轴那一次改动又把「权限」摆回这一排（用户指定：加号右边、知识库左边），
    // 而「命令执行策略」折进权限档、「模式」回到设置页。这一条钉的就是这一排的成员。
    // **D08（2026-09-28 走查）又把「上下文用量」请回了这一排**：那一格决定
    // "还能不能接着聊"，不该藏在浮层里。两次决定都记在这里：09-27 为简洁收进去、
    // 09-28 走查要求露出来（明细与压缩入口仍在浮层最底下，没有回退那一半）。
    const field = document.querySelector('#chat-query') as HTMLElement
    const card = field.parentElement as HTMLElement
    const row = [...card.querySelectorAll(':scope > div')].find((el) =>
      el.className.includes('justify-between'),
    ) as HTMLElement
    const left = row.children[0] as HTMLElement
    const right = row.children[1] as HTMLElement
    // 左组：加号 + 「知识库」那一颗（它里面是**开关 + 名字**两个可点目标，
    // 名字上不印状态文字）。`getAllByRole('button')` 只数 role=button 的，
    // 开关自己的 role 是 switch，所以这里另外单独钉一颗。
    //
    // 「权限」那一颗**要读得到设置才渲染**（读不到就不显示这个入口，与旧控件同一口径），
    // 所以它由上面那条专门的用例负责（那里给了管理员会话与 `chat.permission` 的值，
    // 并钉住"加号右边、知识库左边"这个位置）。
    expect(within(left).getAllByRole('button')).toHaveLength(2)
    expect(within(left).getByRole('button', { name: '添加附件或技能' })).toBeInTheDocument()
    expect(within(left).getByRole('button', { name: '知识库范围' })).toBeInTheDocument()
    expect(within(left).getAllByRole('switch')).toHaveLength(1)
    // 右组：模型那一格 + 发送键（各有 aria-label，这一排就这两颗）
    // 右组：模型那一格 + 发送键（各有 aria-label），外加**常驻的上下文读数**（D08）。
    // 那一颗是**只读**的一格（span，没有 aria-label），所以这里先按 aria-label 认那两颗，
    // 再单独钉它在右组里 —— 两种东西混在一个数组里比不出来。
    expect([...right.children].map((el) => el.getAttribute('aria-label')).filter(Boolean)).toEqual([
      '选择对话模型',
      '发送',
    ])
    expect(within(right).getByTestId('context-usage-chip')).toBeInTheDocument()
    // 两侧都带 `min-w-0`：放不下时按"字省"（省号）而不是整格换行/撑破卡片
    expect(left.className).toContain('min-w-0')
    expect(right.className).toContain('min-w-0')
  })

  it('上下文那一行在模型浮层里：环 + 比率，读数不许截断', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '你好'), stored('assistant', '你好呀')]),
    )
    renderPage()
    await screen.findByTestId('reply-text')

    // 它从那一排搬进了模型浮层（仍属"还能问多长"这一类），所以先开浮层
    await userEvent.setup().click(screen.getByRole('button', { name: '选择对话模型' }))
    const summary = await screen.findByText('上下文')
    const row = summary.parentElement as HTMLElement

    // 行上放**比率**（有界，不会把整行顶出去），精确数字在 title 里
    expect(row).toHaveTextContent('0%')
    expect(row).toHaveAttribute('title', '上下文已用 0 / 0 tokens（0%）')
    // 那一格的字**就是比率本身**：改前是整句「上下文已用 0%」被 59.5px 的格子截成
    // 「上下文…」（`scrollWidth` 101），百分比反而看不见；现在文案不许再只剩半句
    expect(row.querySelector('span.tabular')?.textContent).toBe('0%')
    // 环照 AI Elements 的几何：viewBox 24 / r=10 / strokeWidth=2，底圈 + 进度圈各一条
    const ring = row.querySelector('svg[role="img"]') as SVGElement
    expect(ring).toHaveAttribute('viewBox', '0 0 24 24')
    expect(ring.getAttribute('width')).toBe('16')
    const [track, progress] = Array.from(ring.querySelectorAll('circle'))
    expect(track).toHaveAttribute('r', '10')
    expect(track).toHaveAttribute('stroke-width', '2')
    expect(track).toHaveAttribute('opacity', '0.25')
    expect(progress).toHaveAttribute('opacity', '0.7')
    expect(progress).toHaveAttribute('stroke-linecap', 'round')
    // 0% → 进度圈整圈都是缺口（dashoffset 等于周长），底圈照旧画满
    expect(Number(progress.getAttribute('stroke-dashoffset'))).toBeCloseTo(2 * Math.PI * 10, 6)
    expect(Number(progress.getAttribute('stroke-dasharray'))).toBeCloseTo(2 * Math.PI * 10, 6)
  })

  it('上下文菜单：环随比率走，压缩阈值说的是**百分比**（不是 token 数）', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '你好'), stored('assistant', '你好呀')]),
    )
    vi.mocked(getContextUsage).mockResolvedValue({
      items: [{ kind: 'system', label: '系统提示', tokens: 1600, share: 0.25 }],
      used: 6400,
      total: 25600,
      ratio: 0.25,
      compress_at: 70,
      // **实际阈值**（token）：故意与 `compress_at` 不同值——这样下面那条断言能证明
      // 界面读的是 `compress_budget`，而不是又把百分比当数量打了一遍（那是早晚出过的 bug）
      compress_budget: 17920,
      estimated: true,
      note: '按字符数估算：中日韩 1 字约 1 token',
    } as never)
    renderPage()
    await screen.findByTestId('reply-text')

    // 行上读数：比率（四分之一 → 25%），环的缺口同步到 3/4 圈
    await userEvent.setup().click(screen.getByRole('button', { name: '选择对话模型' }))
    const summary = await screen.findByText('上下文')
    const gauge = summary.parentElement as HTMLElement
    await waitFor(() => expect(gauge).toHaveTextContent('25%'))
    expect(gauge).toHaveAttribute('title', '上下文已用 6,400 / 25,600 tokens（25%）')
    const progress = gauge.querySelectorAll('circle')[1]
    expect(Number(progress.getAttribute('stroke-dashoffset'))).toBeCloseTo(
      2 * Math.PI * 10 * 0.75,
      6,
    )

    // 同一格里的那句阈值（D37 起换了口径，守护的**意图**没变）：
    // 早先这里把 `compress_at`（百分比设置项）当成 token 数量打出来过——"到 70 会自动压缩"，
    // 少一个 `%`，读起来像"到 70 个 token 就压缩"。现在的口径是后端算好的**实际阈值**
    // `compress_budget`（窗口的 compress_at% 与绝对上限取小的那个），单位写清是 tokens：
    // 这样既不会有"百分比当数量"，也不会有"窗口调大之后报一个永远到不了的数"。
    expect(await screen.findByText(/到 17,920 tokens 会自动压缩/)).toBeInTheDocument()
    expect(screen.queryByText(/到 70% 会自动压缩/)).not.toBeInTheDocument()
    expect(screen.getByText(/已用 6,400 \/ 25,600 tokens/)).toBeInTheDocument()
    // 分解与估算说明跟着一起搬进来了（信息一个都没少）
    expect(screen.getByText('系统提示')).toBeInTheDocument()
    expect(screen.getByText('按字符数估算：中日韩 1 字约 1 token')).toBeInTheDocument()
  })

  it('流式期间发送键变成停止，点了之后这一轮在本页收口', async () => {
    const box = capture()
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })

    await ask('长回答')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))
    await act(async () => {
      box.handlers!.onDelta!('开头')
    })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '停止生成' }))

    // 已经流出来的部分留着——它仍然是有用的
    expect(screen.getByTestId('reply-text')).toHaveTextContent('开头')
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument())
  })
})

/**
 * 控件取值收口（`DropdownShell` 的 `MENU_PANEL` / `CONTROL_TRIGGER` 与上下文环）。
 *
 * 三条都是"一屏里别处已经有了、这一处独缺"的漏项，所以钉的是**取值本身**：
 * jsdom 不跑 CSS（`test.css = false`），"类名有没有落上去"是这一层唯一钉得住的东西。
 */
describe('控件取值收口：菜单进出场、禁用外形、环的过渡', () => {
  it('菜单面带进出场（150ms）：原先 0ms，一屏里只有菜单是凭空出现的', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '你好'), stored('assistant', '你好呀')]),
    )
    renderPage()
    await screen.findByTestId('reply-text')

    await userEvent.setup().click(screen.getByRole('button', { name: '知识库范围' }))
    const panel = await screen.findByRole('menu')
    const klass = panel.className
    expect(klass).toContain('data-[state=open]:animate-in')
    expect(klass).toContain('data-[state=open]:fade-in-0')
    expect(klass).toContain('data-[state=closed]:animate-out')
    expect(klass).toContain('data-[state=closed]:fade-out-0')
    // Kimi 式"轻滑入"：4px 从上往下（只有 fade 还是太平）
    expect(klass).toContain('data-[state=open]:slide-in-from-top-1')
    expect(klass).toContain('data-[state=closed]:slide-out-to-top-1')
    // 150ms = `--motion-fast` 那一档（弹窗 200ms、抽屉 300/500ms，菜单是"轻"的那一类）
    expect(klass).toContain('duration-150')
  })

  it('知识库胶囊展开时整颗亮一档：data-state 在内层 Trigger 上，外层用 :has() 认它', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '你好'), stored('assistant', '你好呀')]),
    )
    renderPage()
    await screen.findByTestId('reply-text')

    // 先抓住引用再点：菜单打开后 Radix 会把其余内容 aria-hidden，按角色就查不到它了
    const trigger = screen.getByRole('button', { name: '知识库范围' })
    await userEvent.setup().click(trigger)
    // 内层 Trigger 真的带着 open：外层那条 :has() 才有东西可认
    expect(trigger).toHaveAttribute('data-state', 'open')
    // 外层胶囊上挂着认它的类（审计 §6.2-10 的那条修复）
    const capsule = trigger.closest('span[class*="has-"]')
    expect(capsule).not.toBeNull()
    expect((capsule as HTMLElement).className).toContain(
      'has-[[data-state=open]]:bg-[var(--bg-hover)]',
    )
  })

  it('没有可用模型时那一颗看得出禁用（原先点下去没反应，外形却和能点的没两样）', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '你好'), stored('assistant', '你好呀')]),
    )
    renderPage()
    await screen.findByTestId('reply-text')

    // 这个文件里 `getRegistry` 的 mock 是空清单 → 模型那一格就是 `disabled`（判据在 `ModelPicker`）
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger).toBeDisabled()
    expect(trigger.className).toContain('disabled:cursor-default')
    expect(trigger.className).toContain('disabled:opacity-50')
  })

  it('上下文环的读数变化有过渡，且「减少动态效果」下直落', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '你好'), stored('assistant', '你好呀')]),
    )
    renderPage()
    await screen.findByTestId('reply-text')

    await userEvent.setup().click(screen.getByRole('button', { name: '选择对话模型' }))
    const summary = await screen.findByText('上下文')
    const ring = (summary.parentElement as HTMLElement).querySelector(
      'svg[role="img"]',
    ) as SVGElement
    const progress = ring.querySelectorAll('circle')[1]
    const klass = progress.getAttribute('class') ?? ''

    // 过渡必须落在**类**里：内联 `style` 的优先级高于任何类，`motion-reduce:transition-none`
    // 压不住写在 `style` 里的 transition（那一半会变成摆设）
    expect(klass).toContain('stroke-dashoffset')
    expect(klass).toContain('var(--motion-slow)')
    expect(klass).toContain('var(--motion-ease-inout)')
    expect(klass).toContain('motion-reduce:transition-none')
    // 起笔那一下的旋转仍在内联样式里（它不需要"减动态"那一档）
    expect(progress.getAttribute('style')).toContain('rotate(-90deg)')
  })
})

describe('出处列表与交付物（§6 的两条）', () => {
  const sources = [1, 2, 3, 4, 5].map((index) => ({
    index,
    chunk_id: `chunk-${index}`,
    document_id: `doc-${index}`,
    document_name: `报告${index}.pdf`,
    heading_path: '第一章',
    page: index,
    preview: `第 ${index} 段的原文`,
    knowledge_base_id: 'kb1',
    score: 0.9,
  }))

  it('来源收成一行（「N 个来源」）；展开铺满；点一条就地滑出原文', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '这些都说了什么'), stored('assistant', '见 [1][4]。', { sources })]),
    )
    renderPage()

    // 完成轮的工具链块默认收起，来源行在块里——先点块头摊开（这一条顺带钉住"点得开"）
    expect(screen.queryByText('报告1.pdf')).toBeNull()
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('trace-toggle'))
    // 来源行默认收起：摘要说清有几条几篇，列表一条都不铺
    const sourcesRow = await screen.findByTestId('flow-sources')
    expect(sourcesRow).toHaveTextContent('5 个来源 · 5 篇文档')
    expect(screen.queryByText('报告1.pdf')).toBeNull()

    // 展开：五条全在（滚动盒限高自己滚，不再"铺 3 条折 2 条"）
    await user.click(sourcesRow)
    expect(screen.getByText('报告1.pdf')).toBeInTheDocument()
    expect(screen.getByText('报告5.pdf')).toBeInTheDocument()

    // 点一条 → 那段原文就地滑出（不必先跳去文档页）
    await user.click(screen.getByText('报告1.pdf'))
    const drawer = await screen.findByRole('dialog', { name: /引用原文/ })
    expect(drawer).toHaveTextContent('第 1 段的原文')
    expect(drawer).toHaveTextContent('第一章 › 第 1 页')
  })

  it('交付物卡片：点「存进知识库」走显式那一步，入库后卡片改成已存', async () => {
    const artifact = {
      artifact_id: 'art1',
      name: '季度报告.docx',
      size_bytes: 2048,
      format: 'docx',
      storage: 'workspace',
      where: '工作区「我的项目」',
      path: '/data/quarter.docx',
      knowledge_base_id: '',
      document_id: '',
    }
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '导出一份'),
        stored('assistant', '已导出。', {
          steps: [
            {
              phase: 'tool',
              label: '导出文档',
              detail: '已导出',
              status: 'done',
              tool: 'export_document',
              kind: 'write',
              artifacts: [artifact],
            },
          ],
        }),
      ]),
    )
    const { ingestArtifact } = await import('@/api/conversations')
    vi.mocked(ingestArtifact).mockResolvedValue({
      ...artifact,
      knowledge_base_id: 'kb1',
      document_id: 'doc1',
    } as never)

    renderPage()

    // 交付物是**这个回合的结果**：摆在正文之后，带名字、体积与落点
    expect(await screen.findByText('季度报告.docx')).toBeInTheDocument()
    expect(screen.getByText(/2.0 KB · 工作区/)).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '存进知识库' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '我的资料' }))
    await user.click(within(dialog).getByRole('button', { name: '存进这个库' }))

    // **不让服务端替他挑库**：库里那个 id 是用户点出来的那一个
    await waitFor(() => expect(ingestArtifact).toHaveBeenCalledWith('c1', 'art1', 'kb1'))
    // 卡片上那句话与刚弹的提示是同一句（所以这里可能有两条）
    await waitFor(() =>
      expect(screen.getAllByText('已存进知识库「我的资料」').length).toBeGreaterThan(0),
    )
  })

  it('产物卡片的「下载」直接换签名链接下载（D18，2026-09-28 走查）', async () => {
    // 病灶：卡片上原先只有「预览」与「存进知识库」，想留一份到本地得先开文件抽屉再找同一条；
    // 而签名链接那套（`getFileUrl` → 临时 `<a>`）早就在 `api/conversations.ts` 里。
    const { downloadFile } = await import('@/api/conversations')
    const artifact = {
      artifact_id: 'art1',
      name: '季度报告.pdf',
      size_bytes: 2048,
      format: 'pdf',
      storage: 'object',
      where: '本会话',
      path: '',
      knowledge_base_id: '',
      document_id: '',
    }
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '导出一下'),
        stored('assistant', '已导出。', {
          steps: [
            {
              phase: 'tool',
              label: '导出文档',
              detail: '已导出',
              status: 'done',
              tool: 'export_document',
              kind: 'write',
              artifacts: [artifact],
            },
          ],
        }),
      ]),
    )

    renderPage()

    const user = userEvent.setup()
    // 下载按钮与「预览」并排（用户看着那份文件的地方就是入口）
    await user.click(await screen.findByRole('button', { name: '下载' }))

    // 产物在文件区的 key 就是 `artifact_id`：调用方不必另给名字
    await waitFor(() => expect(downloadFile).toHaveBeenCalledWith('c1', 'art1'))
  })

  it('产物卡片的「预览」开的是**文件区抽屉**，直落这一份（不再开新标签页）', async () => {
    const { getFileUrl, listFiles } = await import('@/api/conversations')
    // 产物在临时区里的 key 就是 `artifact_id`——**没有后缀**，所以抽屉要直落它，
    // 只能靠调用方一起给的名字与格式（`FileDrawer.initialEntry` 那一段的由来）
    const artifact = {
      artifact_id: 'art1',
      name: '季度报告.pdf',
      size_bytes: 2048,
      format: 'pdf',
      storage: 'object',
      where: '本会话',
      path: '',
      knowledge_base_id: '',
      document_id: '',
    }
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '导出一份'),
        stored('assistant', '已导出。', {
          steps: [
            {
              phase: 'tool',
              label: '导出文档',
              detail: '已导出',
              status: 'done',
              tool: 'export_document',
              kind: 'write',
              artifacts: [artifact],
            },
          ],
        }),
      ]),
    )
    // 这一份**不在当前这一层**（工作区里的子目录），列表里找不到——正好走 seed 那条兜底
    vi.mocked(listFiles).mockResolvedValue({
      mode: 'workspace',
      label: '工作区「我的项目」',
      path: '',
      parent: null,
      entries: [
        {
          key: 'other.md',
          name: 'other.md',
          is_dir: false,
          size_bytes: 1,
          modified_at: null,
          kind: 'md',
        },
      ],
      truncated: false,
    })
    vi.mocked(getFileUrl).mockResolvedValue({
      url: '/api/v1/conversations/c1/files/download-url?sign=art',
      expires_at: 0,
      name: '季度报告.pdf',
    })
    renderPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '预览' }))

    // 抽屉开着，标题行就是这份产物（预览态），PDF 那一档指向**换回来的签名链接**
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByText('季度报告.pdf')).toBeInTheDocument()
    const frame = await within(drawer).findByTitle('季度报告.pdf')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame).toHaveAttribute('src', '/api/v1/conversations/c1/files/download-url?sign=art')
    // 换链接用的就是产物那个 key（`artifact_id`），而且要 inline
    expect(getFileUrl).toHaveBeenCalledWith('c1', 'art1', 'inline')
    // 回到目录：列的是这一层真实的东西（产物那一份只出现在预览里）
    await user.click(within(drawer).getByRole('button', { name: '回到文件列表' }))
    expect(await within(drawer).findByText('other.md')).toBeInTheDocument()
  })

  it('「存为笔记」把这一轮问答存成一条笔记（标题是提问、正文是回答）', async () => {
    const { createNote } = await import('@/api/notes')
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '查一下'), stored('assistant', '查到了。')]),
    )
    renderPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '存为笔记' }))
    await waitFor(() =>
      expect(createNote).toHaveBeenCalledWith({
        title: '查一下',
        content_md: '查到了。',
        source_kind: 'chat',
        source_ref: 'c1',
      }),
    )
  })
})

/**
 * 第二批评审（v0.28）在对话页上**看得见**的那几件：抬头、正文节奏的锚点、
 * 发送键的禁用态、欢迎态的推荐问题、联网编号的落点。
 *
 * 这一层能验的是**结构与文案**（jsdom 不跑 CSS）：所以断言落在"有几个节点、
 * 谁的类名管什么、点下去做了什么"。像素级的对齐与颜色由 `.shots/batch2/` 的
 * 复看截图核对（这一批的验收里写着这三张图）。
 */
describe('抬头（会话标题 + 所属项目）', () => {
  it('标题常驻在消息区之上；新会话还没有标题就不占那一条', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '这些资料的结论是什么？'), stored('assistant', '反复提到同一件事。')]),
    )
    const { unmount } = renderPage()

    expect(await screen.findByText('一条会话')).toBeInTheDocument()
    unmount()

    // `?new=1` 那种新会话：没有会话 id → 没有标题 → 抬头整条不画（不占位）
    vi.mocked(getConversation).mockResolvedValue(detail([]))
    renderPage('/chat/')
    await screen.findByRole('textbox', { name: '消息输入框' })
    expect(screen.queryByText('一条会话')).toBeNull()
  })

  it('会话挂在项目下时，项目名跟在标题后面（名字来自壳那份工作区清单）', async () => {
    vi.mocked(getConversation).mockResolvedValue({
      ...detail([stored('user', '问一句'), stored('assistant', '答一句')]),
      workspace_id: 'w1',
    })
    // 壳（侧栏）启动时就加载了这份清单，这里只是把它摆成"已经加载好"的样子：
    // 对话页**不为这一行名字另发一次请求**（它只从既有数据里查）
    useWorkspaceStore.setState({
      items: [{ id: 'w1', name: '闲聊' } as never],
      loaded: true,
    })
    renderPage()

    expect(await screen.findByText('一条会话')).toBeInTheDocument()
    expect(await screen.findByText('闲聊')).toBeInTheDocument()
  })
})

describe('发送键的禁用态', () => {
  it('空输入时按住不动，且**是灰化的**（不是把品牌色减到半透明）', async () => {
    renderPage()
    const send = await screen.findByRole('button', { name: '发送' })

    expect(send).toBeDisabled()
    // 颜色类名是这一条唯一的机器可验形式：jsdom 不算样式，取值在 tokens 里
    expect(send.className).toContain('disabled:bg-[var(--button-disabled-bg)]')
    expect(send.className).toContain('disabled:text-[var(--button-disabled-text)]')
    // 形状：圆形（`--radius-send` 在 32px 的方块上就是一个圆）
    expect(send.className).toContain('rounded-[var(--radius-send)]')
  })
})

describe('欢迎态的推荐问题（A5）', () => {
  it('一条一行、左对齐；被写成一行两条的会自动拆开', async () => {
    vi.mocked(getSuggestedQuestions).mockResolvedValue({
      questions: [
        '视力恢复的机制是什么？',
        // 模型把两条写成一行（中间一个全角空格）——后端按行取，于是一条里含两条
        'Jorizzo 研究的是哪种联合阻塞？　相机暗箱中的图像投影到哪里？',
      ],
      generated: true,
    })
    renderPage('/chat/')

    // 先等后端那一批到手（它没到之前界面铺的是内置静态样例——那是另一条兜底）
    await screen.findByRole('button', { name: '视力恢复的机制是什么？' })
    const list = screen.getByTestId('suggestion-list')
    const chips = within(list).getAllByRole('button')
    // 三条：两条各自成条 + 那一行拆成两条
    expect(chips.map((item) => item.textContent)).toEqual([
      '视力恢复的机制是什么？',
      'Jorizzo 研究的是哪种联合阻塞？',
      '相机暗箱中的图像投影到哪里？',
    ])
    // 一列（不是自动折行的一排），每一条占满整行且文字左对齐
    expect(list.className).toContain('flex-col')
    expect(chips[0].className).toContain('w-full')
    expect(chips[0].className).toContain('text-left')
  })

  it('点一条就把这一句填进输入框（可以改了再发）', async () => {
    vi.mocked(getSuggestedQuestions).mockResolvedValue({
      questions: ['视力恢复的机制是什么？'],
      generated: true,
    })
    renderPage('/chat/')
    const user = userEvent.setup()

    const chip = await screen.findByRole('button', { name: '视力恢复的机制是什么？' })
    await user.click(chip)

    expect(await screen.findByRole('textbox', { name: '消息输入框' })).toHaveValue(
      '视力恢复的机制是什么？',
    )
  })
})

describe('联网编号的落点（A6）', () => {
  it('跑过联网搜索时，对不上出处的编号是**有说明的非链接**；没跑过就原样留着', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '今天的热点'),
        stored('assistant', '详见 [6][2]。', {
          steps: [
            {
              phase: 'tool',
              label: '联网搜索',
              detail: '搜到 8 条',
              status: 'done',
              tool: 'web_search',
            },
          ],
        }),
      ]),
    )
    const { unmount } = renderPage()

    await screen.findByTestId('reply-text')
    const chips = await screen.findAllByTitle('联网搜索结果，见过程面板')
    expect(chips).toHaveLength(2)
    // 不是链接、也点不动（没有 data-cite-index 的委托落点）
    expect(chips[0].tagName).toBe('SPAN')
    expect(chips[0]).not.toHaveAttribute('data-cite-index')
    unmount()

    // 没跑联网搜索：同样的正文里那些编号照旧是纯文本，不编一个来源给它
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '今天的热点'), stored('assistant', '详见 [6][2]。')]),
    )
    renderPage()
    await screen.findByTestId('reply-text')
    expect(screen.queryByTitle('联网搜索结果，见过程面板')).toBeNull()
  })
})

describe('失败的一轮（第四批评审 B①：没有出口的那句红字）', () => {
  /**
   * 拍到的那张图里，失败气泡只有一句"服务内部错误"：没有按钮、没有 toast，
   * 输入框里的字也已经被清空了——用户既看不到原因，也没有"再试一次"的路。
   * 这一节钉三件事：**人话的原因**、**重试**、**复制问题**。
   */
  it('给原因 + 「重试」；重试是**原样重发**，不回退会话（上一轮不会被删）', async () => {
    const box = capture()
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })

    await ask('这些资料的结论是什么？')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))

    await act(async () => {
      box.handlers!.onError!('服务内部错误')
    })

    const line = await screen.findByTestId('reply-error')
    // 原因在后面（那句话由后端给），前面那句是**我们**说的"这一轮没跑起来"
    expect(line).toHaveTextContent('这一轮没跑起来：服务内部错误')
    const retry = screen.getByRole('button', { name: /重试/ })
    expect(retry).toHaveAttribute('title', '把这一轮原样再发一次')
    expect(screen.getByRole('button', { name: /复制问题/ })).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(retry)

    // 第二次发出去的是**同一句提问、同一条会话**（上下文里不含失败那一轮）
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(2))
    expect(vi.mocked(chatStream).mock.calls[1][0]).toMatchObject({
      query: '这些资料的结论是什么？',
      conversation_id: 'c1',
    })
    // **不回退会话**：失败的一轮从来没落库，照 `rewindConversation` 删一轮
    // 删掉的是上一轮那条好好的回答（这一条就是"重试"与"重新生成"的分界）
    expect(rewindConversation).not.toHaveBeenCalled()
    // 失败的那一对已经从画面上撤掉了，提问只剩重发后的那一条
    expect(screen.queryByTestId('reply-error')).toBeNull()
    expect(screen.getAllByText('这些资料的结论是什么？')).toHaveLength(1)
  })

  it('网断了说人话：浏览器那串英文不端给用户', async () => {
    const box = capture()
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })
    await ask('问一句')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))

    // `fetch` 自己抛的就是这个（Chrome：Failed to fetch）
    await act(async () => {
      box.handlers!.onError!('Failed to fetch')
    })

    await waitFor(() =>
      expect(screen.getByTestId('reply-error')).toHaveTextContent(
        '这一轮没跑起来：网络没连上（这条请求没有发出去）',
      ),
    )
    expect(screen.getByTestId('reply-error').textContent).not.toContain('Failed to fetch')
  })

  it('「复制问题」把那一句提问交给剪贴板（重试也不行时的兜底）', async () => {
    const box = capture()
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })
    await ask('把这句话还给我')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))

    await act(async () => {
      box.handlers!.onError!('服务内部错误')
    })

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /复制问题/ }))

    await waitFor(() => expect(copyText).toHaveBeenCalledWith('把这句话还给我'))
    // 名字精确匹配"已复制"：提问气泡上那枚复制的名字是"已复制提问"（同一份 copiedKey）
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument()
  })
})

describe('降级的出口：继续（续跑，而不是重发）', () => {
  it('点「继续」走的是 resumeStream，改的是同一条回答', async () => {
    const { resumeStream } = await import('@/api/chat')
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '把它做完'),
        stored('assistant', '先到这里。', {
          steps: [
            {
              phase: 'answer',
              label: '组织回答',
              detail: '步数用尽',
              status: 'done',
              degraded: true,
            },
          ],
        }),
      ]),
    )
    renderPage()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '继续' }))
    await waitFor(() => expect(resumeStream).toHaveBeenCalledTimes(1))
    expect(vi.mocked(resumeStream).mock.calls[0][0]).toBe('c1')
  })
})

describe('两个菜单（`/` 与 `@`）', () => {
  it('敲 `/` 出命令菜单，点一条要参数的把用法填进输入框', async () => {
    vi.mocked(listCommands).mockResolvedValue([
      {
        name: 'plan',
        summary: '先给计划再动手',
        usage: '/plan <描述>',
        group: 'builtin',
        details: [],
        argument_hint: '<描述>',
        short_circuit: true,
        shadowed_by: '',
        error: '',
        path: '',
      },
    ])
    renderPage()
    const user = userEvent.setup()
    const field = await screen.findByRole('textbox', { name: '消息输入框' })

    await user.click(field)
    await user.type(field, '/')

    const option = await screen.findByRole('option', { name: /\/plan/ })
    await user.click(option)
    // 还要参数的命令只**补完**，不立刻执行——光标留给参数
    expect(field).toHaveValue('/plan ')
  })

  it('技能单独成组，认不出的分组落进「其它」而不是消失', async () => {
    vi.mocked(listCommands).mockResolvedValue([
      {
        name: 'rewind',
        summary: '撤回最近 N 轮问答',
        usage: '/rewind [n]',
        group: 'builtin',
        details: [],
        argument_hint: '[n]',
        short_circuit: true,
        shadowed_by: '',
        error: '',
        path: '',
      },
      {
        name: 'kylab-web',
        summary: '查网页并读页面',
        usage: '/kylab-web [任务]',
        group: 'skill',
        details: [],
        argument_hint: '',
        short_circuit: false,
        shadowed_by: '',
        error: '',
        path: '',
      },
      {
        // 后端将来再多一档时这份固定表一定晚一步——它不该被 `filter` 丢掉
        name: 'future-thing',
        summary: '还没认识的分组',
        usage: '/future-thing',
        group: 'plugin' as never,
        details: [],
        argument_hint: '',
        short_circuit: false,
        shadowed_by: '',
        error: '',
        path: '',
      },
    ])
    renderPage()
    const user = userEvent.setup()
    const field = await screen.findByRole('textbox', { name: '消息输入框' })

    await user.click(field)
    await user.type(field, '/')

    // 技能**单独一个分组标题**（不混在"内置"里），认不出的一档收在末尾「其它」
    await screen.findByRole('option', { name: /\/kylab-web/ })
    const headings = [...document.querySelectorAll('p')]
      .map((node) => node.textContent ?? '')
      .filter((text) =>
        ['内置', '自定义（你放的）', '自定义（随代码自带）', '技能', '其它'].includes(text),
      )
    expect(headings).toEqual(['内置', '技能', '其它'])
    expect(screen.getByRole('option', { name: /future-thing/ })).toBeInTheDocument()
  })

  it('敲 `@` 出引用候选（文件），点一条只把引用插进输入框', async () => {
    const { listFiles } = await import('@/api/conversations')
    vi.mocked(listFiles).mockResolvedValue({
      mode: 'workspace',
      label: '工作区',
      path: '',
      parent: null,
      entries: [
        {
          key: 'doc/report.md',
          name: 'report.md',
          is_dir: false,
          size_bytes: 1234,
          modified_at: null,
          kind: 'file',
        },
      ],
      truncated: false,
    })
    renderPage()
    const user = userEvent.setup()
    const field = await screen.findByRole('textbox', { name: '消息输入框' })

    await user.click(field)
    await user.type(field, '看看@')

    const option = await screen.findByRole('option', { name: /report\.md/ })
    await user.click(option)
    // **只插入引用，不读取内容**：内容读不读由模型自己决定
    expect(field).toHaveValue('看看@doc/report.md ')
  })
})

describe('两个抽屉（引用原文 / 产物与文件）', () => {
  /** 出处两条（点第一条的「看全文」）。 */
  const sources = [1, 2].map((index) => ({
    index,
    chunk_id: `chunk-${index}`,
    document_id: `doc-${index}`,
    document_name: `报告${index}.pdf`,
    heading_path: '第一章',
    page: index,
    preview: `第 ${index} 段的原文`,
    knowledge_base_id: 'kb1',
    score: 0.9,
  }))

  it('引用原文从右侧滑出（不是居中的弹窗），正文就是那一段原文', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '这些都说了什么'), stored('assistant', '见 [1][2]。', { sources })]),
    )
    renderPage()
    const user = userEvent.setup()

    // 来源清单里每一条都可点：摊开块 → 展开来源 → 点第一条（编号 1 那条）
    await user.click(await screen.findByTestId('trace-toggle'))
    await user.click(await screen.findByTestId('flow-sources'))
    await user.click(await screen.findByText('报告1.pdf'))
    const drawer = await screen.findByRole('dialog', { name: /引用原文/ })
    expect(drawer).toHaveTextContent('第 1 段的原文')
    expect(drawer).toHaveTextContent('第一章 › 第 1 页')
    // 抽屉的观感：贴右缘滑出（不是居中的弹窗），表面走 `--bg-overlay` 那枚令牌
    expect(drawer).toHaveClass('bg-[var(--bg-overlay)]')
    expect(drawer.className).toContain('right-0')
  })

  it('产物与文件：入口没变（加号 → 浏览文件），**打开时取数**，列出文件区', async () => {
    const { listFiles } = await import('@/api/conversations')
    vi.mocked(listFiles).mockResolvedValue({
      mode: 'object',
      label: '本会话',
      path: '',
      parent: null,
      entries: [
        {
          key: 'out/report.docx',
          name: '季度报告.docx',
          is_dir: false,
          size_bytes: 2048,
          modified_at: null,
          kind: 'docx',
        },
      ],
      truncated: false,
    })
    renderPage()
    const user = userEvent.setup()
    await screen.findByRole('textbox', { name: '消息输入框' })

    // **打开之前不取数**：抽屉挂上才请求文件区（挂载即请求是这一条的另一半）
    expect(listFiles).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '添加附件或技能' }))
    await user.click(await screen.findByRole('menuitem', { name: /浏览文件/ }))

    const drawer = await screen.findByRole('dialog', { name: /产物与文件/ })
    expect(await within(drawer).findByText('季度报告.docx')).toBeInTheDocument()
    // 打开就取**会话档的根那一层**（v0.55 的默认档：这条会话的文件，平铺）
    expect(listFiles).toHaveBeenCalledWith('c1', '', 'conversation')
  })

  it('开抽屉不动底下对话的滚动位置（用户看到的那一句还在原处）', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '这些都说了什么'), stored('assistant', '见 [1][2]。', { sources })]),
    )
    renderPage()
    const user = userEvent.setup()

    const viewport = await screen.findByLabelText('对话内容')
    viewport.scrollTop = 123

    await user.click(await screen.findByTestId('trace-toggle'))
    await user.click(await screen.findByTestId('flow-sources'))
    await user.click(await screen.findByText('报告1.pdf'))
    await screen.findByRole('dialog', { name: /引用原文/ })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /引用原文/ })).toBeNull())

    expect(viewport.scrollTop).toBe(123)
  })
})

/**
 * 用户消息**随发的附件**（v0.55）。
 *
 * 用户报的问题（原话）："对话中上传的文件，没有在我发送的对话中有文件组件标识。"
 * 后端补的是"提问身上记着带了哪几份"，这一层守的是**界面两个入口都画得出来**：
 * 刚发出去那一轮（`send` → `streamTurn`），与回看旧会话（`getConversation` 的详情）。
 */
describe('用户消息随发的附件（v0.55）', () => {
  /** 一份上传返回的文件条目（`send` 拿它拼随发附件的快照）。 */
  const GUIDE = {
    key: 'art_guide',
    name: '指南.pdf',
    is_dir: false,
    size_bytes: 448444,
    modified_at: null,
    kind: 'pdf',
  }

  it('新发一轮带附件：提问气泡里就有文件片，点它直落文件抽屉', async () => {
    const { uploadFile } = await import('@/api/conversations')
    vi.mocked(uploadFile).mockResolvedValue(GUIDE as never)
    const box = capture()
    renderPage()
    const user = userEvent.setup()
    await screen.findByRole('textbox', { name: '消息输入框' })

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File(['x'], '指南.pdf', { type: 'application/pdf' }))
    await user.type(screen.getByRole('textbox', { name: '消息输入框' }), '看这份')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))
    // 快照**只带 key** 交给后端（名字 / 类型 / 字节数由服务端按库里的记录回填）
    expect(vi.mocked(chatStream).mock.calls[0][0]).toMatchObject({
      query: '看这份',
      attachments: [{ key: 'art_guide' }],
    })
    expect(box.handlers).toBeTruthy()

    // 提问气泡下方就是这一份的文件片：名字可见、带大小
    const chip = await screen.findByRole('button', { name: '预览 指南.pdf' })
    expect(chip).toHaveAttribute('title', '指南.pdf')
    expect(chip).toHaveTextContent('437.9 KB')

    // 点它开「产物与文件」抽屉并直落这份（与产物卡片同一条路）
    await user.click(chip)
    const drawer = await screen.findByRole('dialog', { name: /指南\.pdf/ })
    expect(within(drawer).getByText('指南.pdf')).toBeInTheDocument()
  })

  it('回看已有会话：详情里带的附件同样画在提问气泡里（助手那条不画）', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '看看这份', {
          attachments: [{ key: 'art_guide', name: '指南.pdf', kind: 'pdf', size_bytes: 448444 }],
        }),
        stored('assistant', '好的'),
      ]),
    )
    renderPage()

    const chip = await screen.findByRole('button', { name: '预览 指南.pdf' })
    expect(chip).toHaveTextContent('437.9 KB')
    // 附件只在**用户消息**上：助手那条没有，所以这一页只有一个文件片
    expect(screen.getAllByRole('button', { name: /^预览 / })).toHaveLength(1)
  })
})

describe('Toast 只由壳挂（D32，2026-09-28 走查）', () => {
  it('同一条提示**只出现一次**：壳那个 + 页面（页面不许再挂一个）', async () => {
    // 必须按**真实组合**摆：壳的 `<Toaster/>` 与页面一起。只挂页面的话重复根本复现不出来
    // （第一版就是这么写的，反向验证时它**没红**——那不是用例，是个装饰）。
    const { Toaster } = await import('@/ui/sonner')
    const { notifyError } = await import('@/features/misc/shared/toast')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/chat/c1']}>
          <Routes>
            <Route
              path="/chat/:conversationId?"
              element={
                <>
                  <Toaster />
                  <ChatPage />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByRole('textbox', { name: '消息输入框' })

    await act(async () => {
      notifyError('这条通知只该出现一次')
    })

    // 壳那一个容器在，**页面不许再挂第二个**。走查实测（两个都挂时）：
    // `[data-sonner-toaster]` = 2、`[data-sonner-toast]` = 2 —— 同一条提示显示两遍。
    // 判据取**这一条唯一文案出现的次数**（而不是数容器）：sonner 挂在 portal 里，
    // 数全局 DOM 会把同一文件里先前用例留下的东西一起算进来（第一版单独跑绿、整文件跑红）。
    // 文案是这条用例独有的，所以 1 就是 1。
    await waitFor(() => expect(screen.getAllByText('这条通知只该出现一次')).toHaveLength(1))
  })
})

describe('输入法合成态（D05，2026-09-28 走查）', () => {
  const PLAN = {
    name: 'plan',
    summary: '先给计划再动手',
    usage: '/plan <描述>',
    group: 'builtin',
    details: [],
    argument_hint: '<描述>',
    short_circuit: true,
    shadowed_by: '',
    error: '',
    path: '',
  }

  /** 打开 `/` 菜单（有匹配项时回车才会被菜单"选中"）。 */
  async function openSlashMenu() {
    vi.mocked(listCommands).mockResolvedValue([PLAN] as never)
    renderPage()
    const field = await screen.findByRole('textbox', { name: '消息输入框' })
    await userEvent.setup().type(field, '/')
    await waitFor(() => expect(screen.getAllByText(/plan/).length).toBeGreaterThan(0))
    return field as HTMLTextAreaElement
  }

  it('合成态的回车**不选菜单项**：输入法选词那一下不该把「/」改写成命令', async () => {
    // 病灶（复核实测）：菜单开着时按一次合成态回车，输入框从 `/` 变成 `/compact`
    // —— 用户在打中文，菜单却把那一下当成了"选中"。
    const field = await openSlashMenu()

    fireEvent.keyDown(field, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true })

    expect(field).toHaveValue('/')
  })

  it('对照：非合成态的回车照旧选中菜单项（别把功能一起关掉）', async () => {
    const field = await openSlashMenu()

    fireEvent.keyDown(field, { key: 'Enter', code: 'Enter', isComposing: false })

    await waitFor(() => expect(field.value).not.toBe('/'))
  })
})

describe('首字之前正文区不空着（D27，2026-09-28 走查）', () => {
  it('流式中且还没有正文 → 正文区给一句"正在生成…"；首字一到就撤掉', async () => {
    // 病灶（走查实测）：长文提问后 1s / 3s / 9s 三个采样点，正文区都是
    // `replyTextLen = 0`、`replyTextChildElements = 0`——那一栏**完全是空白**，
    // 同时只有过程面板在动（走查现场抓到的 `lastAssistantText` 是"正在处理…｜深度思考｜
    // 正在生成回答"，都在面板里；其中"正在处理…"那句由 `liveLine` 给的实时文案
    // **后来按用户要求整条删掉了**，面板里那些步骤标签照旧在——那一行现在写的是
    // 一个静态短标签，见 `chat-trace-step-row.test.tsx`）。
    const box = capture()
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })
    await ask('写一篇长文')

    // 还没有任何正文：那一栏要有落点
    await waitFor(() =>
      expect(within(screen.getByTestId('reply-text')).getByText('正在生成…')).toBeInTheDocument(),
    )

    await act(async () => {
      box.handlers!.onDelta!('开头')
    })

    // 首字到了：那句话撤掉，正文接管
    await waitFor(() => {
      expect(within(screen.getByTestId('reply-text')).queryByText('正在生成…')).toBeNull()
      expect(screen.getByTestId('reply-text')).toHaveTextContent('开头')
    })
  })
})

/**
 * 「刷新接回来的那一轮」（D10，2026-09-28 走查）。
 *
 * 走查原话："回来只剩最后一条回答：已经发生过的步骤、出处、思考全没了，
 * 过程的『进行中』也看不出来。"真浏览器（`.shots/d10-recover.cjs`）量到的两个洞：
 *
 * 1. **工具阶段整段空白**：`recover` 那条支路原先只认正文（理由写在 `mirrorLive` 上：
 *    "有正文就等于这一轮还活着"），可补发里**正文增量是不重放的**——于是"步骤已经跑过
 *    好几步、正文一个字还没出"的那几秒里，消息区里什么都没有（实测：刷新后 4.6 秒内
 *    消息数是 0），过程面板根本不在文档里，那一轮看起来像没了；
 * 2. **收尾之后提问不回来**：补出来的那条只有回答（提问随落库才有），而"详情只画一次"
 *    那道闸让收尾后的重读白读——库里明明有提问，画面到下次刷新为止都只剩回答。
 *
 * 下面两条各钉一个。**刷新本身** jsdom 复现不了，交给真浏览器那支探针。
 */
describe('刷新接回来的那一轮（D10，2026-09-28 走查）', () => {
  /**
   * 让这一页走"接回来"那条路：库里的详情此刻还没有这一轮（后端只在跑完时落库），
   * 补发的那条流由用例自己推——与真链路同一形状。
   */
  function captureLive(): () => ChatHandlers {
    const box: { handlers: ChatHandlers | null } = { handlers: null }
    vi.mocked(openLiveTurn).mockImplementation(async (_id, _after, handlers) => {
      box.handlers = handlers
      return { abort: () => undefined }
    })
    return () => box.handlers!
  }

  it('工具阶段（正文一个字都没出）：步骤与「进行中」也必须在画面上', async () => {
    vi.mocked(getConversation).mockResolvedValue(detail([]))
    const live = captureLive()
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })
    await waitFor(() => expect(openLiveTurn).toHaveBeenCalled())

    // 补发的那几条：一段思考 + 一条跑完的步骤 + 一条还在跑的步骤，**没有正文增量**
    await act(async () => {
      live().onSeq!(4)
      live().onThinking!('先看一眼库里有什么', { logSeq: 2 })
      live().onStep!({
        phase: 'tool',
        label: '查看文件',
        detail: 'pyproject.toml',
        status: 'done',
        tool: 'read_file',
      } as never)
      live().onStep!({
        phase: 'tool',
        label: '联网搜索',
        detail: '',
        status: 'running',
        tool: 'web_search',
      } as never)
    })

    // "已经发生过的步骤"仍在
    expect(screen.getByText('查看文件')).toBeInTheDocument()
    // "还在跑的那一步"也在（面板进行中就该摊开，见 `isTraceOpen`）
    expect(screen.getByText('联网搜索')).toBeInTheDocument()
    // 「进行中」看得出来：输入框那一格是「停止生成」，线程根上也标着在跑
    expect(screen.getByRole('button', { name: '停止生成' })).toBeInTheDocument()
    expect(document.querySelector('[data-running]')).toHaveAttribute('data-running', 'true')
  })

  it('刷新一条**刚跑完**的会话：补发的那一圈不会再补出一条回答', async () => {
    // 与上面那条成对：库里那一轮**已经画在画面上了**（刷新前它就落库了），而环形缓冲里
    // 那一轮还在（十分钟）——补发会把同一轮的步骤再送一遍。上面那条修好之后，
    // `recover` 支路会照"有内容就补"再补一条回答出来，这一条钉的是"多出来的那条要收掉"。
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '这些资料的结论是什么？'),
        stored('assistant', '资料里反复提到同一件事。', {
          steps: [{ phase: 'tool', label: '查看文件', detail: '', status: 'done' }],
        }),
      ]),
    )
    const live = captureLive()
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })
    await waitFor(() => expect(openLiveTurn).toHaveBeenCalled())
    await screen.findByText('这些资料的结论是什么？')

    // 补发的步骤先到（单独一次渲染）：`recover` 支路补出那一条回答
    await act(async () => {
      live().onStep!({
        phase: 'tool',
        label: '查看文件',
        detail: '',
        status: 'done',
        tool: 'read_file',
      } as never)
    })
    // 收尾那条到（补发到的是"已经收尾"）：正文落到多出来的那一条上
    await act(async () => {
      live().onDone!('资料里反复提到同一件事。', {
        recovered: true,
        detail: '这一轮已经收尾了：补发到此为止（正文增量不重发，这里给的是完整答复）。',
      })
    })

    // 库里那份是权威的：多出来的那一条被收掉——提问与回答各一份
    await waitFor(() => expect(screen.getAllByTestId('reply-text')).toHaveLength(1))
    expect(screen.getAllByText('这些资料的结论是什么？')).toHaveLength(1)
  })
})

describe('失败气泡的「重试」（D35，2026-09-28 走查）', () => {
  /** 让当前这一轮失败（走的是界面上那条收尾路：`onError`）。 */
  async function fail(box: { handlers: ChatHandlers | null }) {
    await act(async () => {
      box.handlers!.onError!('这一轮没跑起来：网络没连上')
    })
  }

  it('两条都失败之后，**第一个**失败气泡也有「重试」', async () => {
    // 病灶：那个按钮原先还挂着 `isLastTurn`，于是"非最后一轮"的失败只剩「复制问题」
    // ——而用户看到的正是一条可以再试一次的失败。
    const first = capture()
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })
    await ask('第一问')
    await fail(first)

    const second = capture()
    await ask('第二问')
    await fail(second)

    const rows = await screen.findAllByTestId('reply-error')
    expect(rows).toHaveLength(2)
    // 每个失败气泡后面紧跟的那一行就是它的按钮组（见 MessageView 的结构）
    const firstButtons = rows[0].nextElementSibling as HTMLElement
    expect(within(firstButtons).getByRole('button', { name: '重试' })).toBeInTheDocument()
    // 标题里把代价说清楚：后面还有一轮，重试会把它一起撤掉
    expect(within(firstButtons).getByRole('button', { name: '重试' })).toHaveAttribute(
      'title',
      expect.stringContaining('后面的 1 轮'),
    )
  })

  it('重试一个**前面**的失败轮次时，把后面已落库的轮次从库里一起撤掉', async () => {
    // 失败的那一轮从来没落过库，所以它自己不用删；但它后面**成功过**的轮次必须在库里
    // 一起撤掉——本地切掉而库里留着，一刷新那几轮又冒出来，与新发的这一轮错位。
    const box = capture()
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })
    await ask('第一问')
    await fail(box)

    const second = capture()
    await ask('第二问')
    await act(async () => {
      second.handlers!.onDelta!('答')
      second.handlers!.onDone!('答', liveDone)
    })
    // 第二轮成功 = 已落库
    await waitFor(() => expect(screen.getAllByTestId('reply-error')).toHaveLength(1))

    vi.mocked(rewindConversation).mockClear()
    const rows = screen.getAllByTestId('reply-error')
    const buttons = rows[0].nextElementSibling as HTMLElement
    await userEvent.setup().click(within(buttons).getByRole('button', { name: '重试' }))

    // 第二问、答 两轮之后被撤掉 —— 计数是 1（那一轮已落库）
    await waitFor(() => expect(rewindConversation).toHaveBeenCalledWith('c1', 1))
  })
})

describe('上下文分解能看"本轮注入了什么"（D09，2026-09-28 走查）', () => {
  it('点一项的标题 → 摊开那一段实际文本；再点一下收起', async () => {
    vi.mocked(getContextUsage).mockResolvedValue({
      items: [
        {
          kind: 'system_prompt',
          label: '系统提示词',
          chars: 1378,
          tokens: 1378,
          share: 0.62,
          preview: '你是 KYLAB。\n下面是你的身份与长期设定……',
        },
        { kind: 'other', label: '其它', chars: 328, tokens: 328, share: 0.15, preview: '' },
      ],
      used: 11008,
      total: 1_000_000,
      ratio: 0.011,
      compress_at: 70,
      compress_budget: 700000,
      estimated: true,
      note: '按字符数估算：中日韩 1 字约 1 token',
    } as never)
    renderPage()
    // 等输入框 = 这一页真的挂上了（这条用例不关心消息，所以不等回答气泡）
    await screen.findByRole('textbox', { name: '消息输入框' })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '选择对话模型' }))

    const toggle = await screen.findByRole('button', { name: '系统提示词：看本轮注入了什么' })
    expect(screen.queryByTestId('context-part-preview-system_prompt')).not.toBeInTheDocument()

    await user.click(toggle)

    const preview = await screen.findByTestId('context-part-preview-system_prompt')
    expect(preview).toHaveTextContent('你是 KYLAB')

    // 再点一下收起
    await user.click(toggle)
    await waitFor(() =>
      expect(screen.queryByTestId('context-part-preview-system_prompt')).not.toBeInTheDocument(),
    )
    // 没有 preview 的那一项**不摆入口**（"其它"只有数字）
    expect(screen.queryByRole('button', { name: '其它：看本轮注入了什么' })).not.toBeInTheDocument()
  })
})

describe('上下文读数常驻可见（D08，2026-09-28 走查）', () => {
  it('**不点开模型菜单**就能看到占用读数', async () => {
    // 病灶：读数原先只活在「模型」浮层里 —— 用户不点开就完全不知道"这一轮还剩多少上下文"
    vi.mocked(getContextUsage).mockResolvedValue({
      items: [],
      used: 11008,
      total: 1_000_000,
      ratio: 0.011,
      compress_at: 70,
      compress_budget: 700000,
      estimated: true,
      note: '按字符数估算',
    } as never)

    renderPage()

    const chip = await screen.findByTestId('context-usage-chip')
    // 悬停里给全量口径（个位数的 token 读数）——**等读数回来**再断言
    // （读数是异步取的，刚挂上那一刻 title 还是兜底那句「上下文用量」）
    await waitFor(() =>
      expect(chip).toHaveAttribute('title', expect.stringContaining('上下文已用')),
    )
    // 而浮层里那一行（`ContextSummary`）**没有被渲染** —— 说明这一颗真的在常驻区
    expect(screen.queryByText('上下文')).not.toBeInTheDocument()
  })
})

describe('发送链路的异常流（D28，2026-09-28 走查；报告自己的建议是"补自动化用例"）', () => {
  it('网络中断：流**直接 reject** → 也是人话的失败气泡，且「重试」在', async () => {
    // 走查把这条列为"未测"。实现上它走的是 `liveTurn.begin()` 的 catch
    // （`failWith(cause.message)`）——这条用例把它钉住：
    // 网络断了不等于"什么都没发生"，用户必须看得到原因与出口。
    vi.mocked(chatStream).mockRejectedValueOnce(new Error('Failed to fetch'))
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })

    await ask('这些资料说什么？')

    const line = await screen.findByTestId('reply-error')
    // `failureText` 会把浏览器那串英文翻成人话（`NETWORK_FAILURES` 那张表）——
    // 这正是"网络中断时的发送失败提示"该有的样子，所以这里钉的是**那句人话**
    expect(line).toHaveTextContent('这一轮没跑起来：网络没连上（这条请求没有发出去）')
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /复制问题/ })).toBeInTheDocument()
  })

  it('后端 5xx：文案就是后端给的那句，不换成"请稍后重试"', async () => {
    // `api/chat.ts` 对非 2xx 是 `throw errorFromResponse(response)` —— 那句已经是人话，
    // 界面**不许**再包一层（包了就丢掉了"是哪一侧出的问题"）。
    vi.mocked(chatStream).mockRejectedValueOnce(new Error('服务内部错误（500）'))
    renderPage()
    await screen.findByRole('textbox', { name: '消息输入框' })

    await ask('这些资料说什么？')

    const line = await screen.findByTestId('reply-error')
    expect(line).toHaveTextContent('这一轮没跑起来：服务内部错误（500）')
  })

  it('超长：输入框自带 maxLength（32000），超过的字进不来', async () => {
    // D06 把上限定在 32000，这里钉的是"打字那条路也受它管"
    // （粘贴那条路另有用例：超限直接拒收并给提示）。
    renderPage()
    const field = await screen.findByRole('textbox', { name: '消息输入框' })

    expect(field).toHaveAttribute('maxlength', '32000')
  })
})
