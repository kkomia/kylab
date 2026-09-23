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

// 复制这条路只关心"交给剪贴板的到底是哪段文字"（两级兜底本身由 `lib-clipboard` 钉）
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn(async () => true) }))

import { getConversation, rewindConversation, type ConversationDetail } from '@/api/conversations'
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
    await screen.findByPlaceholderText(/回车发送/)

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
    const field = screen.getByPlaceholderText(/回车发送/) as HTMLTextAreaElement
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
    await screen.findByPlaceholderText(/回车发送/)
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
    await screen.findByPlaceholderText(/回车发送/)

    await ask('/context')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))

    await act(async () => {
      box.handlers!.onCommand!({ name: 'context', text: '上下文：12% 已用', ok: true })
      box.handlers!.onDone!('', liveDone)
    })

    const panel = await screen.findByTestId('command-result')
    expect(panel).toHaveTextContent('上下文：12% 已用')
    // **没有那个字段就不猜**：不从文案里抠，也不动输入框
    expect(screen.getByPlaceholderText(/回车发送/)).toHaveValue('')
  })

  it('多行结果原样摆出来（换行不塌、等宽对齐）', async () => {
    const box = capture()
    vi.mocked(listCommands).mockResolvedValue([command('skills', '/skills')])
    renderPage()
    await screen.findByPlaceholderText(/回车发送/)

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
  /**
   * 第三批评审 A①：那个"无标签的孤立「∨」"就是这枚浮标。
   *
   * 它的名字与用途本来就有（`aria-label` / `title` 都是「回到最新」），真正坏掉的是
   * **出现时机**：本版 assistant-ui 在贴底时让回调返回 `null`，而 `createActionButton`
   * 把 `null` 接成 `disabled`——按钮不会被摘掉，于是那枚图标一直挂在最后一条消息的
   * 操作行右边，点它（此时必然贴底）又什么都不会发生。
   *
   * jsdom 不算样式（`vite.config.ts` 里 `test.css: false`），"贴底时真的看不见"由真浏览器
   * 截图作证（`.shots/batch3/02-chat.png` 无、`02-chat-scrolled-up.png` 有）；
   * 这里守的是那个状态钩子别被删掉——它就是「只在能起作用时才出现」本身。
   */
  it('「回到最新」浮标带名字，且用库给的状态钩子在贴底时不出现', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '你好'), stored('assistant', '你好呀')]),
    )
    renderPage()
    await screen.findByTestId('reply-text')

    // 名字一直在（`aria-label` + `title` 各一份）：它从来不是"无标签的图标"
    const jump = screen.getByRole('button', { name: '回到最新' })
    expect(jump).toHaveAttribute('title', '回到最新')
    // 库的"贴底"状态发生在 `disabled` 上，这一条工具类把它接成"不出现"
    expect(jump.className).toContain('disabled:hidden')
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

  it('输入卡片控制行的预算是"一行"：胶囊横内边距收窄、那一格只放比率', async () => {
    vi.mocked(getConversation).mockResolvedValue(
      detail([stored('user', '你好'), stored('assistant', '你好呀')]),
    )
    renderPage()
    await screen.findByTestId('reply-text')

    // 上下文那一格：行上放比率（有界，不会把整行顶出去），精确数字在 title 里
    const gauge = screen.getByRole('button', { name: '上下文用量' })
    expect(gauge).toHaveTextContent('上下文已用 0%')
    expect(gauge).toHaveAttribute('title', '上下文已用 0 / 0 tokens（0%）')
    // 左组与右组都带 `min-w-0`：放不下时按"字省"（省号）而不是整格换行/撑破卡片
    const left = gauge.parentElement?.previousElementSibling as HTMLElement
    expect(left.className).toContain('min-w-0')
  })

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

describe('失败的一轮（第四批评审 B①：没有出口的那句红字）', () => {
  /**
   * 拍到的那张图里，失败气泡只有一句"服务内部错误"：没有按钮、没有 toast，
   * 输入框里的字也已经被清空了——用户既看不到原因，也没有"再试一次"的路。
   * 这一节钉三件事：**人话的原因**、**重试**、**复制问题**。
   */
  it('给原因 + 「重试」；重试是**原样重发**，不回退会话（上一轮不会被删）', async () => {
    const box = capture()
    renderPage()
    await screen.findByPlaceholderText(/回车发送/)

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
    await screen.findByPlaceholderText(/回车发送/)
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
    await screen.findByPlaceholderText(/回车发送/)
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
    const field = await screen.findByPlaceholderText(/回车发送/)

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
    const field = await screen.findByPlaceholderText(/回车发送/)

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
