/**
 * 对话页的两个抽屉（`ui/Sheets.tsx`）——**收起时序**与"关掉之后还能再开"。
 *
 * 为什么单开一个文件：这两条钉的是"抽屉与宿主之间的时序"，而页面级用例
 * （`chat-ui.test.tsx` 的"两个抽屉"那一组）钉的是"从哪个入口打开、打开时取什么数"。
 * 时序这一条要用一个**看得见宿主状态**的宿主来断言——页面里那位宿主是
 * `ChatProvider.sourceOpen` 与 `Composer` 的内部 state，从外面看不见。
 *
 * jsdom 里没有 CSS 动画，Radix 的 `Presence` 因此会把收起中的内容**立刻**摘掉
 * （真实浏览器里它会等动画跑完再摘）。所以这里不钉"DOM 还在不在"，钉的是另一头：
 * **宿主的"关掉"通知必须落在收起动画那个窗口之后**——当场就通知等于没有滑回去，
 * 表现是"啪地消失"（旧 `DocumentDrawer` 那条纪律）。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatProvider, useChat } from '@/features/chat/runtime/ChatProvider'
import { FilesSheet, SourceSheet } from '@/features/chat/ui/Sheets'
import type { ChatSource } from '@/api/chat'

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
    // 文件抽屉的四件事各自要用到的那几个（预览的签名链接、上传、下载）
    getFileUrl: vi.fn(),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(async () => undefined),
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
  getChatMode: vi.fn(async () => ({ mode: '', options: [] })),
}))

vi.mock('@/api/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/capabilities')>()),
  listSkills: vi.fn(async () => ({ items: [], usable: 0 })),
}))

import { getConversation } from '@/api/conversations'
import { downloadFile, getFileUrl, listFiles, uploadFile } from '@/api/conversations'
import type { ConversationFileListing } from '@/api/conversations'

const source: ChatSource = {
  index: 1,
  chunk_id: 'chunk-1',
  document_id: 'doc-1',
  document_name: '报告1.pdf',
  heading_path: '第一章',
  page: 1,
  preview: '第 1 段的原文',
  knowledge_base_id: 'kb1',
  score: 0.9,
} as ChatSource

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined
  vi.clearAllMocks()
  vi.mocked(getConversation).mockResolvedValue(undefined as never)
})

function withProviders(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/chat/c1']}>
        <Routes>
          <Route path="/chat/:conversationId?" element={<ChatProvider>{node}</ChatProvider>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** 出处抽屉的宿主：把 `sourceOpen` 摆到台面上（它就是抽屉要通知的那位）。 */
function SourceHost() {
  const chat = useChat()
  return (
    <>
      <output data-testid="source-open">{String(chat.sourceOpen)}</output>
      <button type="button" onClick={() => chat.openSource(source)}>
        看全文
      </button>
      {chat.sourceOpen ? <SourceSheet /> : null}
    </>
  )
}

/** 文件抽屉的宿主：与 `Composer` 同一种挂法（开着才挂、通知到了才卸）。 */
function FilesHost() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <output data-testid="files-open">{String(open)}</output>
      <button type="button" onClick={() => setOpen(true)}>
        浏览文件
      </button>
      {open ? <FilesSheet onClose={() => setOpen(false)} /> : null}
    </>
  )
}

describe('出处抽屉：先滑回去，再通知宿主', () => {
  it('打开时就有内容；Esc 之后宿主的"关掉"是**过一会儿**才收到的，收完还能再开', async () => {
    withProviders(<SourceHost />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '看全文' }))
    expect(await screen.findByRole('dialog', { name: /引用原文/ })).toHaveTextContent(
      '第 1 段的原文',
    )
    expect(screen.getByTestId('source-open')).toHaveTextContent('true')

    await user.keyboard('{Escape}')
    // **先滑回去**：这一刻宿主还开着（通知要等收起动画那个窗口走完）
    expect(screen.getByTestId('source-open')).toHaveTextContent('true')
    // 动画窗口之后才通知宿主 → 宿主收起 → 抽屉卸掉
    await waitFor(() => expect(screen.getByTestId('source-open')).toHaveTextContent('false'), {
      timeout: 2000,
    })
    expect(screen.queryByRole('dialog', { name: /引用原文/ })).toBeNull()

    // **关闭后可再开**：同一份引用还在（宿主的口径：收起只是不看它了）
    await user.click(screen.getByRole('button', { name: '看全文' }))
    expect(await screen.findByRole('dialog', { name: /引用原文/ })).toHaveTextContent(
      '第 1 段的原文',
    )
  })
})

describe('产物与文件抽屉：打开时取数、关掉后再开', () => {
  it('打开那一刻才请求文件区；Esc 同样是先滑回去再通知宿主，关掉之后再开还在', async () => {
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
    withProviders(<FilesHost />)
    const user = userEvent.setup()

    expect(listFiles).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '浏览文件' }))
    const drawer = await screen.findByRole('dialog', { name: /产物与文件/ })
    expect(await within(drawer).findByText('季度报告.docx')).toBeInTheDocument()
    // 打开就取**根那一层**（`path` 为空 = 文件区的根，旧 `FileDrawer` 的 `load('')`）
    expect(listFiles).toHaveBeenCalledWith('c1', '')

    await user.keyboard('{Escape}')
    expect(screen.getByTestId('files-open')).toHaveTextContent('true')
    await waitFor(() => expect(screen.getByTestId('files-open')).toHaveTextContent('false'), {
      timeout: 2000,
    })
    expect(screen.queryByRole('dialog', { name: /产物与文件/ })).toBeNull()

    // 关掉之后再开：宿主重新挂一次，内容还在（同一条会话的文件区）
    await user.click(screen.getByRole('button', { name: '浏览文件' }))
    expect(await screen.findByRole('dialog', { name: /产物与文件/ })).toHaveTextContent(
      '季度报告.docx',
    )
  })
})

/**
 * 旧 `FileDrawer.vue`（543 行）的四件事：**子目录进出 / 就地预览 / 上传 / 拖出引用**。
 *
 * 为什么把这四件放在这里而不是页面级用例里：它们的成败都在抽屉内部（点了哪一层、
 * 取了哪条链接、传了哪几个文件、拖拽带了什么 payload），而页面级用例要回答的是
 * "从哪个入口打开、打开时取什么数"——混在一起写，断言会绕着一整页的渲染去打转。
 */
describe('文件区抽屉：旧 FileDrawer 的四件事', () => {
  /** 一层目录的回答（`path` / `parent` / `label` / `truncated` 都要给全）。 */
  function listing(over: Partial<ConversationFileListing> = {}): ConversationFileListing {
    return {
      mode: 'workspace',
      label: '工作区「我的项目」',
      path: '',
      parent: null,
      entries: [],
      truncated: false,
      ...over,
    }
  }

  /** 打开抽屉，返回那一份 dialog 元素（标题行跟着预览走，所以调用方自己抓节点）。 */
  async function openDrawer() {
    const user = userEvent.setup()
    withProviders(<FilesHost />)
    await user.click(screen.getByRole('button', { name: '浏览文件' }))
    const drawer = await screen.findByRole('dialog', { name: /产物与文件/ })
    return { user, drawer }
  }

  it('子目录：点目录进去（取那一层）、面包屑与「上一级」都能退回根', async () => {
    const root = listing({
      entries: [
        {
          key: 'out',
          name: '导出的东西',
          is_dir: true,
          size_bytes: 0,
          modified_at: null,
          kind: '',
        },
        {
          key: 'readme.md',
          name: 'readme.md',
          is_dir: false,
          size_bytes: 12,
          modified_at: null,
          kind: 'md',
        },
      ],
    })
    const sub = listing({
      path: 'out',
      parent: '',
      entries: [
        {
          key: 'out/报告.pdf',
          name: '报告.pdf',
          is_dir: false,
          size_bytes: 2048,
          modified_at: null,
          kind: 'pdf',
        },
      ],
    })
    vi.mocked(listFiles).mockImplementation(async (_id, path = '') => (path ? sub : root))
    const { user, drawer } = await openDrawer()

    expect(await within(drawer).findByText('readme.md')).toBeInTheDocument()

    // 进一层：请求带上了那一层的路径（旧 `load(entry.key)`）
    await user.click(within(drawer).getByText('导出的东西'))
    expect(await within(drawer).findByText('报告.pdf')).toBeInTheDocument()
    expect(listFiles).toHaveBeenCalledWith('c1', 'out')
    // 面包屑：根那一段用服务端给的 `label`，当前目录是最后一段（不可点）
    const trail = within(drawer).getByRole('navigation', { name: '路径' })
    expect(within(trail).getByText('工作区「我的项目」')).toBeInTheDocument()
    expect(within(trail).getByText('out')).toHaveAttribute('aria-current', 'page')

    // 上一级：回到根那一层（`parent` 是服务端算的）
    await user.click(within(drawer).getByRole('button', { name: '上一级' }))
    expect(await within(drawer).findByText('readme.md')).toBeInTheDocument()
    expect(within(drawer).queryByText('报告.pdf')).toBeNull()

    // 面包屑那一段也能回根（再进去一次，点根）
    await user.click(within(drawer).getByText('导出的东西'))
    await user.click(within(trail).getByText('工作区「我的项目」'))
    expect(await within(drawer).findByText('readme.md')).toBeInTheDocument()
  })

  it('空目录有说明；只给看了前 300 项时如实说（不假装"这里只有这些"）', async () => {
    vi.mocked(listFiles).mockResolvedValue(listing())
    const { user, drawer } = await openDrawer()
    expect(
      await within(drawer).findByText('这里还没有文件。让 Agent 做一份，或者自己上传一个。'),
    ).toBeInTheDocument()

    vi.mocked(listFiles).mockResolvedValue(
      listing({
        truncated: true,
        entries: [
          {
            key: 'a.txt',
            name: 'a.txt',
            is_dir: false,
            size_bytes: 1,
            modified_at: null,
            kind: 'txt',
          },
        ],
      }),
    )
    // 关掉再开：换一份回答进来（同一个宿主，重新挂一次抽屉）。
    // 要等**宿主**真的收到"关掉"再点开——收起通知比动画晚 `LEAVE_MS`（同上面那条时序）
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByTestId('files-open')).toHaveTextContent('false'), {
      timeout: 2000,
    })
    await user.click(screen.getByRole('button', { name: '浏览文件' }))
    const again = await screen.findByRole('dialog', { name: /产物与文件/ })
    expect(
      await within(again).findByText('这一层文件很多，只显示了前 300 项。'),
    ).toBeInTheDocument()
  })

  it('就地预览：走 @/features/preview 的 FilePreview，签名链接（inline）由这里换', async () => {
    vi.mocked(listFiles).mockResolvedValue(
      listing({
        entries: [
          {
            key: 'out/报告.pdf',
            name: '报告.pdf',
            is_dir: false,
            size_bytes: 2048,
            modified_at: null,
            kind: 'pdf',
          },
        ],
      }),
    )
    vi.mocked(getFileUrl).mockResolvedValue({
      url: '/api/v1/conversations/c1/files/download-url?sign=abc',
      expires_at: 0,
      name: '报告.pdf',
    })
    const { user, drawer } = await openDrawer()

    await user.click(within(drawer).getByText('报告.pdf'))

    // **不再是新标签页**：预览落在抽屉里，PDF 那一档就是指向签名链接的 iframe
    const frame = await within(drawer).findByTitle('报告.pdf')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame).toHaveAttribute('src', '/api/v1/conversations/c1/files/download-url?sign=abc')
    // 链接是**这里**换的，而且必须点名要 inline（PDF / 图片要它才能在页面里渲染）
    expect(getFileUrl).toHaveBeenCalledWith('c1', 'out/报告.pdf', 'inline')
    // 标题行就是这份文件 + 它有多大（旧版预览态那两格）
    expect(within(drawer).getByText('2.0 KB')).toBeInTheDocument()
    // 标题行就是这份文件（旧版预览态同一位），左边那个箭头回目录
    await user.click(within(drawer).getByRole('button', { name: '回到文件列表' }))
    expect(await within(drawer).findByText('报告.pdf')).toBeInTheDocument()

    // 下载仍走既有那条（换成 attachment 链接再点一下）
    await user.click(within(drawer).getByRole('button', { name: '下载 报告.pdf' }))
    await waitFor(() => expect(downloadFile).toHaveBeenCalledWith('c1', 'out/报告.pdf'))
  })

  it('预览失败要说原因；不能预览的格式连链接都不换（旧版那条分支）', async () => {
    vi.mocked(listFiles).mockResolvedValue(
      listing({
        entries: [
          {
            key: 'data.bin',
            name: 'data.bin',
            is_dir: false,
            size_bytes: 9,
            modified_at: null,
            kind: 'bin',
          },
        ],
      }),
    )
    const { user, drawer } = await openDrawer()

    await user.click(within(drawer).getByText('data.bin'))
    expect(
      await within(drawer).findByText('「data.bin」这个格式不能在这里预览'),
    ).toBeInTheDocument()
    expect(within(drawer).getByText('下载它，用本机的程序打开。')).toBeInTheDocument()
    // 不假装能预览：连签名链接都不换（旧 `FilePreview.vue` 同一条）
    expect(getFileUrl).not.toHaveBeenCalled()

    // 换一份"能预览、但链接拿不到"的文件：说原因，而不是留白
    vi.mocked(listFiles).mockResolvedValue(
      listing({
        entries: [
          {
            key: 'pic.png',
            name: '图.png',
            is_dir: false,
            size_bytes: 9,
            modified_at: null,
            kind: 'png',
          },
        ],
      }),
    )
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByTestId('files-open')).toHaveTextContent('false'), {
      timeout: 2000,
    })
    await user.click(screen.getByRole('button', { name: '浏览文件' }))
    const again = await screen.findByRole('dialog', { name: /产物与文件/ })
    vi.mocked(getFileUrl).mockRejectedValue(new Error('HTTP 403'))
    await user.click(await within(again).findByText('图.png'))
    expect(await within(again).findByText(/预览失败（HTTP 403）/)).toBeInTheDocument()
  })

  it('上传：多选**串行**、逐条结果、失败给原因，传完重读这一层', async () => {
    vi.mocked(listFiles).mockResolvedValue(listing())
    let releaseFirst: () => void = () => undefined
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    vi.mocked(uploadFile)
      .mockImplementationOnce(async () => {
        await first
        return {
          key: 'a.txt',
          name: 'a.txt',
          is_dir: false,
          size_bytes: 3,
          modified_at: null,
          kind: 'txt',
        }
      })
      .mockRejectedValueOnce(new Error('同名冲突'))
    const { user, drawer } = await openDrawer()
    await within(drawer).findByText('这里还没有文件。让 Agent 做一份，或者自己上传一个。')

    await user.upload(within(drawer).getByLabelText('上传到文件区'), [
      new File(['aaa'], 'a.txt', { type: 'text/plain' }),
      new File(['bbb'], 'b.txt', { type: 'text/plain' }),
    ])

    // **串行**：第一个还在飞，第二个不许发出去（并发会让"哪一个变成了 (2)"无从判断）
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1))
    const inFlight = (await within(drawer).findByText('a.txt')).closest('li') as HTMLElement
    expect(inFlight).toHaveTextContent('上传中…')
    releaseFirst()

    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2))
    expect(await within(drawer).findByText('已放入「a.txt」')).toBeInTheDocument()
    expect(await within(drawer).findByText('同名冲突')).toBeInTheDocument()
    // 到达顺序与选中的顺序一致（逐条，而不是一句"传完了"）
    expect(vi.mocked(uploadFile).mock.calls.map((call) => (call[1] as File).name)).toEqual([
      'a.txt',
      'b.txt',
    ])
    // 传完重读这一层：新文件要出现在列表里
    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2))
  })

  it('拖出：`dataTransfer` 里是**文件引用**（自定义类型 + 路径），不是一个附件', async () => {
    vi.mocked(listFiles).mockResolvedValue(
      listing({
        entries: [
          {
            key: 'out/报告.pdf',
            name: '报告.pdf',
            is_dir: false,
            size_bytes: 2048,
            modified_at: null,
            kind: 'pdf',
          },
        ],
      }),
    )
    const { drawer } = await openDrawer()
    await within(drawer).findByText('报告.pdf')

    // jsdom 没有 `DataTransfer`：给 `dragstart` 一个把写入记下来的假对象
    // （旧 Vue 用例也是这么做的——这里真正要钉的是"写了什么"）
    const store = new Map<string, string>()
    const transfer = {
      setData: (type: string, value: string) => store.set(type, value),
      getData: (type: string) => store.get(type) ?? '',
      effectAllowed: '',
      files: [] as unknown as FileList,
      types: [] as string[],
    }
    const row = within(drawer).getByText('报告.pdf').closest('[draggable]') as HTMLElement
    expect(row).not.toBeNull()
    fireEvent.dragStart(row, { dataTransfer: transfer })

    // 类型与 payload 与旧 `FileDrawer.onDragStart` 逐字一致（`Composer` 按它分流：
    // 有这个类型 = 「松开以引用此文件」；没有它、只有 `Files` = 「松开以添加附件」）
    expect(store.get('application/x-kylab-file')).toBe(
      JSON.stringify({ key: 'out/报告.pdf', name: '报告.pdf', is_dir: false }),
    )
    // 拖到别的应用（编辑器、聊天窗口）时至少落下一个路径
    expect(store.get('text/plain')).toBe('out/报告.pdf')
    expect(transfer.effectAllowed).toBe('copy')
    // **不是附件**：一个真文件的拖拽会落在 `Files` 那一档，这里只有引用
    expect(store.has('Files')).toBe(false)
    expect(store.size).toBe(2)
  })
})
