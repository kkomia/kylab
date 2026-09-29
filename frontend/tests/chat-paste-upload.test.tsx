/**
 * 输入框的**附件入口**（`ui/Composer.tsx`）——粘贴、选文件、选文件夹、拖入目录。
 *
 * 为什么单开一个文件：页面级用例（`chat-ui.test.tsx`）钉的是"从哪个入口发消息、界面长什么样"，
 * 这里钉的是**几个入口本身的口径**——粘贴时带文件才拦、纯文本一个字都不许拦；
 * 选文件 / 选文件夹 / 拖入目录都要**保留相对路径**（v0.55：上传给后端的 filename 就是它）。
 * 这些判据都从输入框出发，却互不相同，混进页面用例里会被那一堆 mock 淹掉。
 *
 * 断言落在 `@/api/conversations.uploadFile` 上，因为它就是**上传的终点**：拖拽、粘贴、
 * 「加号 → 添加文件」三条入口都先经过 `ChatProvider.addAttachments` **暂存**，
 * 再由 `ChatProvider.send` 里那一段统一上传（v0.55：用户报的"上传效果不合理"——
 * 文件和图片应当**先以缩略图留在输入框里**，发送那一刻才上传）。所以这里同时钉两件事：
 * 粘完**一次都不许上传**、点发送**才**上传。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatProvider } from '@/features/chat/runtime/ChatProvider'
import { ChatRuntime } from '@/features/chat/runtime/ChatRuntime'
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
    // **这两条用例要断言的就是它**：调了几次、每一次拿到的文件名是什么。
    // 返回一份**完整的文件条目**（v0.55）：`send` 会拿上传返回的这份拼"随发附件"的
    // 快照（见 `ChatProvider.send`），所以它必须是一份真形状，而不是空
    uploadFile: vi.fn(async () => ({
      key: 'f1',
      name: 'a.png',
      is_dir: false,
      size_bytes: 12,
      modified_at: null,
      kind: 'png',
    })),
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

/** 挂起真实的 `ChatProvider` + `Composer`（会话 id 从路由参数来，与 App 那条路由同形）。
 *
 * **`ChatRuntime` 也要挂**：输入卡片上沿那个「回到最新」浮标是 assistant-ui 的
 * `ThreadPrimitive.ScrollToBottom`，它要 `AssistantRuntimeProvider` 的上下文——
 * 少了它，一旦这一页有消息（例如"发送那一刻才上传"那条用例发了一句）就会抛
 * `thread viewport context` 缺失。真实页面里这一层由 `ChatPage` 装上。
 */
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
                <ChatRuntime>
                  <Composer />
                </ChatRuntime>
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
  it('粘一张截图：补上能判类型的名字、留在输入框里，并且拦下这一次粘贴', async () => {
    withComposer()
    const field = await screen.findByRole('textbox', { name: '消息输入框' })

    // Chrome 给粘贴进来的截图起的就是这个占位名（连名字都没有的那种见下面那条）
    const shot = new File(['png-bytes'], 'image.png', { type: 'image/png' })
    const event = await paste(field, [shot])

    // v0.55：粘贴**不再立刻上传**——它先以"待发送的附件"留在输入框里
    expect(vi.mocked(uploadFile)).not.toHaveBeenCalled()
    // 名字换成能看懂、且**后缀还在**的那一种（后端按后缀判类型，判不出就直接拒）。
    // 认那颗移除按钮的无障碍名字：图片缩略图与文件片两种画法下它都在（不依赖渲染形态）
    expect(
      screen.getByRole('button', {
        name: /^移除 粘贴的截图-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-1\.png$/,
      }),
    ).toBeInTheDocument()
    // 有文件才拦：拦下之后输入框里不会落进"文件名"那种垃圾文本
    expect(event.defaultPrevented).toBe(true)
    expect(field).toHaveValue('')
  })

  it('粘纯文本：一个字都不拦（没有附件、也没被 preventDefault）', async () => {
    withComposer()
    const field = await screen.findByRole('textbox', { name: '消息输入框' })

    const event = await paste(field, [], '一段要粘进来的话')

    // 剪贴板里没有文件：这里什么都不做，输入框里也不会多出一份待发附件
    expect(screen.queryByLabelText('待发送的附件')).not.toBeInTheDocument()
    // **没被拦**才是对的：拦了就等于"粘不了字"，而这是这个功能最容易犯的错。
    // jsdom 不会替浏览器把文本插进框里（"插到光标处"是浏览器的默认编辑动作），
    // 所以"文本照常进框"在这里只能钉在"我们没拦"这一头上——拦没拦才是我们的行为。
    expect(event.defaultPrevented).toBe(false)
    expect(field).toHaveValue('')
  })

  it('一次粘多份：两份都留在输入框里，各给一个不撞的名字', async () => {
    withComposer()
    const field = await screen.findByRole('textbox', { name: '消息输入框' })

    // 第一份是 Chrome 的占位名，第二份**连名字都没有**——两份都得能进输入框
    const fromChrome = new File(['a'], 'image.png', { type: 'image/png' })
    const unnamed = new File(['b'], '', { type: 'image/png' })
    const event = await paste(field, [fromChrome, unnamed])

    const list = await screen.findByLabelText('待发送的附件')
    const names = within(list)
      .getAllByRole('button')
      .map((node) => node.getAttribute('aria-label') ?? '')
    // 序号把它们分开：同一个粘贴动作里两份同名文件在文件区里分不出谁是谁
    expect(names[0]).toMatch(/-1\.png$/)
    expect(names[1]).toMatch(/-2\.png$/)
    expect(new Set(names).size).toBe(2)
    expect(event.defaultPrevented).toBe(true)
  })

  it('发送那一刻才上传：之前只在输入框里，点发送才落到会话文件区', async () => {
    const user = userEvent.setup()
    withComposer()
    const field = await screen.findByRole('textbox', { name: '消息输入框' })
    await paste(field, [new File(['png-bytes'], 'image.png', { type: 'image/png' })])

    // 还只是"待发送"，一份都没上去
    expect(vi.mocked(uploadFile)).not.toHaveBeenCalled()

    await user.type(field, '看看这张图')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(1))
    const [conversation, uploaded] = vi.mocked(uploadFile).mock.calls[0]
    expect(conversation).toBe('c1')
    expect(uploaded.name).toMatch(/^粘贴的截图-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-1\.png$/)
    // 上传成功之后它从输入框里拿掉：否则下一轮会把同一份再传一次
    await waitFor(() => expect(screen.queryByLabelText('待发送的附件')).not.toBeInTheDocument())
  })
})

/**
 * 文件夹上传（v0.55）：目录选择与拖入目录都要**保留相对路径**。
 *
 * 上传给后端的 filename 就是那条相对路径（后端按它保留文件夹结构），而界面上的名字
 * 也取同一条——所以「移除 X」的无障碍名字是这条断言最省事的落点：它同时证明
 * "相对路径确实挂在了那份文件上"，且不依赖缩略图那种渲染形态。
 */
describe('文件夹上传：相对路径当 filename', () => {
  it('选一个文件夹：每份文件按 `webkitRelativePath` 改名后进输入框（此刻还没上传）', async () => {
    const user = userEvent.setup()
    withComposer()
    await screen.findByRole('textbox', { name: '消息输入框' })

    // 目录选择给的文件带 `webkitRelativePath`（jsdom 的 File 造不出来，手动挂上）
    const inner = new File(['png-bytes'], '第二季度.png', { type: 'image/png' })
    Object.defineProperty(inner, 'webkitRelativePath', { value: '图表/第二季度.png' })

    // 两个隐藏 input：先"选文件"、后"选文件夹"（`webkitdirectory` 在第二个上）
    const inputs = document.querySelectorAll('input[type="file"]')
    expect(inputs).toHaveLength(2)
    await user.upload(inputs[1] as HTMLInputElement, inner)

    expect(
      await screen.findByRole('button', { name: '移除 图表/第二季度.png' }),
    ).toBeInTheDocument()
    expect(vi.mocked(uploadFile)).not.toHaveBeenCalled()
  })

  it('拖入一个目录：递归读整棵（分批读完），每份带上相对路径', async () => {
    withComposer()
    const field = await screen.findByRole('textbox', { name: '消息输入框' })

    const pic = new File(['a'], 'a.png', { type: 'image/png' })
    const note = new File(['b'], 'b.txt', { type: 'text/plain' })
    const fileEntry = (file: File, fullPath: string) => ({
      isDirectory: false,
      isFile: true,
      fullPath,
      file: (ok: (value: File) => void) => ok(file),
    })
    // 每层都**先给一批、再给空数组**：只读一批的实现会在这里漏掉子目录里的那份文件
    const sub = {
      isDirectory: true,
      isFile: false,
      fullPath: '/图表/sub',
      createReader: () => {
        let round = 0
        return {
          readEntries: (cb: (entries: unknown[]) => void) => {
            round += 1
            cb(round === 1 ? [fileEntry(note, '/图表/sub/b.txt')] : [])
          },
        }
      },
    }
    const root = {
      isDirectory: true,
      isFile: false,
      fullPath: '/图表',
      createReader: () => {
        let round = 0
        return {
          readEntries: (cb: (entries: unknown[]) => void) => {
            round += 1
            cb(round === 1 ? [fileEntry(pic, '/图表/a.png'), sub] : [])
          },
        }
      },
    }
    const transfer = {
      types: ['Files'],
      files: [] as File[],
      getData: () => '',
      items: [{ webkitGetAsEntry: () => root }],
    }
    fireEvent.drop(field, { dataTransfer: transfer })

    expect(await screen.findByRole('button', { name: '移除 图表/a.png' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '移除 图表/sub/b.txt' })).toBeInTheDocument()
    expect(vi.mocked(uploadFile)).not.toHaveBeenCalled()
  })
})

describe('超长粘贴与输入框长高（D02/D06，2026-09-28 走查）', () => {
  it('一次粘 5.6 万字：**拦下并说清怎么办**，而不是静默截断', async () => {
    withComposer()
    const field = screen.getByRole('textbox', { name: '消息输入框' })
    const event = await paste(field, [], '字'.repeat(56_000))

    // 拦下这一次粘贴，而且**一个字都不进去**——截断会让人以为"粘成功了"
    expect(event.defaultPrevented).toBe(true)
    expect(field).toHaveValue('')
    // 提示要可执行：说清这次多少字、上限多少、该走哪条路
    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent('56,000')
    expect(notice).toHaveTextContent('32,000')
    expect(notice).toHaveTextContent('添加文件')
  })

  it('正常长度的粘贴不被拦（也不弹那句话）', async () => {
    withComposer()
    const field = screen.getByRole('textbox', { name: '消息输入框' })
    const event = await paste(field, [], '短的一段文字')

    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    // **这里不断言输入框的值**：`paste` 是手工派发的合成事件，jsdom 不会替浏览器执行
    // "把文本插到光标处"那个默认动作——所以"拦没拦、有没有那句话"才是这条链路里可观测的部分。
  })

  it('输入框随内容长高：高度按 `scrollHeight` 给（封顶交给 CSS 的 max-height）', async () => {
    // 病灶（走查 D02）：只有 `rows={2}` 时 textarea 自己不长——实测 6400 字时
    // clientHeight 仍是 44.09、scrollHeight 2954，用户只能在两行高的窗口里翻自己写的东西。
    withComposer()
    const field = screen.getByRole('textbox', { name: '消息输入框' }) as HTMLTextAreaElement
    // jsdom 不做排版，scrollHeight 恒为 0：给一个可观测的值，验证"读了它、写进了 height"
    Object.defineProperty(field, 'scrollHeight', { value: 300, configurable: true })

    await userEvent.type(field, '写点东西')

    expect(field.style.height).toBe('300px')
  })
})
