/**
 * 笔记页：**左列表 + 右编辑器两栏**，列表可折叠、两列各自滚。
 *
 * 旧用例是 `tests/unit/views/NotesView.test.ts`（版式契约）加 `stores/notes.test.ts`
 * 的一部分；这里按行为重排，钉住七件事：
 *
 * 1. 列表渲染（分组、置顶、预览、未命名笔记、空态）；
 * 2. 折叠：开关一开一合，列表**移出 DOM**（不只是 CSS 藏起来），状态落 localStorage、
 *    刷新后仍折叠；折叠态把第一列压成 44px 的窄导轨；
 * 3. **两列各自滚**：`.notes-list` 与 `.notes-pane` 各自 `overflow-y: auto` 且撑满
 *    可用高度，页面自己占满内容区（外层那条滚动条在这页无事可做）——用户报过的
 *    "目录与正文共用一条滚动条"就是这一条退化；
 * 4. 工具栏**吸顶**：它长在正文列的滚动容器里，链路上没有会裁掉 sticky 的一级；
 * 5. 搜索（防抖）/标签过滤/新建/删除/加入知识库（"移动"）；
 * 6. 保存：防抖自动保存、Ctrl/Cmd+S、切换前静默落盘、保存状态标签；
 * 7. 切换笔记：命中本地缓存就不回源；悬停先预取。
 *
 * 样式契约读源码：vitest 默认 `css: false`，样式表不进 jsdom，`getComputedStyle`
 * 只会永远读到默认值（旧前端 NotesView.test.ts 留过同一条注记）。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Note, NoteListItem } from '@/api/notes'

const listNotes = vi.fn()
const getNote = vi.fn()
const listNoteTags = vi.fn()
const createNote = vi.fn()
const updateNote = vi.fn()
const deleteNote = vi.fn()
const attachNote = vi.fn()
const aiTransform = vi.fn()
const uploadNoteImage = vi.fn()
const listNoteFolders = vi.fn()
const createNoteFolder = vi.fn()
const renameNoteFolder = vi.fn()
const moveNoteFolder = vi.fn()
const deleteNoteFolder = vi.fn()
const moveNote = vi.fn()
const listKnowledgeBases = vi.fn()

vi.mock('@/api/notes', () => ({
  listNotes: (...args: unknown[]) => listNotes(...args),
  getNote: (...args: unknown[]) => getNote(...args),
  listNoteTags: (...args: unknown[]) => listNoteTags(...args),
  createNote: (...args: unknown[]) => createNote(...args),
  updateNote: (...args: unknown[]) => updateNote(...args),
  deleteNote: (...args: unknown[]) => deleteNote(...args),
  attachNote: (...args: unknown[]) => attachNote(...args),
  aiTransform: (...args: unknown[]) => aiTransform(...args),
  uploadNoteImage: (...args: unknown[]) => uploadNoteImage(...args),
  listNoteFolders: (...args: unknown[]) => listNoteFolders(...args),
  createNoteFolder: (...args: unknown[]) => createNoteFolder(...args),
  renameNoteFolder: (...args: unknown[]) => renameNoteFolder(...args),
  moveNoteFolder: (...args: unknown[]) => moveNoteFolder(...args),
  deleteNoteFolder: (...args: unknown[]) => deleteNoteFolder(...args),
  moveNote: (...args: unknown[]) => moveNote(...args),
}))

vi.mock('@/api/knowledgeBases', () => ({
  listKnowledgeBases: (...args: unknown[]) => listKnowledgeBases(...args),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}))

import { useNotesStore } from '@/features/notes/store'
import NotesView from '@/features/notes/NotesView'

/** jsdom 的 `Range` 没有这两个方法，而 ProseMirror 的 `.focus()` 会去量文字矩形。 */
const ZERO_RECT = {
  x: 0,
  y: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
} as DOMRect

if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects(): DOMRectList {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList
  }
  Range.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return ZERO_RECT
  }
}

/** 与页面里写死的那个键一致：它是"刷新后还折叠"的凭据，属于对外行为。 */
const COLLAPSED_KEY = 'kylab-notes-list-collapsed'

/** 同上：标签区折叠偏好（**默认折叠**，展开才落 "0"）。 */
const TAGS_COLLAPSED_KEY = 'kylab-notes-tags-collapsed'

/**
 * 标签区折叠时 chip 不在 DOM 里（与列表折叠同一口径：收起来的东西不留着渲染）。
 * 要点开标签的用例都从这里进——这也是用户真实走的那一步。
 */
async function expandTags(): Promise<HTMLElement> {
  const toggle = await screen.findByRole('button', { name: /标签/ })
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
  return toggle
}

const TODAY = new Date()
const AT = (daysAgo: number, hour = 12): string => {
  const date = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate(), hour)
  date.setDate(date.getDate() - daysAgo)
  return date.toISOString()
}

function note(id: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    title: id,
    content_md: `${id} 的正文`,
    source_kind: 'manual',
    source_ref: null,
    kb_id: null,
    doc_id: null,
    folder_id: null,
    pinned: false,
    tags: [],
    created_at: AT(1),
    updated_at: AT(1),
    ...overrides,
  }
}

function listItem(id: string, overrides: Partial<NoteListItem> = {}): NoteListItem {
  return { ...note(id), content_md: '', preview: `${id} 的预览`, ...overrides }
}

interface PageHandle {
  client: QueryClient
  view: ReturnType<typeof render>
}

function renderPage(initialEntry = '/notes/n1'): PageHandle {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/notes" element={<NotesView />} />
          <Route path="/notes/:noteId" element={<NotesView />} />
          <Route path="/documents/:docId" element={<div>文档页</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { client, view }
}

/** 等页面把这条笔记装载进编辑器（标题输入框就是装载完成的凭据）。 */
async function waitForDraft(title: string): Promise<HTMLInputElement> {
  const input = (await screen.findByLabelText('笔记标题')) as HTMLInputElement
  await waitFor(() => expect(input.value).toBe(title))
  return input
}

beforeEach(() => {
  window.localStorage.clear()
  useNotesStore.setState({ query: '', activeTag: '' })
  for (const mock of [
    listNotes,
    getNote,
    listNoteTags,
    createNote,
    updateNote,
    deleteNote,
    attachNote,
    aiTransform,
    uploadNoteImage,
    listNoteFolders,
    createNoteFolder,
    renameNoteFolder,
    moveNoteFolder,
    deleteNoteFolder,
    moveNote,
    listKnowledgeBases,
  ]) {
    mock.mockReset()
  }
  toastError.mockReset()
  toastSuccess.mockReset()

  listNotes.mockResolvedValue({
    items: [listItem('n1'), listItem('n2', { updated_at: AT(2) })],
    total: 2,
    limit: 100,
    offset: 0,
  })
  getNote.mockImplementation((id: string) => Promise.resolve(note(id)))
  listNoteTags.mockResolvedValue({ items: [] })
  // 默认还没有文件夹：那棵树只摆「全部 / 未归档」两行（文件夹相关的用例各自覆盖）
  listNoteFolders.mockResolvedValue({ items: [], unfiled_count: 2, total_count: 2 })
  listKnowledgeBases.mockResolvedValue({ items: [] })
  updateNote.mockImplementation((id: string, payload: Record<string, unknown>) =>
    Promise.resolve({ ...note(id), ...payload }),
  )
  deleteNote.mockResolvedValue(undefined)
})

describe('笔记页：列表', () => {
  it('按时间线分组渲染，置顶单独一组，预览/日期/未命名都有交代', async () => {
    listNotes.mockResolvedValue({
      items: [
        listItem('pinned', { title: '置顶的', pinned: true, updated_at: AT(90) }),
        listItem('today', { title: '今天的', updated_at: AT(0) }),
        listItem('untitled', { title: '', preview: '' }),
      ],
      total: 3,
      limit: 100,
      offset: 0,
    })
    // 条数与作用域现在由树上那两行给出（原来是头部的一行标题）：
    // 全部 3 / 未归档 N 都在树里，所以这一份读数要跟着给
    listNoteFolders.mockResolvedValue({ items: [], unfiled_count: 0, total_count: 3 })
    renderPage('/notes/n1')

    const list = await screen.findByRole('complementary')
    const tree = await within(list).findByRole('tree', { name: '笔记文件夹' })
    expect(within(tree).getByText('全部')).toBeTruthy()
    expect(within(tree).getByText('3')).toBeTruthy()

    // 分组标签：置顶单独一组（哪怕它是很久以前的），其余按时间分桶
    expect(within(list).getByText('置顶')).toBeTruthy()
    expect(within(list).getByText('今天')).toBeTruthy()
    expect(within(list).getByText('过去 7 天')).toBeTruthy()

    // 没有标题的笔记给"未命名笔记"，没有预览给"（空）"
    expect(within(list).getByText('未命名笔记')).toBeTruthy()
    expect(within(list).getByText('（空）')).toBeTruthy()
    // 列表项是指向该笔记的链接
    expect(within(list).getByText('今天的').closest('a')?.getAttribute('href')).toBe('/notes/today')
  })

  it('一条都没有时给空态指路；没有选中笔记时编辑区给另一句', async () => {
    listNotes.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 })
    renderPage('/notes')

    expect(await screen.findByText('还没有笔记')).toBeTruthy()
    expect(screen.getByText('点右上角的 + 写第一条')).toBeTruthy()
    expect(screen.getByText('选择一条笔记开始编辑')).toBeTruthy()
  })

  it('标签条按使用次数给出过滤入口（没有标签就不占地方）', async () => {
    listNoteTags.mockResolvedValue({
      items: [
        { tag: '工作', count: 3 },
        { tag: '灵感', count: 1 },
      ],
    })
    renderPage('/notes/n1')

    // 标签区**默认折叠**（用户反馈："标签一多就太多了"）：先点开那一行小标题
    await expandTags()
    const chip = await screen.findByRole('button', { name: /工作/ })
    fireEvent.click(chip)

    await waitFor(() => expect(listNotes).toHaveBeenLastCalledWith({ tag: '工作', limit: 100 }))
    // 再点一次取消过滤
    fireEvent.click(chip)
    await waitFor(() => expect(listNotes).toHaveBeenLastCalledWith({ limit: 100 }))
  })

  it('标签按"时间 / 来源 / 状态"分三组（三种语义不再混在一排）', async () => {
    listNoteTags.mockResolvedValue({
      items: [
        { tag: '2026-09', count: 3 },
        { tag: 'AI日报', count: 2 },
        { tag: '已核实', count: 1 },
      ],
    })
    renderPage('/notes/n1')

    await expandTags()
    await screen.findByRole('button', { name: /2026-09/ })
    // 三组的小标题按语义顺序出现；空的那一组不占位置
    const labels = [...document.querySelectorAll('.tag-group-label')].map((n) => n.textContent)
    expect(labels).toEqual(['时间', '来源', '状态'])

    const groups = [...document.querySelectorAll('.tag-group')]
    expect(groups[0].querySelector('.tag-chip')?.textContent).toContain('2026-09')
    expect(groups[1].querySelector('.tag-chip')?.textContent).toContain('AI日报')
    expect(groups[2].querySelector('.tag-chip')?.textContent).toContain('已核实')
    // 计数与标签之间有分隔记号：`2026-09` 后面直接跟一个 `3` 会被读成"2026-09-3"
    expect(groups[0].querySelector('.tag-chip')?.textContent).toContain('· 3')

    // 分组只影响显示，过滤仍然是"点哪个筛哪个"
    fireEvent.click(screen.getByRole('button', { name: /2026-09/ }))
    await waitFor(() => expect(listNotes).toHaveBeenLastCalledWith({ tag: '2026-09', limit: 100 }))
  })

  it('标签区默认折叠：一行小标题（标签 3）+ caret，点开才有 chip，偏好落 localStorage', async () => {
    listNoteTags.mockResolvedValue({
      items: [
        { tag: '工作', count: 3 },
        { tag: '灵感', count: 1 },
        { tag: '已核实', count: 1 },
      ],
    })
    renderPage('/notes/n1')

    const toggle = await screen.findByRole('button', { name: /标签/ })
    // 默认折叠：一个 chip 都不渲染，展开态是"点开之后才有"的东西
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.tag-chip')).toBeNull()
    expect(document.querySelector('.tag-bar')?.className).toContain('tag-bar-collapsed')
    // 折叠是默认值，存储里不该留下一条无意义的状态
    expect(window.localStorage.getItem(TAGS_COLLAPSED_KEY)).toBeNull()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelectorAll('.tag-chip')).toHaveLength(3)
    // 展开是非默认值，才落一条 "0"
    expect(window.localStorage.getItem(TAGS_COLLAPSED_KEY)).toBe('0')
    // 折叠态那一行本身也只有一行：结构上它只是一个按钮 + 计数
    expect(toggle.textContent).toContain('标签')

    fireEvent.click(toggle)
    expect(document.querySelector('.tag-chip')).toBeNull()
    expect(window.localStorage.getItem(TAGS_COLLAPSED_KEY)).toBeNull()
  })

  it('折叠态也说得出"现在按哪个标签看"：选中的标签留在那一行里', async () => {
    listNoteTags.mockResolvedValue({ items: [{ tag: '工作', count: 3 }] })
    renderPage('/notes/n1')

    await expandTags()
    fireEvent.click(await screen.findByRole('button', { name: /工作/ }))
    fireEvent.click(screen.getByRole('button', { name: /标签/ })) // 收起

    const bar = document.querySelector('.tag-bar') as HTMLElement
    expect(bar.className).toContain('tag-bar-collapsed')
    // 列表被筛过，屏幕上得有个东西说明为什么只剩这几条
    expect(bar.querySelector('.tag-chip')?.textContent).toContain('工作')
  })

  it('搜索：输入后防抖 300ms 才落到过滤条件上（不会每敲一个字发一次）', async () => {
    renderPage('/notes/n1')
    const search = screen.getByLabelText('搜索笔记')

    fireEvent.change(search, { target: { value: '会议' } })
    expect(listNotes).toHaveBeenCalledTimes(1) // 只有首屏那次

    await waitFor(() => expect(listNotes).toHaveBeenLastCalledWith({ q: '会议', limit: 100 }))
  })
})

describe('笔记页：列表折叠', () => {
  it('折叠开关一开一合，列表整块进出 DOM，状态写进 localStorage', async () => {
    renderPage('/notes/n1')
    const layout = document.querySelector('.notes-layout') as HTMLElement
    expect(layout.className).not.toContain('list-collapsed')
    expect(document.querySelector('.note-groups')).toBeTruthy()
    expect(screen.getByLabelText('折叠笔记列表').getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByLabelText('折叠笔记列表'))

    expect((document.querySelector('.notes-layout') as HTMLElement).className).toContain(
      'list-collapsed',
    )
    // 折叠后列表是**移出 DOM**、不只是被样式藏起来：窄导轨里不该留着搜索框与上百行列表
    expect(document.querySelector('.note-groups')).toBeNull()
    expect(document.querySelector('.search-box')).toBeNull()
    // 展开入口留在原地（否则折叠就成了"再也叫不回来"），且读得出当前状态
    expect(screen.getByLabelText('展开笔记列表').getAttribute('aria-expanded')).toBe('false')
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe('1')

    fireEvent.click(screen.getByLabelText('展开笔记列表'))

    expect((document.querySelector('.notes-layout') as HTMLElement).className).not.toContain(
      'list-collapsed',
    )
    expect(document.querySelector('.note-groups')).toBeTruthy()
    // 展开态不写 "0"，而是把键清掉：默认值就是展开，别在存储里留一条无意义的状态
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBeNull()
  })

  it('刷新后仍然折叠（初值取自 localStorage）', async () => {
    window.localStorage.setItem(COLLAPSED_KEY, '1')
    renderPage('/notes/n1')

    expect((document.querySelector('.notes-layout') as HTMLElement).className).toContain(
      'list-collapsed',
    )
    expect(document.querySelector('.note-groups')).toBeNull()
    expect(await screen.findByLabelText('笔记标题')).toBeTruthy()
  })

  it('折叠态把列表压成一条窄导轨，剩下的宽度整份给正文（样式契约）', () => {
    // 不引入像素级断言，只钉住"第一列变成固定窄条、第二列仍是 minmax(0, 1fr)"：
    // 这正是"正文区拿到空间"的机制，改成别的写法就会失去它
    const collapsed = cssRule('.notes-layout.list-collapsed')
    expect(collapsed).toMatch(/grid-template-columns:\s*\d+px\s+minmax\(0,\s*1fr\)/)
  })
})

describe('笔记页：两列各自滚', () => {
  it('目录列与正文列各自是滚动容器：overflow-y 与高度都撑满可用高度', () => {
    for (const selector of ['.notes-list', '.notes-pane']) {
      const rule = cssRule(selector)
      expect(rule, `${selector} 要自己滚`).toMatch(/overflow-y:\s*auto/)
      expect(rule, `${selector} 要撑满可用高度`).toMatch(/height:\s*100%/)
      // 高度链上的 `min-height: 0` 不是装饰：grid 项的自动最小尺寸是**内容高**，
      // 不压到 0 的话长内容会把格子顶高，overflow 就永远不会生效
      expect(rule, `${selector} 要允许自己被内容压矮`).toMatch(/min-height:\s*0/)
    }
  })

  it('页面自己撑满内容区：外层那条滚动条不再参与这一页的滚动', () => {
    expect(cssRule('.notes-page')).toMatch(/height:\s*100%/)
    expect(cssRule('.notes-layout')).toMatch(/height:\s*100%/)
    // 根因：`align-items: start` 让两列各按**内容高**排版，页面被正文撑长，
    // 滚动只能落在最外层——正文一滚，左边那份不长的目录就被一起带走。这条不能再回来。
    expect(cssRule('.notes-layout')).not.toMatch(/align-items:\s*(?:start|flex-start)/)
  })

  it('单栏断点（<=900px）下两列不再各自滚：两段回到同一条滚动', () => {
    const stacked = mediaBlock('(max-width: 900px)')

    // 先确认这个断点确实把版式压成了单栏——不然"两列"还在，下面的还原就没意义
    expect(cssRule('.notes-layout', stacked)).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    for (const selector of ['.notes-page', '.notes-layout', '.notes-list', '.notes-pane']) {
      expect(cssRule(selector, stacked), `${selector} 在单栏下不该留着定高`).toMatch(
        /height:\s*auto/,
      )
    }
    for (const selector of ['.notes-list', '.notes-pane']) {
      expect(cssRule(selector, stacked), `${selector} 在单栏下不该自己滚`).toMatch(
        /overflow-y:\s*visible/,
      )
    }
  })
})

describe('笔记页：工具栏吸顶', () => {
  it('工具栏长在正文列里，而那一列就是滚动容器', async () => {
    renderPage('/notes/n1')
    await waitForDraft('n1')

    // sticky 相对"最近的可滚动祖先"吸附，这两条缺一不可
    expect(document.querySelector('.notes-pane .note-editor > .toolbar')).toBeTruthy()
    expect(cssRule('.notes-pane')).toMatch(/overflow-y:\s*auto/)
    expect(cssRule('.toolbar')).toMatch(/position:\s*sticky/)
    expect(cssRule('.toolbar')).toMatch(/top:\s*0/)
  })

  it('切换笔记不换编辑器：装载新正文，工具栏全程留在原地', async () => {
    renderPage('/notes/n1')
    await waitForDraft('n1')
    const toolbar = document.querySelector('.toolbar')

    fireEvent.click(screen.getByText('n2'))

    await waitForDraft('n2')
    expect(document.querySelector('.toolbar')).toBe(toolbar)
  })
})

describe('笔记页：搜索 / 新建 / 删除 / 移动', () => {
  it('新建：先落盘当前这条，再建一条空笔记并跳过去', async () => {
    createNote.mockResolvedValue(note('fresh', { title: '', content_md: '' }))
    renderPage('/notes/n1')
    await waitForDraft('n1')

    fireEvent.click(screen.getByLabelText('新建笔记'))

    // 没有选中的文件夹 → 新笔记进未归档（`folder_id: null`）
    await waitFor(() =>
      expect(createNote).toHaveBeenCalledWith({ content_md: '', title: '', folder_id: null }),
    )
    await waitFor(() => expect(screen.getByLabelText('笔记标题')).toHaveValue(''))
  })

  it('删除：确认框里点删除才真删，删完回到列表页并给成功提示', async () => {
    renderPage('/notes/n1')
    await waitForDraft('n1')

    fireEvent.click(screen.getByTitle('删除'))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('删除这条笔记？')).toBeTruthy()
    expect(deleteNote).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))

    await waitFor(() => expect(deleteNote).toHaveBeenCalledWith('n1'))
    await waitFor(() => expect(screen.getByText('选择一条笔记开始编辑')).toBeTruthy())
    expect(toastSuccess).toHaveBeenCalledWith('笔记已删除')
  })

  it('加入知识库（移动）：先落盘再入库，成功后标题栏给出"已加入"与文档入口', async () => {
    listKnowledgeBases.mockResolvedValue({
      items: [
        { id: 'kb1', name: '工作库' },
        { id: 'kb2', name: '资料库' },
      ],
    })
    attachNote.mockResolvedValue(note('n1', { kb_id: 'kb2', doc_id: 'd9' }))
    renderPage('/notes/n1')
    const title = await waitForDraft('n1')
    // 有一处未落盘的改动：入库前必须先把它写进去（入库读的是库里的正文）
    fireEvent.change(title, { target: { value: '改过的标题' } })

    fireEvent.click(screen.getByLabelText('加入知识库'))

    const dialog = await screen.findByRole('dialog')
    const select = within(dialog).getByLabelText('目标知识库')
    fireEvent.change(select, { target: { value: 'kb2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '加入' }))

    await waitFor(() => expect(attachNote).toHaveBeenCalledWith('n1', 'kb2'))
    // 入库读的是库里的正文，所以保存必须发生在入库之前
    await waitFor(() => {
      const saveOrder = updateNote.mock.invocationCallOrder[0] ?? Infinity
      expect(saveOrder).toBeLessThan(attachNote.mock.invocationCallOrder[0])
    })
    expect(await screen.findByText('已加入知识库「资料库」')).toBeTruthy()
    expect(screen.getByText('查看文档').closest('a')?.getAttribute('href')).toBe('/documents/d9')
    expect(toastSuccess).toHaveBeenCalledWith('已加入知识库，之后可以在检索里命中这条笔记')
  })

  it('没有知识库时给一句指路，不开弹窗', async () => {
    renderPage('/notes/n1')
    await waitForDraft('n1')

    fireEvent.click(screen.getByLabelText('加入知识库'))

    expect(toastError).toHaveBeenCalledWith('还没有知识库，先去「知识库」新建一个')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('笔记页：目录（正文大纲）', () => {
  it('有标题就有目录：右栏按层级列出，点一条跳过去', async () => {
    getNote.mockImplementation((id: string) =>
      Promise.resolve(note(id, { content_md: '# 第一节\n\n正文\n\n## 小节 A\n\n更多' })),
    )
    renderPage('/notes/n1')
    await waitForDraft('n1')

    const rail = await screen.findByRole('complementary', { name: '笔记目录' })
    const items = [...rail.querySelectorAll('.toc-item')]
    expect(items.map((item) => item.textContent)).toEqual(['第一节', '小节 A'])
    // 层级只用来缩进（1–3 级），不是字号
    expect(items[0].getAttribute('data-level')).toBe('1')
    expect(items[1].getAttribute('data-level')).toBe('2')
    // 有标题才有这个开关（没有锚点的目录是个空盒子）
    expect(screen.getByLabelText('目录').getAttribute('aria-expanded')).toBe('true')

    // 点它跳过去：jsdom 里量不到布局，但这一步不该炸，也不该把目录点没
    fireEvent.click(items[1])
    expect(rail.querySelectorAll('.toc-item')).toHaveLength(2)
  })

  it('目录可以收起：整栏退出布局（第三列一并去掉）', async () => {
    getNote.mockImplementation((id: string) =>
      Promise.resolve(note(id, { content_md: '# 第一节\n\n正文' })),
    )
    renderPage('/notes/n1')
    await waitForDraft('n1')
    expect(await screen.findByRole('complementary', { name: '笔记目录' })).toBeTruthy()
    expect((document.querySelector('.notes-layout') as HTMLElement).className).toContain('toc-open')

    fireEvent.click(screen.getByLabelText('目录'))

    expect(screen.queryByRole('complementary', { name: '笔记目录' })).toBeNull()
    expect((document.querySelector('.notes-layout') as HTMLElement).className).not.toContain(
      'toc-open',
    )
    // 开关还在（否则收起来就叫不回来了），读得出当前状态
    expect(screen.getByLabelText('目录').getAttribute('aria-expanded')).toBe('false')
  })

  it('没有标题的笔记不渲染目录，也不给开关', async () => {
    getNote.mockImplementation((id: string) =>
      Promise.resolve(note(id, { content_md: '一段没有标题的正文' })),
    )
    renderPage('/notes/n1')
    await waitForDraft('n1')

    expect(screen.queryByRole('complementary', { name: '笔记目录' })).toBeNull()
    expect(screen.queryByLabelText('目录')).toBeNull()
  })
})

describe('笔记页：保存', () => {
  it('改动停 800ms 才落盘（防抖），保存成功后标签是"已保存 <时间>"', async () => {
    renderPage('/notes/n1')
    const title = await waitForDraft('n1')

    fireEvent.change(title, { target: { value: '改过的标题' } })

    // 敲字当下不发请求
    expect(updateNote).not.toHaveBeenCalled()
    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(updateNote).toHaveBeenCalledWith('n1', {
      title: '改过的标题',
      content_md: 'n1 的正文',
      pinned: false,
      tags: [],
    })
    await waitFor(() => expect(screen.getByText(/^已保存 \d{2}:\d{2}$/)).toBeTruthy())
  })

  it('没有改动就不发请求（切换笔记时原来会白写一次）', async () => {
    renderPage('/notes/n1')
    await waitForDraft('n1')

    fireEvent.click(screen.getByText('n2'))
    await waitForDraft('n2')

    expect(updateNote).not.toHaveBeenCalled()
  })

  it('Ctrl/Cmd+S 直接落盘，不等防抖', async () => {
    renderPage('/notes/n1')
    const title = await waitForDraft('n1')

    fireEvent.change(title, { target: { value: '马上存' } })
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })

    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1))
    expect(updateNote.mock.calls[0][1]).toMatchObject({ title: '马上存' })
  })

  it('切换笔记时把离开的那条**静默**落盘（保存标签归下一条，不闪一下）', async () => {
    renderPage('/notes/n1')
    const title = await waitForDraft('n1')
    fireEvent.change(title, { target: { value: '改完就走' } })

    fireEvent.click(screen.getByText('n2'))
    await waitForDraft('n2')

    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1))
    expect(updateNote.mock.calls[0][0]).toBe('n1')
    expect(updateNote.mock.calls[0][1]).toMatchObject({ title: '改完就走' })
    // 静默：新笔记的标签直接是"这条的上次保存时间"，没有"保存中…"的闪现
    expect(screen.queryByText('保存中…')).toBeNull()
    expect(screen.queryByText('保存失败')).toBeNull()
  })

  it('置顶是"排序"的开关：切换后随自动保存一起落盘', async () => {
    renderPage('/notes/n1')
    await waitForDraft('n1')

    fireEvent.click(screen.getByLabelText('置顶'))

    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(updateNote.mock.calls[0][1]).toMatchObject({ pinned: true })
  })
})

describe('笔记页：切换与预取', () => {
  it('没有指定笔记时默认打开最新的一条（按 updated_at，不是列表第一条）', async () => {
    listNotes.mockResolvedValue({
      items: [
        listItem('pinned-old', { pinned: true, updated_at: AT(200) }),
        listItem('newest', { updated_at: AT(0) }),
      ],
      total: 2,
      limit: 100,
      offset: 0,
    })
    renderPage('/notes')

    await waitFor(() => expect(getNote).toHaveBeenCalledWith('newest'))
  })

  it('悬停列表项先取正文（从 hover 到点击够它落地），点击时命中缓存不再回源', async () => {
    const user = userEvent.setup()
    renderPage('/notes/n1')
    await waitForDraft('n1')

    // 打开页面后趁空闲预取的正是最靠前的几条：两条各一次
    await waitFor(() => expect(getNote).toHaveBeenCalledTimes(2))
    await user.hover(screen.getByText('n2'))
    expect(getNote.mock.calls.filter((call) => call[0] === 'n2')).toHaveLength(1)

    fireEvent.click(screen.getByText('n2'))
    await waitForDraft('n2')

    // 命中本地缓存：点击没有换来第二个请求
    expect(getNote.mock.calls.filter((call) => call[0] === 'n2')).toHaveLength(1)
  })
})

describe('笔记页：AI 动作', () => {
  it('选一档动作：先落盘再请求，结果写回正文（不满意可撤销，所以保留历史）', async () => {
    const user = userEvent.setup()
    aiTransform.mockResolvedValue({ content_md: '# 整理后的正文' })
    renderPage('/notes/n1')
    const title = await waitForDraft('n1')
    fireEvent.change(title, { target: { value: '待整理' } })

    await user.click(screen.getByLabelText('AI 处理'))
    await user.click(await screen.findByText('智能排版'))

    await waitFor(() => expect(aiTransform).toHaveBeenCalledWith('n1', 'format'))
    // 后端处理的是库里保存的正文，所以保存必须发生在请求之前
    expect(updateNote.mock.invocationCallOrder[0]).toBeLessThan(
      aiTransform.mock.invocationCallOrder[0],
    )
    await waitFor(() =>
      expect(document.querySelector('.tiptap')?.textContent).toContain('整理后的正文'),
    )
    expect(toastSuccess).toHaveBeenCalledWith('AI 处理完成；不满意可以用工具栏的撤销或直接改')
  })
})

/* --------------------------------------------------------------- 源码小工具 */

function styleText(): string {
  return readFileSync(
    fileURLToPath(new NodeURL('../src/features/notes/notes.css', import.meta.url)),
    'utf8',
  )
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 样式里某条 CSS 规则的声明块。
 *
 * 选择器写成**列表**（`a, b { … }`）时，只要列表里含这一个就认：
 * 合并规则是常态（两列共用一组重置），不该逼着样式拆成一条条单选择器。
 */
function cssRule(selector: string, source = styleText()): string {
  const rules = [...stripComments(source).matchAll(/\n\s*([^{}]+?)\s*\{([^{}]*)\}/g)]
  const found = rules.find((rule) =>
    (rule[1] ?? '').split(',').some((part) => part.trim() === selector),
  )
  expect(found, `没在源码里找到 CSS 规则 ${selector}`).toBeTruthy()
  return found?.[2] ?? ''
}

/** 样式里某个 `@media` 块的正文：按大括号配平截取，嵌套的规则都在里面。 */
function mediaBlock(query: string): string {
  const source = styleText()
  const at = source.indexOf(`@media ${query}`)
  expect(at, `没在源码里找到 @media ${query}`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  return ''
}
