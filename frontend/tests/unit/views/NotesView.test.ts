/**
 * 笔记页版式：**工具栏吸顶 + 列表可折叠**（《开发计划》§12.224 用户报的 7、8 两条）。
 *
 * 这两条都是"平时看着没事、正文一长/想给正文腾地方才难受"的问题，所以钉住的是
 * **结构契约**，不是渲染结果：
 *
 * 1. 折叠：开关切一次，`.notes-layout` 挂上 `list-collapsed`，列表整块移出 DOM，
 *    状态写进 localStorage；重新挂载（等价于刷新）后仍然是折叠的；
 * 2. 吸顶：`.toolbar` 声明 `position: sticky`，真正的滚动容器 `main.content`
 *    声明 `overflow-y: auto`，并且从工具栏往上到滚动容器之间的每一级祖先
 *    **都没有** `overflow: hidden` 之类的裁剪——加一条就会让吸顶静默失效，
 *    这是这条最容易退化的方式（`.editor-body` 不是滚动容器，它随内容长高）。
 *
 * 样式契约为什么读源码：vitest 默认 `css: false`，SFC 的 `<style>` 根本不进 jsdom，
 * `getComputedStyle` 只会永远读到默认值（`RowMenu.test.ts:207` 留过同一条注记）。
 * 读声明文本是这个环境下唯一真能钉住 CSS 的办法；也因此不做任何像素级断言。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import type { Note, NoteListItem } from '@/api/notes'

const listNotes = vi.fn()
const getNote = vi.fn()
const listNoteTags = vi.fn()

vi.mock('@/api/notes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/notes')>()
  return {
    ...actual,
    listNotes: (...args: unknown[]) => listNotes(...args),
    getNote: (...args: unknown[]) => getNote(...args),
    listNoteTags: (...args: unknown[]) => listNoteTags(...args),
    createNote: vi.fn(),
    updateNote: vi.fn(),
    deleteNote: vi.fn(),
    attachNote: vi.fn(),
    aiTransform: vi.fn(),
    uploadNoteImage: vi.fn(),
  }
})

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    notify: vi.fn(),
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
    notifyWarning: vi.fn(),
  }),
}))

vi.mock('@/stores/knowledgeBases', () => ({
  useKnowledgeBaseStore: () => ({ items: [], byId: () => undefined, load: vi.fn() }),
}))

import { clearNoteBodyCache } from '@/stores/notes'
import NotesView from '@/views/NotesView.vue'

/** 与页面里写死的那个键一致：它是"刷新后还折叠"的凭据，属于对外行为。 */
const COLLAPSED_KEY = 'kylab-notes-list-collapsed'

const NOTE: Note = {
  id: 'n1',
  title: '第一条',
  content_md: `# 标题\n\n${'正文段落。\n'.repeat(40)}`,
  source_kind: 'manual',
  source_ref: null,
  kb_id: null,
  doc_id: null,
  pinned: false,
  tags: [],
  created_at: null,
  updated_at: '2026-09-22T10:00:00',
}

const LIST_ITEM: NoteListItem = { ...NOTE, content_md: '', preview: '正文段落。' }

async function mountPage(): Promise<VueWrapper> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/notes', component: { template: '<div />' } },
      { path: '/notes/:noteId', component: { template: '<div />' } },
      { path: '/documents/:docId', component: { template: '<div />' } },
    ],
  })
  await router.push('/notes/n1')
  await router.isReady()

  const wrapper = mount(NotesView, {
    global: { plugins: [router] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

/** 源码里某条 CSS 规则的声明块（`选择器 { … }` 之间的那段）。 */
function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`\\n\\s*${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `没在源码里找到 CSS 规则 ${selector}`).toBeTruthy()
  return match?.[1] ?? ''
}

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

const editorSource = readSource('../../../src/components/notes/NoteEditor.vue')
const viewSource = readSource('../../../src/views/NotesView.vue')
const appShellSource = readSource('../../../src/App.vue')

beforeEach(() => {
  setActivePinia(createPinia())
  window.localStorage.clear()
  clearNoteBodyCache()
  listNotes.mockReset().mockResolvedValue({
    items: [LIST_ITEM],
    total: 1,
    limit: 100,
    offset: 0,
  })
  getNote.mockReset().mockResolvedValue(NOTE)
  listNoteTags.mockReset().mockResolvedValue({ items: [] })
})

describe('笔记页：列表折叠', () => {
  it('折叠开关一开一合，列表整块进出 DOM，状态写进 localStorage', async () => {
    const wrapper = await mountPage()
    const layout = wrapper.get('.notes-layout')
    expect(layout.classes()).not.toContain('list-collapsed')
    expect(wrapper.find('.note-groups').exists()).toBe(true)
    expect(wrapper.get('.collapse-toggle').attributes('aria-expanded')).toBe('true')

    await wrapper.get('.collapse-toggle').trigger('click')

    expect(wrapper.get('.notes-layout').classes()).toContain('list-collapsed')
    // 折叠后列表是**移出 DOM**、不只是被样式藏起来：窄导轨里不该留着搜索框与上百行列表
    expect(wrapper.find('.note-groups').exists()).toBe(false)
    expect(wrapper.find('.search-box').exists()).toBe(false)
    // 展开入口留在原地（否则折叠就成了"再也叫不回来"），且读得出当前状态
    expect(wrapper.get('.collapse-toggle').attributes('aria-expanded')).toBe('false')
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe('1')

    await wrapper.get('.collapse-toggle').trigger('click')

    expect(wrapper.get('.notes-layout').classes()).not.toContain('list-collapsed')
    expect(wrapper.find('.note-groups').exists()).toBe(true)
    // 展开态不写"0"，而是把键清掉：默认值就是展开，别在存储里留一条无意义的状态
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBeNull()

    wrapper.unmount()
  })

  it('刷新后仍然折叠（初值取自 localStorage）', async () => {
    window.localStorage.setItem(COLLAPSED_KEY, '1')

    const wrapper = await mountPage()

    expect(wrapper.get('.notes-layout').classes()).toContain('list-collapsed')
    expect(wrapper.find('.note-groups').exists()).toBe(false)

    wrapper.unmount()
  })

  it('折叠态把列表列压成一条窄导轨，正文列照旧吃掉剩余宽度', () => {
    // 不引入像素级断言，只钉住"第一列变成固定窄条、第二列仍是 minmax(0, 1fr)"：
    // 这正是"正文区拿到空间"的机制，改成别的写法就会失去它
    const collapsed = cssRule(viewSource, '.notes-layout.list-collapsed')
    expect(collapsed).toMatch(/grid-template-columns:\s*\d+px\s+minmax\(0,\s*1fr\)/)
  })
})

describe('笔记页：工具栏吸顶', () => {
  it('工具栏是编辑区里的 sticky 元素（真实渲染出来的那一行）', async () => {
    const wrapper = await mountPage()

    // 工具栏确实长在笔记页的编辑栏里（不是只有一个 CSS 规则摆在那儿）
    const toolbar = wrapper.get('.notes-pane .note-editor > .toolbar')
    expect(toolbar.attributes('role')).toBe('toolbar')

    const rule = cssRule(editorSource, '.toolbar')
    expect(rule).toMatch(/position:\s*sticky/)
    expect(rule).toMatch(/top:\s*0/)
    // 正文换笔记时带 opacity 过渡、会自成一个层叠上下文，没有正的层级它会盖住工具栏
    expect(rule).toMatch(/z-index:\s*[1-9]/)
    // 背景必须是不透明色，否则正文从工具栏底下滚过时会透出来
    expect(rule).toMatch(/background:\s*var\(--/)

    wrapper.unmount()
  })

  it('吸顶链路上没有会裁掉 sticky 的祖先，滚动容器仍是 main.content', () => {
    const content = cssRule(appShellSource, '.content')
    expect(content).toMatch(/overflow-y:\s*auto/)

    // 从工具栏往上到 main.content：任何一级挂了 overflow: hidden / clip，吸顶就会
    // 静默失效（元素被裁在那个盒子里，永远不动）
    const chain: [string, string][] = [
      [viewSource, '.notes-page'],
      [viewSource, '.notes-layout'],
      [viewSource, '.notes-pane'],
      [editorSource, '.note-editor'],
    ]
    for (const [source, selector] of chain) {
      expect(cssRule(source, selector), `${selector} 不该裁剪 sticky`).not.toMatch(
        /overflow(?:-x|-y)?:\s*(?:hidden|clip)/,
      )
    }
  })
})
