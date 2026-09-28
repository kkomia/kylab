/**
 * 输入框的**粘贴上传**（`ui/Composer.tsx` 的 `onPaste`）——钉住"哪一次粘贴该拦、哪一次必须放行"。
 *
 * 为什么单开一个文件：页面级用例（`chat-ui.test.tsx`）钉的是"从哪个入口发消息、界面长什么样"，
 * 这里钉的是**粘贴这一个动作本身的两条口径**——带文件才拦、纯文本一个字都不许拦。
 * 两条都从输入框出发，判据却完全不同，混进页面用例里会被那一堆 mock 淹掉。
 *
 * 断言落在 `@/api/conversations.uploadFile` 上，因为它就是**既有上传入口的终点**
 * （`ChatProvider.uploadFiles` → `uploadFile`；拖拽落点与「加号 → 添加文件」走的也是它）。
 * 界面这一层要是哪天自己另发一次请求，这条用例当场看得见：`uploadFile` 根本不会被调到。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatProvider } from '@/features/chat/runtime/ChatProvider'
import { Composer } from '@/features/chat/ui/Composer'

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
    // **这两条用例要断言的就是它**：调了几次、每一次拿到的文件名是什么
    uploadFile: vi.fn(),
    getFileUrl: vi.fn(),
    downloadFile: vi.fn(async () => undefined),
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

import { getConversation, uploadFile, type ConversationDetail } from '@/api/conversations'

/** 一条**空会话**的骨架：挂 `Composer` 只要有会话 id 与空消息就够（有消息才会去要视口上下文）。 */
function emptyConversation(): ConversationDetail {
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

beforeEach(() => {
  // jsdom 没有 `Element.prototype.scrollTo`，而 assistant-ui 的视口会调它（`tests/setup.ts`
  // 只补了 ResizeObserver / matchMedia）。用例不测像素级滚动，但不补会在控制台刷一串 TypeError
  Element.prototype.scrollTo = () => undefined
  vi.clearAllMocks()
  vi.mocked(getConversation).mockResolvedValue(emptyConversation())
})

/** 挂起真实的 `ChatProvider` + `Composer`（会话 id 从路由参数来，与 App 那条路由同形）。 */
function withComposer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/chat/c1']}>
        <Routes>
          <Route
            path="/chat/:conversationId?"
            element={
              <ChatProvider>
                <Composer />
              </ChatProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/**
 * 造一个带 `clipboardData` 的 `paste` 事件。
 *
 * **为什么不用 `new ClipboardEvent('paste', { clipboardData })`**：规范里 `clipboardData`
 * 是只读的，jsdom 不吃这个 init，传进去只会拿到 null——"带文件的那一次粘贴"就根本造不出来。
 * 所以这里先用普通事件把类型、冒泡与 `cancelable` 立起来，再用 `Object.defineProperty`
 * 挂一个 `DataTransfer` 形状的对象上去。界面只读 `files` 这一个字段（见 `onPaste`），
 * 不必也不该去伪造整个 `DataTransfer`。
 *
 * `cancelable: true` 是必须的：只有可取消的事件上 `preventDefault` 才落成 `defaultPrevented`
 * ——"拦下来了没"这条判据就是靠它读出来的。`bubbles: true` 也是必须的：React 的监听挂在
 * 根容器上，不从输入框冒上去就没人接。
 */
function pasteEvent(files: File[], text = ''): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { files, types: text ? ['text/plain'] : [], getData: () => text },
  })
  return event
}

/** 派发一次粘贴（返回那个事件本身，用来读"有没有被拦"）。 */
async function paste(field: HTMLElement, files: File[], text = ''): Promise<Event> {
  const event = pasteEvent(files, text)
  await act(async () => {
    field.dispatchEvent(event)
  })
  return event
}

describe('输入框的粘贴上传', () => {
  it('粘一张截图：走既有上传入口，补上能判类型的名字，并且拦下这一次粘贴', async () => {
    withComposer()
    const field = await screen.findByRole('textbox', { name: '消息输入框' })

    // Chrome 给粘贴进来的截图起的就是这个占位名（连名字都没有的那种见下面那条）
    const shot = new File(['png-bytes'], 'image.png', { type: 'image/png' })
    const event = await paste(field, [shot])

    await waitFor(() => expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(1))
    const [conversation, uploaded] = vi.mocked(uploadFile).mock.calls[0]
    expect(conversation).toBe('c1')
    // 名字换成能看懂、且**后缀还在**的那一种：后端按后缀判类型，判不出就直接拒
    expect(uploaded.name).toMatch(/^粘贴的截图-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-1\.png$/)
    expect(uploaded.type).toBe('image/png')
    // 有文件才拦：拦下之后输入框里不会落进"文件名"那种垃圾文本
    expect(event.defaultPrevented).toBe(true)
    expect(field).toHaveValue('')
  })

  it('粘纯文本：一个字都不拦（没上传、也没被 preventDefault）', async () => {
    withComposer()
    const field = await screen.findByRole('textbox', { name: '消息输入框' })

    const event = await paste(field, [], '一段要粘进来的话')

    // 剪贴板里没有文件：这里什么都不做，上传入口一次都不该被调
    expect(vi.mocked(uploadFile)).not.toHaveBeenCalled()
    // **没被拦**才是对的：拦了就等于"粘不了字"，而这是这个功能最容易犯的错。
    // jsdom 不会替浏览器把文本插进框里（"插到光标处"是浏览器的默认编辑动作），
    // 所以"文本照常进框"在这里只能钉在"我们没拦"这一头上——拦没拦才是我们的行为。
    expect(event.defaultPrevented).toBe(false)
    expect(field).toHaveValue('')
  })

  it('一次粘多份：两份都传，各给一个不撞的名字', async () => {
    withComposer()
    const field = await screen.findByRole('textbox', { name: '消息输入框' })

    // 第一份是 Chrome 的占位名，第二份**连名字都没有**——两份都得能被上传
    const fromChrome = new File(['a'], 'image.png', { type: 'image/png' })
    const unnamed = new File(['b'], '', { type: 'image/png' })
    const event = await paste(field, [fromChrome, unnamed])

    await waitFor(() => expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(2))
    const names = vi.mocked(uploadFile).mock.calls.map(([, file]) => file.name)
    // 序号把它们分开：同一个粘贴动作里两份同名文件在文件区里分不出谁是谁
    expect(names[0]).toMatch(/-1\.png$/)
    expect(names[1]).toMatch(/-2\.png$/)
    expect(new Set(names).size).toBe(2)
    expect(event.defaultPrevented).toBe(true)
  })
})
