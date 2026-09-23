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
import { render, screen, waitFor, within } from '@testing-library/react'
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
import { listFiles } from '@/api/conversations'

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
    expect(listFiles).toHaveBeenCalledWith('c1')

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
