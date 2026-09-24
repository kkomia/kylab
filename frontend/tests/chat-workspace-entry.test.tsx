/**
 * 项目入口新建与 `@` 里的知识库（v0.42，第七条产品意见的落地）。
 *
 * 三件事在这里钉住，都是**行为上分得清的**：
 *
 * 1. **`/chat?new=1&workspace=<id>`**：建会话时把项目带下去（`workspace_id`），
 *    并把项目绑的库**当作这一轮的库范围**（与后端"继承工作区的库"那条链路对齐，
 *    页面上那颗「知识库」胶囊当场跟着变）——不这么做，第一轮查的是"输入框里原来的
 *    那些（默认全部）"，而输入框随后按详情回填成项目绑的那几个，两处对不上；
 * 2. **不带项目的入口维持原样**：把输入框里选的那几个记进会话（下次打开按它回填）；
 * 3. **`@` 菜单里的「知识库」**：选中 = 点一下并进检索范围（不插文本、不预读），
 *    提示说清"可以取消"，且开关关着时顺手打开（否则点了等于没点）。
 *
 * 这些用例都走**真的组件树**（`ChatPage`），只有网络那一层是 mock 的——
 * 事件形状、发送载荷的拼装、回填的时机与真实链路同源。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { chatStream, getContextUsage, getSuggestedQuestions, listCommands } from '@/api/chat'
import { ChatPage } from '@/features/chat/ChatPage'
import { clearLiveAnchors, clearLiveTurn } from '@/features/chat/model/liveTurn'
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
      items: [
        { id: 'kb1', name: '城市建成环境研究现状', document_count: 23 },
        { id: 'kb2', name: '笔记', document_count: 5 },
      ],
      total: 2,
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

import { createConversation, getConversation, type ConversationDetail } from '@/api/conversations'
import type { ChatHandlers } from '@/api/chat'
import type { Workspace } from '@/api/workspaces'

const createConversationMock = vi.mocked(createConversation)
const getConversationMock = vi.mocked(getConversation)

const WORKSPACE: Workspace = {
  id: 'w1',
  name: '闲聊',
  root_path: '/srv/chat',
  description: '',
  kb_ids: [],
  conversation_count: 3,
  created_at: null,
  updated_at: null,
}

/** 抓走 handlers：用例只关心"发出去的那一版载荷长什么样"。 */
function capture(): { payloads: Record<string, unknown>[] } {
  const payloads: Record<string, unknown>[] = []
  vi.mocked(chatStream).mockImplementation(async (payload, handlers: ChatHandlers) => {
    payloads.push(payload as unknown as Record<string, unknown>)
    void handlers
    return { abort: () => undefined }
  })
  return { payloads }
}

function conversation(kbIds: string[]): ConversationDetail {
  return {
    id: 'c1',
    title: '一条会话',
    kb_ids: kbIds,
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
        role: 'user',
        content: '之前问过一句',
        sources: [],
        steps: [],
        thinking: '',
        created_at: null,
      },
    ],
  } as unknown as ConversationDetail
}

function renderPage(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/chat/:conversationId?" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** 输入一句并回车（发送键亮起来才算"库范围有效"，与真实可用状态同一条判据）。 */
async function ask(text: string): Promise<void> {
  const user = userEvent.setup()
  const field = screen.getByPlaceholderText(/回车发送/)
  await user.click(field)
  await user.type(field, text)
  await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
  await user.keyboard('{Enter}')
}

/** 当前选库胶囊上写着什么。 */
function pickTextOf(): string {
  return screen.getByRole('button', { name: '选择要查的知识库' }).textContent?.trim() ?? ''
}

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined
  vi.clearAllMocks()
  clearLiveTurn()
  clearLiveAnchors()
  // 项目清单是模块级 store（侧栏与对话页共用）：每个用例给回一份确定的
  useWorkspaceStore.setState({ items: [{ ...WORKSPACE }], loaded: true, loading: false, error: '' })
  vi.mocked(listCommands).mockResolvedValue([])
  vi.mocked(getSuggestedQuestions).mockResolvedValue({ questions: [], generated: false })
  vi.mocked(getContextUsage).mockResolvedValue({
    items: [],
    used: 0,
    total: 0,
    ratio: 0,
    compress_at: 0,
    estimated: true,
    note: '',
  })
})

describe('项目入口新建（`?new=1&workspace=<id>`）', () => {
  it('建会话带上项目 id、库列表传空（让后端继承项目的库），并把继承来的库当作这一轮的范围', async () => {
    const { payloads } = capture()
    createConversationMock.mockResolvedValue({ id: 'c9', kb_ids: ['kb1'] } as never)
    renderPage('/chat?new=1&workspace=w1')

    // 欢迎态先说清落点（会话还没有 id 的时候，抬头那条不画）
    expect(await screen.findByTestId('new-chat-scope')).toHaveTextContent(
      '在项目「闲聊」里新建：第一条消息落下后，这条会话就归在它下面',
    )
    const field = await screen.findByPlaceholderText(/回车发送/)

    await ask('在吗')

    await waitFor(() => expect(createConversationMock).toHaveBeenCalledTimes(1))
    // 空库列表 + workspace_id：与工作区页那颗「在这个工作区新开会话」逐字同一条
    expect(createConversationMock.mock.calls[0].slice(0, 4)).toEqual([
      [],
      null,
      { thinking: true, thinking_effort: 'medium' },
      'w1',
    ])
    // 继承来的那几个就是这一轮的库范围，输入框上的胶囊也当场跟着变（不再是"全部 2 个"）
    await waitFor(() => expect(payloads).toHaveLength(1))
    expect(payloads[0].kb_ids).toEqual(['kb1'])
    expect(pickTextOf()).toBe('已选 1 个')
    // 建完地址换成会话页：落点那句话让位给抬头（两处不会同时出现）。
    // 用 `waitFor`：路由跳转是 transition，提交比"请求已发出"晚一拍
    await waitFor(() => expect(screen.queryByTestId('new-chat-scope')).not.toBeInTheDocument())
    expect(field).toBeInTheDocument()
  })

  it('项目一个库都没绑时：这一轮仍按输入框里的选择走（默认全选），不会变成"不查库"', async () => {
    const { payloads } = capture()
    createConversationMock.mockResolvedValue({ id: 'c9', kb_ids: [] } as never)
    renderPage('/chat?new=1&workspace=w1')

    await screen.findByPlaceholderText(/回车发送/)
    await waitFor(() => expect(pickTextOf()).toBe('全部 2 个'))
    await ask('在吗')

    await waitFor(() => expect(payloads).toHaveLength(1))
    expect(payloads[0].kb_ids).toEqual(['kb1', 'kb2'])
  })

  it('不带项目的入口维持原样：把输入框里选的那几个记进会话', async () => {
    const { payloads } = capture()
    createConversationMock.mockResolvedValue({ id: 'c9', kb_ids: ['kb1', 'kb2'] } as never)
    renderPage('/chat?new=1')

    await screen.findByPlaceholderText(/回车发送/)
    await ask('在吗')

    await waitFor(() => expect(createConversationMock).toHaveBeenCalledTimes(1))
    expect(createConversationMock.mock.calls[0].slice(0, 4)).toEqual([
      ['kb1', 'kb2'],
      null,
      { thinking: true, thinking_effort: 'medium' },
      null,
    ])
    expect(payloads[0].kb_ids).toEqual(['kb1', 'kb2'])
  })
})

describe('`@` 菜单里的知识库', () => {
  it('点一下并进检索范围：不插文本、菜单合上、说清怎么取消，这一轮真的带上它', async () => {
    const { payloads } = capture()
    // 详情里记着 kb1：**回填**只把它选上（不是全选）——顺带钉住"回填没被改坏"
    getConversationMock.mockResolvedValue(conversation(['kb1']))
    renderPage('/chat/c1')
    const user = userEvent.setup()
    const field = await screen.findByPlaceholderText(/回车发送/)
    await waitFor(() => expect(pickTextOf()).toBe('已选 1 个'))

    await user.click(field)
    await user.type(field, '@')
    // 「知识库」是第一档，条目直接来自同一层的库清单（不多发一次请求）。
    // 按 role 取菜单再在菜单里找这一档：输入框上那颗开关也叫「知识库」，全文查会撞上
    const menu = await screen.findByRole('listbox', { name: '添加上下文' })
    await waitFor(() => expect(within(menu).getByText('知识库')).toBeInTheDocument())
    const option = await screen.findByRole('option', { name: /笔记/ })
    await user.click(option)

    // 不插 `@库名`（会与同名文件 / 会话歧义），输入框里连那个 `@` 搜索词也收掉
    expect(field).toHaveValue('')
    expect(await screen.findByText(/已把「笔记」并入检索范围/)).toBeInTheDocument()
    await waitFor(() => expect(pickTextOf()).toBe('全部 2 个'))

    await ask('在吗')
    await waitFor(() => expect(payloads).toHaveLength(1))
    expect(payloads[0].kb_ids).toEqual(['kb1', 'kb2'])
  })

  it('开关关着时点它：顺手打开开关（否则点了等于没点），提示里说明这一点', async () => {
    const { payloads } = capture()
    getConversationMock.mockResolvedValue(conversation(['kb1']))
    renderPage('/chat/c1')
    const user = userEvent.setup()
    const field = await screen.findByPlaceholderText(/回车发送/)
    await waitFor(() => expect(pickTextOf()).toBe('已选 1 个'))

    const kbSwitch = screen.getByRole('switch', { name: '使用知识库' })
    await user.click(kbSwitch)
    expect(kbSwitch).toHaveAttribute('aria-checked', 'false')

    await user.click(field)
    await user.type(field, '@')
    await user.click(await screen.findByRole('option', { name: /笔记/ }))

    expect(kbSwitch).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByText(/并打开了「知识库」开关/)).toBeInTheDocument()
    // 开关打开之后这一轮的库范围就是"详情回填的那一个 + 刚并进来的那一个"
    expect(pickTextOf()).toBe('全部 2 个')
    expect(field).toHaveValue('')
    expect(payloads).toHaveLength(0)
  })
})
