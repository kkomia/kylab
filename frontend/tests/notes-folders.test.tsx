/**
 * 笔记文件夹：左栏那棵树（v14）。
 *
 * 分两层钉：
 *
 * 1. **纯函数**（`features/notes/folders.ts`）：建树、可见顺序、子树范围、路径。
 *    坏数据（父不在、成环）在这里就能造出来对拍——界面上几乎触发不到，
 *    但它们一旦发生就是"整块列表消失"或"页面转死"；
 * 2. **页面行为**：ARIA 结构、按文件夹过滤列表、建/改名/删/移动（含键盘走位）。
 *
 * 样式契约照旧读源码（vitest 默认 `css: false`，`getComputedStyle` 在 jsdom 里
 * 只会读到默认值）。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Note, NoteFolder, NoteListItem } from '@/api/notes'

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

import {
  buildFolderTree,
  descendantIds,
  folderOptions,
  folderPath,
  subtreeStats,
  visibleFolders,
} from '@/features/notes/folders'
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

/* ------------------------------------------------------------ 造数据 */

function folder(id: string, name: string, overrides: Partial<NoteFolder> = {}): NoteFolder {
  return {
    id,
    name,
    parent_id: null,
    note_count: 0,
    created_at: null,
    updated_at: null,
    ...overrides,
  }
}

const FOLDERS: NoteFolder[] = [
  folder('f_work', '工作', { note_count: 2 }),
  folder('f_meet', '会议', { parent_id: 'f_work', note_count: 1 }),
  folder('f_life', '生活'),
]

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
    created_at: '2026-09-23T12:00:00Z',
    updated_at: '2026-09-23T12:00:00Z',
    ...overrides,
  }
}

function listItem(id: string, overrides: Partial<NoteListItem> = {}): NoteListItem {
  return { ...note(id), content_md: '', preview: `${id} 的预览`, ...overrides }
}

function renderPage(initialEntry = '/notes/n1') {
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

/** 等那棵树长出来（它要等 `GET /notes/folders` 的读数）。 */
async function findTree(): Promise<HTMLElement> {
  return await screen.findByRole('tree', { name: '笔记文件夹' })
}

/** 树上的某一行（按可见文字找，标题为 `name` 的那一行）。 */
function treeRow(tree: HTMLElement, name: string): HTMLElement {
  const row = within(tree)
    .getAllByRole('treeitem')
    .find((item) => item.querySelector('.folder-label')?.textContent === name)
  if (!row) throw new Error(`树里没有「${name}」这一行`)
  return row
}

const css = (() => {
  const path = fileURLToPath(new NodeURL('../src/features/notes/notes.css', import.meta.url))
  return readFileSync(path, 'utf8')
})()

function cssRule(selector: string): string {
  const index = css.indexOf(`${selector} {`)
  if (index < 0) throw new Error(`notes.css 里没有 ${selector}`)
  return css.slice(index, css.indexOf('}', index))
}

beforeEach(() => {
  window.localStorage.clear()
  useNotesStore.setState({ query: '', activeTag: '', activeFolder: '' })
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
    items: [listItem('n1', { folder_id: 'f_work' })],
    total: 1,
    limit: 100,
    offset: 0,
  })
  getNote.mockImplementation((id: string) => Promise.resolve(note(id, { folder_id: 'f_work' })))
  listNoteTags.mockResolvedValue({ items: [] })
  listNoteFolders.mockResolvedValue({
    items: FOLDERS,
    unfiled_count: 3,
    total_count: 6,
  })
  listKnowledgeBases.mockResolvedValue({ items: [] })
  createNoteFolder.mockResolvedValue(folder('f_new', '新文件夹'))
  renameNoteFolder.mockResolvedValue(folder('f_work', '工作台'))
  moveNoteFolder.mockResolvedValue(folder('f_life', '生活', { parent_id: 'f_work' }))
  deleteNoteFolder.mockResolvedValue(undefined)
  moveNote.mockImplementation((id: string, folderId: string | null) =>
    Promise.resolve(note(id, { folder_id: folderId })),
  )
  updateNote.mockImplementation((id: string, payload: Record<string, unknown>) =>
    Promise.resolve({ ...note(id), ...payload }),
  )
  createNote.mockResolvedValue(note('fresh', { title: '', content_md: '' }))
})

/* ------------------------------------------------------------ 纯函数 */

describe('文件夹树：纯函数', () => {
  it('按 parent_id 拼成树，同级保持后端给的名字顺序', () => {
    const tree = buildFolderTree(FOLDERS)

    expect(tree.map((node) => node.folder.name)).toEqual(['工作', '生活'])
    expect(tree[0].children.map((node) => node.folder.name)).toEqual(['会议'])
  })

  it('父不在这一份列表里（或指向自己）→ 挂到根级，不许凭空消失', () => {
    const orphan = folder('f_orphan', '孤儿', { parent_id: 'f_missing' })
    const selfLoop = folder('f_self', '自指', { parent_id: 'f_self' })

    const tree = buildFolderTree([orphan, selfLoop])

    expect(tree.map((node) => node.folder.id).sort()).toEqual(['f_orphan', 'f_self'])
  })

  it('互相指向（成环）也不会转死：环上第一个节点挂根级', () => {
    const a = folder('f_a', 'A', { parent_id: 'f_b' })
    const b = folder('f_b', 'B', { parent_id: 'f_a' })

    const tree = buildFolderTree([a, b])

    const flat = tree.flatMap((node) => [node.folder.id, ...node.children.map((c) => c.folder.id)])
    expect(new Set(flat)).toEqual(new Set(['f_a', 'f_b']))
  })

  it('可见顺序是先序遍历；折叠起来的子树不在里面', () => {
    const tree = buildFolderTree(FOLDERS)

    expect(visibleFolders(tree, new Set()).map((item) => item.folder.name)).toEqual([
      '工作',
      '会议',
      '生活',
    ])
    expect(visibleFolders(tree, new Set(['f_work'])).map((item) => item.folder.name)).toEqual([
      '工作',
      '生活',
    ])
    // 层级：会议是工作下面的一层
    expect(visibleFolders(tree, new Set())[1].level).toBe(2)
  })

  it('子树范围与路径：移动菜单靠它排除"移进去就成环"的位置', () => {
    expect([...descendantIds(FOLDERS, 'f_work')]).toEqual(['f_meet'])
    expect(folderPath(FOLDERS, 'f_meet')).toBe('工作 / 会议')
    expect(folderPath(FOLDERS, 'f_work')).toBe('工作')

    const options = folderOptions(FOLDERS, 'f_work')
    expect(options.map((option) => option.id)).toEqual(['f_life'])
  })

  it('菜单候选按树的先序给出完整路径（同名不同层才分得清）', () => {
    const folders = [folder('f_a', 'A'), folder('f_b', 'B', { parent_id: 'f_a' })]

    expect(folderOptions(folders).map((option) => option.path)).toEqual(['A', 'A / B'])
  })

  it('删一个文件夹会带走多少：子文件夹数与里面的笔记数（含子孙）', () => {
    expect(subtreeStats(FOLDERS, 'f_work')).toEqual({ folders: 1, notes: 3 })
    expect(subtreeStats(FOLDERS, 'f_life')).toEqual({ folders: 0, notes: 0 })
  })
})

/* ------------------------------------------------------------ 页面：树与 ARIA */

describe('文件夹树：ARIA 与可见状态', () => {
  it('role=tree/treeitem、aria-level/aria-expanded/aria-selected 都在该在的行上', async () => {
    renderPage('/notes/n1')
    const tree = await findTree()

    expect(tree.getAttribute('role')).toBe('tree')
    const rows = within(tree).getAllByRole('treeitem')
    // 全部 / 未归档 / 工作 / 会议 / 生活
    expect(rows).toHaveLength(5)

    const all = treeRow(tree, '全部')
    const unfiled = treeRow(tree, '未归档')
    const work = treeRow(tree, '工作')
    const meet = treeRow(tree, '会议')

    expect(all.getAttribute('aria-level')).toBe('1')
    expect(meet.getAttribute('aria-level')).toBe('2')
    // 展开态只出现在真有子节点的行上（叶子节点报展开态是噪音）
    expect(work.getAttribute('aria-expanded')).toBe('true')
    expect(meet.getAttribute('aria-expanded')).toBeNull()
    expect(unfiled.getAttribute('aria-selected')).toBe('false')
    // 一棵树只有一个 tab stop（roving tabindex）
    expect(tree.querySelectorAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1)
  })

  it('每行都带条数：文件夹各自的数量、未归档与全部各一个', async () => {
    renderPage('/notes/n1')
    const tree = await findTree()

    const countOf = (name: string): string =>
      treeRow(tree, name).querySelector('.folder-count')?.textContent ?? ''

    expect(countOf('全部')).toBe('6')
    expect(countOf('未归档')).toBe('3')
    expect(countOf('工作')).toBe('2')
    expect(countOf('会议')).toBe('1')
  })

  it('点一个文件夹就按它过滤列表；未归档走同一个轴上的另一个取值', async () => {
    const user = userEvent.setup()
    renderPage('/notes/n1')
    const tree = await findTree()

    await user.click(treeRow(tree, '工作'))
    await waitFor(() =>
      expect(listNotes).toHaveBeenLastCalledWith({ folder: 'f_work', limit: 100 }),
    )
    expect(treeRow(tree, '工作').getAttribute('aria-selected')).toBe('true')

    await user.click(treeRow(tree, '未归档'))
    await waitFor(() =>
      expect(listNotes).toHaveBeenLastCalledWith({ folder: 'unfiled', limit: 100 }),
    )

    await user.click(treeRow(tree, '全部'))
    await waitFor(() => expect(listNotes).toHaveBeenLastCalledWith({ limit: 100 }))
  })

  it('在文件夹里新建笔记：落在当前这个文件夹里（否则新笔记会看不见）', async () => {
    const user = userEvent.setup()
    renderPage('/notes/n1')
    const tree = await findTree()
    await user.click(treeRow(tree, '工作'))
    await waitFor(() => expect(useNotesStore.getState().activeFolder).toBe('f_work'))

    await user.click(screen.getByLabelText('新建笔记'))

    await waitFor(() =>
      expect(createNote).toHaveBeenCalledWith({ title: '', content_md: '', folder_id: 'f_work' }),
    )
  })

  it('列表为空时那句空态跟着作用域变（在文件夹里说"还没有笔记"会吓人）', async () => {
    listNotes.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 })
    const user = userEvent.setup()
    renderPage('/notes/n1')
    const tree = await findTree()

    await user.click(treeRow(tree, '会议'))

    expect(await screen.findByText('「工作 / 会议」里还没有笔记')).toBeTruthy()
  })
})

/* ------------------------------------------------------------ 页面：建 / 改名 / 删 / 移动 */

describe('文件夹：建 / 改名 / 删 / 移动', () => {
  it('新建文件夹：对话框里输入名字，建在根级', async () => {
    const user = userEvent.setup()
    renderPage('/notes/n1')
    await findTree()

    await user.click(screen.getByLabelText('新建文件夹'))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('文件夹名'), '合同')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(createNoteFolder).toHaveBeenCalledWith({ name: '合同', parent_id: null }),
    )
  })

  it('行菜单里的"新建子文件夹"带上父级；重命名只改名字', async () => {
    const user = userEvent.setup()
    renderPage('/notes/n1')
    const tree = await findTree()

    await user.click(within(treeRow(tree, '工作')).getByLabelText('工作 的操作'))
    await user.click(await screen.findByRole('menuitem', { name: '新建子文件夹' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('文件夹名'), '周会')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(createNoteFolder).toHaveBeenCalledWith({ name: '周会', parent_id: 'f_work' }),
    )
  })

  it('重命名：菜单 → 对话框填的是原名，提交只发改名那一项', async () => {
    const user = userEvent.setup()
    renderPage('/notes/n1')
    const tree = await findTree()

    await user.click(within(treeRow(tree, '工作')).getByLabelText('工作 的操作'))
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }))
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByLabelText('文件夹名') as HTMLInputElement
    expect(input.value).toBe('工作')

    await user.clear(input)
    await user.type(input, '工作台')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(renameNoteFolder).toHaveBeenCalledWith('f_work', '工作台'))
  })

  it('移动文件夹：候选里没有自己与子孙（键盘也能走通子菜单）', async () => {
    const user = userEvent.setup()
    renderPage('/notes/n1')
    const tree = await findTree()

    await user.click(within(treeRow(tree, '工作')).getByLabelText('工作 的操作'))
    // 菜单打开后焦点在菜单容器上，三次 ↓ 走到「移动到」，再 → 进子菜单：
    // 这条路径同时钉住"菜单里的方向键不会被外层那棵树截走"
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowRight}')
    const submenu = await screen.findByRole('menuitem', { name: '根目录' })
    expect(submenu).toBeTruthy()
    // 会议是工作的子文件夹，不该出现在候选里
    expect(screen.queryByRole('menuitem', { name: '工作 / 会议' })).toBeNull()

    await user.click(screen.getByRole('menuitem', { name: '生活' }))

    await waitFor(() => expect(moveNoteFolder).toHaveBeenCalledWith('f_work', 'f_life'))
  })

  it('删文件夹：确认框把后果说全（子文件夹数 + 笔记回到未归档），删完退回全部', async () => {
    const user = userEvent.setup()
    renderPage('/notes/n1')
    const tree = await findTree()
    await user.click(treeRow(tree, '工作'))
    await waitFor(() => expect(useNotesStore.getState().activeFolder).toBe('f_work'))

    await user.click(within(treeRow(tree, '工作')).getByLabelText('工作 的操作'))
    await user.click(await screen.findByRole('menuitem', { name: '删除' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/1 个子文件夹会被一起删除/)).toBeTruthy()
    expect(within(dialog).getByText(/3 篇笔记会回到未归档，不会被删除/)).toBeTruthy()

    await user.click(within(dialog).getByRole('button', { name: '删除' }))

    await waitFor(() => expect(deleteNoteFolder).toHaveBeenCalledWith('f_work'))
    // 选中的正是被删的那一支 → 退回"全部"，而不是停在一个永远空的筛选上
    await waitFor(() => expect(useNotesStore.getState().activeFolder).toBe(''))
  })

  it('另一个标签页删掉了正选着的文件夹 → 自动退回全部（读数一到就判）', async () => {
    listNoteFolders.mockResolvedValue({ items: [], unfiled_count: 0, total_count: 1 })
    useNotesStore.setState({ activeFolder: 'f_gone' })
    renderPage('/notes/n1')

    await findTree()

    await waitFor(() => expect(useNotesStore.getState().activeFolder).toBe(''))
    await waitFor(() => expect(listNotes).toHaveBeenLastCalledWith({ limit: 100 }))
  })
})

/* ------------------------------------------------------------ 页面：笔记的移动 */

describe('笔记：移动到文件夹', () => {
  it('工具栏那条路径把笔记移进去，按钮标题跟着说"现在在哪儿"', async () => {
    const user = userEvent.setup()
    renderPage('/notes/n1')
    await screen.findByLabelText('笔记标题')

    await user.click(screen.getByLabelText('移动到文件夹'))
    // 同名不同层靠完整路径区分
    await user.click(await screen.findByRole('menuitem', { name: '工作 / 会议' }))

    await waitFor(() => expect(moveNote).toHaveBeenCalledWith('n1', 'f_meet'))
    await waitFor(() => expect(screen.getByTitle('已在「工作 / 会议」')).toBeTruthy())
  })

  it('移回未归档是同一个菜单里的另一项', async () => {
    const user = userEvent.setup()
    renderPage('/notes/n1')
    await screen.findByLabelText('笔记标题')

    await user.click(screen.getByLabelText('移动到文件夹'))
    await user.click(await screen.findByRole('menuitem', { name: '未归档' }))

    await waitFor(() => expect(moveNote).toHaveBeenCalledWith('n1', null))
  })
})

/* ------------------------------------------------------------ 键盘 */

describe('文件夹树：键盘', () => {
  it('方向键走位、→ 展开/进子层、← 收起/回父层、Home/End 首尾、Enter 选中', async () => {
    renderPage('/notes/n1')
    const tree = await findTree()
    const rows = within(tree).getAllByRole('treeitem')
    const focusedKey = (): string | null =>
      document.activeElement?.getAttribute('data-folder-key') ?? null

    // Tab 进树停在当前选中的那一行（没有选中时是「全部」）
    rows[0].focus()
    expect(focusedKey()).toBe('scope:all')

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    expect(focusedKey()).toBe('scope:unfiled')
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    expect(focusedKey()).toBe('f_work')
    // 已展开的 → 进第一个子节点
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' })
    expect(focusedKey()).toBe('f_meet')

    // 叶子节点上按 ← 回父层（叶子没有"收起"这件事，那是它的父节点的事）
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    expect(focusedKey()).toBe('f_work')
    // 父节点上再按 ← 才收起：收起的子树整个不在可见序列里
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    expect(treeRow(tree, '工作').getAttribute('aria-expanded')).toBe('false')
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(4)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' })
    expect(treeRow(tree, '工作').getAttribute('aria-expanded')).toBe('true')
    // 展开之后 → 是"进第一个子节点"（不是再展开一次）
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' })
    expect(focusedKey()).toBe('f_meet')

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' })
    expect(focusedKey()).toBe('f_life')
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' })
    expect(focusedKey()).toBe('scope:all')

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' })
    await waitFor(() => expect(useNotesStore.getState().activeFolder).toBe('f_work'))
  })

  it('F2 也能改名（键盘那条路不只靠鼠标菜单）', async () => {
    renderPage('/notes/n1')
    const tree = await findTree()
    const row = treeRow(tree, '工作')
    row.focus()

    fireEvent.keyDown(row, { key: 'F2' })

    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByLabelText('文件夹名')).toHaveValue('工作')
  })

  it('Tab 只停一行：行内那些按钮（展开箭头 / 行菜单）都不在 Tab 序里', async () => {
    renderPage('/notes/n1')
    const tree = await findTree()

    const tabbable = tree.querySelectorAll('[tabindex="0"]')
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0].getAttribute('role')).toBe('treeitem')
    // 展开箭头与行菜单是鼠标入口（键盘走 ->/<- 与 Shift+F10 / F2 / Delete）
    for (const button of within(tree).getAllByRole('button')) {
      expect(button.getAttribute('tabindex')).toBe('-1')
    }
  })

  it('Shift+F10 打开这一行的菜单；Delete 直接进删除确认', async () => {
    renderPage('/notes/n1')
    const tree = await findTree()
    const row = treeRow(tree, '工作')
    row.focus()

    fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
    expect(await screen.findByRole('menuitem', { name: '重命名' })).toBeTruthy()
    // 先关掉菜单，再试 Delete（不然那一下会落在菜单里）
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '重命名' })).toBeNull())

    fireEvent.keyDown(row, { key: 'Delete' })

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('删除「工作」？')).toBeTruthy()
  })
})

/* ------------------------------------------------------------ 样式契约 */

describe('文件夹树：样式契约', () => {
  it('树自己滚（文件夹多了不许把笔记列表推下去）且行高固定', () => {
    expect(cssRule('.folder-tree')).toMatch(/max-height:\s*\d+vh/)
    expect(cssRule('.folder-tree')).toMatch(/overflow-y:\s*auto/)
    expect(cssRule('.folder-row')).toMatch(/height:\s*\d+px/)
  })

  it('键盘焦点在树上要看得见（方向键走位靠它）', () => {
    expect(cssRule('.folder-row:focus-visible')).toMatch(/outline:/)
  })
})
