/**
 * 对话页的快捷键（迁移计划 §9 下一步第 4 条）：**注册表的绑定真的管用**。
 *
 * 注册表（命令表 + 多绑定 + 冲突 + 恢复默认）在 misc 域，对话页这边按数据契约实现了一份
 * 极薄的读取层（`runtime/shortcutPrefs.ts`）。这个文件钉三件事：
 *
 * 1. **存储契约**：绑定从 `kylab-shortcuts` 读（与 misc 域共用，键名一字不差）——
 *    直接往 localStorage 里写一份"改过的绑定"，对话页的键位就得跟着变（验收那一条）；
 * 2. **四个 id 真的接上了**：`chat.send` / `chat.newline`（输入框）与
 *    `chat.new` / `layout.toggleSidebar`（全局）；
 * 3. **冲突以注册表的判定为准**：同一条绑定只归命令表里靠前的那条
 *    （`chat.send` 排在 `chat.newline` 前头，所以把换行也绑到回车时，回车仍然是发送）。
 *
 * 读取层本身（解析 / 匹配 / 作用域）是纯函数，前一半直接对着它跑，不必渲染页面。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bindingsOf,
  isTypingTarget,
  matchChatShortcut,
  SHORTCUTS_STORAGE_KEY,
} from '@/features/chat/runtime/shortcutPrefs'
import { ChatPage } from '@/features/chat/ChatPage'
import { clearLiveTurn } from '@/features/chat/model/liveTurn'

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
  }
})

vi.mock('@/api/knowledgeBases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/knowledgeBases')>()),
  listKnowledgeBases: vi.fn(async () => ({
    items: [{ id: 'kb1', name: '我的资料' }],
    total: 1,
  })),
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
  getChatMode: vi.fn(async () => ({ mode: '', options: [] })),
}))

vi.mock('@/api/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/capabilities')>()),
  listSkills: vi.fn(async () => ({ items: [], usable: 0 })),
}))

import { chatStream } from '@/api/chat'
import { getConversation, type ConversationDetail } from '@/api/conversations'

/** 一份"库里那条会话"的骨架（空会话即可——这个文件测的是键盘，不是对话流）。 */
function detail(): ConversationDetail {
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
    message_count: 0,
    created_at: null,
    updated_at: null,
    messages: [],
  } as unknown as ConversationDetail
}

/** 把当前路径摆到台面上（`chat.new` 断言的就是"跳到 `/chat?new=1`"）。 */
function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

function renderPage(route = '/chat/c1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <LocationProbe />
        <Routes>
          <Route path="/chat/:conversationId?" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** 往 `kylab-shortcuts` 里写一份"被改过的绑定"（设置页那一侧就是这么写的）。 */
function storeBindings(overrides: Record<string, string[]>): void {
  window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(overrides))
}

function key(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent(code, { key: '', ...init })
}

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined
  vi.clearAllMocks()
  clearLiveTurn()
  vi.mocked(getConversation).mockResolvedValue(detail())
})

describe('读取层（`runtime/shortcutPrefs`）', () => {
  it('默认绑定与注册表同一份：回车 / Ctrl+回车发送、Shift+回车换行', () => {
    expect(bindingsOf('chat.send')).toEqual(['Enter', 'Mod+Enter'])
    expect(bindingsOf('chat.newline')).toEqual(['Shift+Enter'])
    expect(bindingsOf('chat.new')).toEqual(['Mod+K'])
    expect(bindingsOf('layout.toggleSidebar')).toEqual(['Mod+B'])
  })

  it('从 `kylab-shortcuts` 读绑定（与 misc 域共用同一个键）', () => {
    storeBindings({ 'chat.send': ['Mod+Enter'] })

    expect(bindingsOf('chat.send')).toEqual(['Mod+Enter'])
    // 只改了一条：其余照旧是默认值
    expect(bindingsOf('chat.newline')).toEqual(['Shift+Enter'])
  })

  it('库里被改坏 / 留着上一版命令时，整张表不失效（读不到就用默认）', () => {
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, '{ 这不是 JSON')

    expect(bindingsOf('chat.send')).toEqual(['Enter', 'Mod+Enter'])
  })

  it('匹配：修饰键必须精确对上（多按一个 Shift 就不是那条）', () => {
    const composer = 'composer' as const
    expect(matchChatShortcut(key('keydown', { key: 'Enter' }), composer)).toBe('chat.send')
    expect(matchChatShortcut(key('keydown', { key: 'Enter', shiftKey: true }), composer)).toBe(
      'chat.newline',
    )
    expect(matchChatShortcut(key('keydown', { key: 'Enter', ctrlKey: true }), composer)).toBe(
      'chat.send',
    )
    expect(matchChatShortcut(key('keydown', { key: 'a' }), composer)).toBe('')
  })

  it('输入法组合中的键不算（选词的回车不能把半句话发出去）', () => {
    expect(matchChatShortcut(key('keydown', { key: 'Enter', isComposing: true }), 'composer')).toBe(
      '',
    )
  })

  it('冲突以注册表的判定为准：同一条绑定只归命令表里靠前的那条', () => {
    // 用户把"换行"也绑到回车：`chat.send` 在命令表里靠前，所以回车仍然是**发送**
    storeBindings({ 'chat.newline': ['Enter'] })

    expect(matchChatShortcut(key('keydown', { key: 'Enter' }), 'composer')).toBe('chat.send')
  })

  it('作用域各归各的：全局那两条不会被当成输入框里的命令', () => {
    expect(matchChatShortcut(key('keydown', { key: 'k', ctrlKey: true }), 'global')).toBe(
      'chat.new',
    )
    expect(matchChatShortcut(key('keydown', { key: 'k', ctrlKey: true }), 'composer')).toBe('')
    expect(matchChatShortcut(key('keydown', { key: 'b', ctrlKey: true }), 'global')).toBe(
      'layout.toggleSidebar',
    )
  })

  it('「正在打字的地方」认得出来（全局那两条据此让路）', () => {
    const field = document.createElement('textarea')
    const event = key('keydown', { key: 'k' })
    Object.defineProperty(event, 'target', { value: field })

    expect(isTypingTarget(event)).toBe(true)
    expect(isTypingTarget(key('keydown', { key: 'k' }))).toBe(false)
  })
})

describe('输入框：发送键与换行键跟着绑定走', () => {
  it('默认：回车发送、Shift+回车换行（换行是**插进输入框**，没发出去）', async () => {
    renderPage()
    const user = userEvent.setup()
    const field = await screen.findByPlaceholderText(/回车发送/)

    await user.click(field)
    await user.type(field, '第一行')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(field).toHaveValue('第一行\n')
    expect(chatStream).not.toHaveBeenCalled()

    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))
  })

  it('把 `chat.send` 改成 Ctrl+回车：回车不再发（换行照旧），Ctrl+回车发', async () => {
    storeBindings({ 'chat.send': ['Mod+Enter'] })
    renderPage()
    const user = userEvent.setup()
    const field = await screen.findByPlaceholderText(/回车发送/)

    await user.click(field)
    await user.type(field, '不按默认那组键发')
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())

    await user.keyboard('{Enter}')
    expect(chatStream).not.toHaveBeenCalled()

    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))
    // 发出去的就是那一段文本（没有因为多按一次回车而被拼坏）
    expect(vi.mocked(chatStream).mock.calls[0][0]).toMatchObject({
      query: '不按默认那组键发',
      conversation_id: 'c1',
    })
  })

  it('把 `chat.newline` 改成 Ctrl+J：那一组键换行，Shift+回车不再是"我们认的"。换行键也真的管用', async () => {
    storeBindings({ 'chat.newline': ['Mod+J'] })
    renderPage()
    const user = userEvent.setup()
    const field = await screen.findByPlaceholderText(/回车发送/)

    await user.click(field)
    await user.type(field, '甲')
    await user.keyboard('{Control>}j{/Control}')
    expect(field).toHaveValue('甲\n')
    expect(chatStream).not.toHaveBeenCalled()
  })

  it('冲突：把 `chat.newline` 也绑到回车 → 回车仍然是**发送**（注册表的判定）', async () => {
    storeBindings({ 'chat.newline': ['Enter'] })
    renderPage()
    const user = userEvent.setup()
    const field = await screen.findByPlaceholderText(/回车发送/)

    await user.click(field)
    await user.type(field, '回车还是发送')
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    await user.keyboard('{Enter}')

    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))
    // 没有被当成换行：发出去的文本里没有多出来的换行
    expect(vi.mocked(chatStream).mock.calls[0][0]).toMatchObject({ query: '回车还是发送' })
  })
})

// 说明：这一节原来钉的是「对话页自己注册的两条全局快捷键」。
// 壳（`features/layout`）落地之后，注册处搬到了侧栏那个宿主（同一批 id、同一份存储契约），
// 这里的三条随之删除——同样的行为由 `tests/layout-shell.test.tsx` 覆盖：
//   「Ctrl/Cmd+K 新建会话：跳到 /chat?new=1」「敲字的地方不抢」「切换侧栏偏好」
// 留在这里会变成两份真相（一份测的是已经不存在的监听）。
