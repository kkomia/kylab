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
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  chatStream,
  decideApproval,
  getSuggestedQuestions,
  listCommands,
  type ChatHandlers,
} from '@/api/chat'
import { clearLiveAnchors, clearLiveTurn } from '@/features/chat/model/liveTurn'
import { ChatPage } from '@/features/chat/ChatPage'
import { useWorkspaceStore } from '@/features/layout/workspaces'

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
    getChatMode: vi.fn(async () => ({ mode: '', options: [] })),
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
  return { ...actual, uploadDocument: vi.fn(async () => ({ document_id: 'd1' })) }
})

import { getConversation, type ConversationDetail } from '@/api/conversations'

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
 * 输入并发送（回车那条路，与用户实际动作一致）。
 *
 * 先等发送键亮起来：知识库清单到手之后"默认全选"才成立（旧前端同一条），
 * 在那之前 `canSend` 是假的——这正是用户看到"按了回车没反应"的唯一时刻。
 */
async function ask(text: string): Promise<void> {
  const user = userEvent.setup()
  const field = screen.getByPlaceholderText(/回车发送/)
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
    await screen.findByPlaceholderText(/回车发送/)

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
    await screen.findByPlaceholderText(/回车发送/)

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

describe('过程面板：图标按 kind、同类工具并成一行', () => {
  it('工具步骤按 kind 出图标，同一个工具并成一行 + 次数', async () => {
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

    // 同一工具两次 → 一行「联网搜索 2 次」（合并的是入口，不是信息）
    expect(await screen.findByText('联网搜索')).toBeInTheDocument()
    expect(screen.getByText('2 次')).toBeInTheDocument()
    // 只调用一次的工具不并（那一档不该多一层点击）
    expect(screen.getByText('写笔记')).toBeInTheDocument()

    // 图标按语义种类选：检索是放大镜（search），写入是笔（write），思考是机器人（think）
    expect(document.querySelector('[data-icon="search"]')).not.toBeNull()
    expect(document.querySelector('[data-icon="write"]')).not.toBeNull()
    expect(document.querySelector('[data-icon="think"]')).not.toBeNull()

    // 展开这一组：里面每一次调用**保持原来的先后**，逐条给结论
    await userEvent.setup().click(screen.getByRole('button', { name: /联网搜索/ }))
    expect(await screen.findByText(/「芯片 出口」命中 3 条/)).toBeInTheDocument()
    expect(screen.getByText(/「光刻机」命中 5 条/)).toBeInTheDocument()
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
    await screen.findByPlaceholderText(/回车发送/)

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

describe('审批条', () => {
  it('三个按钮都在；拒绝时把理由一起交给 decideApproval', async () => {
    const box = capture()
    renderPage()
    await screen.findByPlaceholderText(/回车发送/)

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
    await screen.findByPlaceholderText(/回车发送/)
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

  it('正文里的工具调用标记按原文显示并加一句说明，不当回答渲染', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([
        stored('user', '帮我查'),
        stored('assistant', '<tool_call>{"name":"web_search","arguments":{}}</tool_call>'),
      ]),
    )
    renderPage()

    expect(
      await screen.findByText('这一段是模型写出来的工具调用标记，没有执行。'),
    ).toBeInTheDocument()
    // 原文照旧显示（那是当时真实返回的东西），只是按原文排版
    expect(screen.getByTestId('reply-raw-tools')).toHaveTextContent('<tool_call>')
    // 而且**没有**走 Markdown 那条渲染路径
    expect(screen.queryByTestId('reply-text')).toBeNull()
  })
})

describe('停止与回到最新', () => {
  it('流式期间发送键变成停止，点了之后这一轮在本页收口', async () => {
    const box = capture()
    renderPage()
    await screen.findByPlaceholderText(/回车发送/)

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

  it('默认只铺前 3 条，其余折成一行；点开才铺满；「看全文」就地看全', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '这些都说了什么'), stored('assistant', '见 [1][4]。', { sources })]),
    )
    renderPage()

    // 前三条永远显示（回答有没有依据是这一页存在的理由），多出来的折成一行
    expect(await screen.findByText('报告1.pdf')).toBeInTheDocument()
    expect(screen.getByText('报告3.pdf')).toBeInTheDocument()
    expect(screen.queryByText('报告4.pdf')).toBeNull()
    expect(screen.getByText('还有 2 条出处')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByText('还有 2 条出处'))
    expect(screen.getByText('报告5.pdf')).toBeInTheDocument()
    expect(screen.getByText('收起出处')).toBeInTheDocument()

    // 「看全文」：就地看这一段原文，不必先跳去文档页
    await user.click(
      within(screen.getByText('报告1.pdf').closest('li') as HTMLElement).getByText('看全文'),
    )
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('第 1 段的原文')
    expect(dialog).toHaveTextContent('第一章 › 第 1 页')
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
    await screen.findByPlaceholderText(/回车发送/)
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

    expect(await screen.findByPlaceholderText(/回车发送/)).toHaveValue('视力恢复的机制是什么？')
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
    const field = await screen.findByPlaceholderText(/回车发送/)

    await user.click(field)
    await user.type(field, '/')

    const option = await screen.findByRole('option', { name: /\/plan/ })
    await user.click(option)
    // 还要参数的命令只**补完**，不立刻执行——光标留给参数
    expect(field).toHaveValue('/plan ')
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
    const field = await screen.findByPlaceholderText(/回车发送/)

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

    // 出处列表里每一条都有自己的「看全文」：点第一条（编号 1 那条）
    await user.click((await screen.findAllByText('看全文'))[0])
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
    await screen.findByPlaceholderText(/回车发送/)

    // **打开之前不取数**：抽屉挂上才请求文件区（挂载即请求是这一条的另一半）
    expect(listFiles).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '添加附件或技能' }))
    await user.click(await screen.findByRole('menuitem', { name: /浏览文件/ }))

    const drawer = await screen.findByRole('dialog', { name: /产物与文件/ })
    expect(await within(drawer).findByText('季度报告.docx')).toBeInTheDocument()
    // 打开就取**根那一层**（`path` 为空 = 文件区的根，旧 `FileDrawer` 的 `load('')`）
    expect(listFiles).toHaveBeenCalledWith('c1', '')
  })

  it('开抽屉不动底下对话的滚动位置（用户看到的那一句还在原处）', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '这些都说了什么'), stored('assistant', '见 [1][2]。', { sources })]),
    )
    renderPage()
    const user = userEvent.setup()

    const viewport = await screen.findByLabelText('对话内容')
    viewport.scrollTop = 123

    await user.click((await screen.findAllByText('看全文'))[0])
    await screen.findByRole('dialog', { name: /引用原文/ })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /引用原文/ })).toBeNull())

    expect(viewport.scrollTop).toBe(123)
  })
})
