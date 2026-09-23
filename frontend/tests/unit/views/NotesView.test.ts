/**
 * 笔记页版式：**工具栏吸顶 + 列表可折叠 + 两列各自滚**
 * （《开发计划》§12.224 用户报的 7、8 两条，以及 0.1.1 体验第 4 条）。
 *
 * 这几条都是"平时看着没事、正文一长/想给正文腾地方才难受"的问题，所以钉住的是
 * **结构契约**，不是渲染结果：
 *
 * 1. 折叠：开关切一次，`.notes-layout` 挂上 `list-collapsed`，列表整块移出 DOM，
 *    状态写进 localStorage；重新挂载（等价于刷新）后仍然是折叠的；
 * 2. 吸顶：`.toolbar` 声明 `position: sticky`，吸附对象是**正文列的滚动容器**
 *    `.notes-pane`（工具栏就在它里面，中间那一级 `.note-editor` 没有 `overflow: hidden`
 *    之类的裁剪）；`.editor-body` 也刻意不设 overflow——它一旦自己滚起来，
 *    列那层就被架空，sticky 从此贴在一个不动的盒子上；
 * 3. 两列各自滚：`.notes-list` 与 `.notes-pane` 各自 `overflow-y: auto` 且撑满可用高度，
 *    页面自己占满内容区（外层那条滚动条在这页无事可做）。原先"目录与正文共用一个
 *    滚动条"的根因是 `.notes-layout` 上的 `align-items: start`——两列各按内容高排版，
 *    页面被正文撑长，滚动只能落在最外层；900px 以下单栏堆叠时这些声明全部还原，
 *    两段重新共用页面那一条滚动条。
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

/** 去掉块注释：中文注释里的逗号与括号不该参与"这是哪条规则"的判断。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * SFC 里的样式正文。传进来的若是整份单文件组件就先切到 `<style>` 块——
 * 模板与脚本里的 `{` `}`（插值、对象字面量）会混进规则扫描，
 * 让 `.notes-page` 这种规则被前面一段无关文本吞掉（这条踩过一次）。
 * 已经是样式片段（比如下面的媒体查询切片）就原样返回。
 */
function styleText(source: string): string {
  const open = source.indexOf('<style')
  if (open < 0) return source
  const from = source.indexOf('>', open)
  const to = source.indexOf('</style>', from)
  return source.slice(from + 1, to < 0 ? undefined : to)
}

/**
 * 源码里某条 CSS 规则的声明块（`选择器 { … }` 之间的那段）。
 *
 * 选择器写成**列表**（`a, b { … }`）时，只要列表里含这一个就认：
 * 合并规则是常态（两列共用一组重置），不该逼着样式拆成一条条单选择器。
 */
function cssRule(source: string, selector: string): string {
  const rules = [...stripComments(styleText(source)).matchAll(/\n\s*([^{}]+?)\s*\{([^{}]*)\}/g)]
  const found = rules.find((rule) =>
    (rule[1] ?? '').split(',').some((part) => part.trim() === selector),
  )
  expect(found, `没在源码里找到 CSS 规则 ${selector}`).toBeTruthy()
  return found?.[2] ?? ''
}

/** 源码里某个 `@media` 块的正文：按大括号配平截取，嵌套的规则都在里面。 */
function mediaBlock(source: string, query: string): string {
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

  it('工具栏在正文列的滚动容器内，链路上没有会裁掉 sticky 的一级', async () => {
    const wrapper = await mountPage()

    // DOM 上工具栏确实长在 `.notes-pane` 里面，而那一列就是正文的滚动容器：
    // sticky 相对"最近的可滚动祖先"吸附，这两条缺一不可
    expect(wrapper.get('.notes-pane').find('.toolbar').exists()).toBe(true)
    expect(cssRule(viewSource, '.notes-pane')).toMatch(/overflow-y:\s*auto/)

    // 从工具栏往上到 `.notes-pane`：中间那一级挂了 overflow: hidden / clip，
    // 吸顶就会静默失效（元素被裁在那个盒子里，永远不动）
    expect(cssRule(editorSource, '.note-editor')).not.toMatch(
      /overflow(?:-x|-y)?:\s*(?:hidden|clip)/,
    )
    // `.editor-body` 自己不能是滚动容器：它一滚，列那层就不动了，
    // 工具栏等于贴在一个不动的盒子上——吸顶写了也白写
    expect(cssRule(editorSource, '.editor-body')).not.toMatch(
      /overflow(?:-x|-y)?:\s*(?:auto|scroll)/,
    )

    // sticky 只能在**包含块**里活动，而它的包含块就是编辑区这一层：
    // 这一层必须"至少一列高、正文多长就多长"。flex 项默认 `flex-shrink: 1`，
    // 正文几屏长时它会被压回列高——溢出的正文照样能滚，但工具栏滚过一屏
    // 就再没地方可粘，跟着滚走了（这条踩到过）
    const column = cssRule(viewSource, '.pane-editor')
    expect(column).toMatch(/min-height:\s*100%/)
    expect(column).toMatch(/flex:\s*none/)

    wrapper.unmount()
  })
})

describe('笔记页：两列各自滚', () => {
  it('目录列与正文列各自是滚动容器：overflow-y 与高度都撑满可用高度', () => {
    for (const selector of ['.notes-list', '.notes-pane']) {
      const rule = cssRule(viewSource, selector)
      expect(rule, `${selector} 要自己滚`).toMatch(/overflow-y:\s*auto/)
      expect(rule, `${selector} 要撑满可用高度`).toMatch(/height:\s*100%/)
      // 高度链上的 `min-height: 0` 不是装饰：grid 项的自动最小尺寸是**内容高**，
      // 不压到 0 的话长内容会把格子顶高，overflow 就永远不会生效
      expect(rule, `${selector} 要允许自己被内容压矮`).toMatch(/min-height:\s*0/)
    }
    // 列里面不能再出现"把正文高度钉在列高上"的一层（注：`min-height` 不算，
    // 所以这里要求 `height` 前面是空白或分号）：那会让正文在 `.editor-body`
    // 里自己滚，列那层从此不动——两列各自滚也就名存实亡
    expect(cssRule(editorSource, '.note-editor')).not.toMatch(/(?:^|[\s;])height:\s*100%/)
  })

  it('页面自己撑满内容区：外层那条滚动条不再参与这一页的滚动', () => {
    expect(cssRule(viewSource, '.notes-page')).toMatch(/height:\s*100%/)
    expect(cssRule(viewSource, '.notes-layout')).toMatch(/height:\s*100%/)
    // 根因：`align-items: start` 让两列各按**内容高**排版，页面被正文撑长，
    // 滚动只能落在最外层——正文一滚，左边那份不长的目录就被一起带走。这条不能再回来。
    expect(cssRule(viewSource, '.notes-layout')).not.toMatch(/align-items:\s*(?:start|flex-start)/)
    // 外壳那一条留着（它还服务别的页面）：笔记页只是让它在自己这里无事可做
    expect(cssRule(appShellSource, '.content')).toMatch(/overflow-y:\s*auto/)
  })

  it('单栏断点（<=900px）下两列不再各自滚：两段回到同一条滚动', () => {
    const stacked = mediaBlock(viewSource, '(max-width: 900px)')

    // 先确认这个断点确实把版式压成了单栏——不然"两列"还在，下面的还原就没意义
    expect(cssRule(stacked, '.notes-layout')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    for (const selector of ['.notes-page', '.notes-layout', '.notes-list', '.notes-pane']) {
      expect(cssRule(stacked, selector), `${selector} 在单栏下不该留着定高`).toMatch(
        /height:\s*auto/,
      )
    }
    for (const selector of ['.notes-list', '.notes-pane']) {
      expect(cssRule(stacked, selector), `${selector} 在单栏下不该自己滚`).toMatch(
        /overflow-y:\s*visible/,
      )
    }
  })
})
