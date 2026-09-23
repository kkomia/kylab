/**
 * 文档画布：**一个实例服务所有笔记**，切换笔记靠原地换文档 + 清撤销栈。
 *
 * 这里钉住三件容易退化的事：
 * 1. 切换笔记**不重建实例**（重建是之前"切换卡一下"的根因）；
 * 2. 撤销栈仍然按笔记隔离（上一条的编辑绝不能被撤销回当前这条——
 *    否则会自动保存把串台内容写进库里）；
 * 3. 配图缩放的蓝框与图片是**同一个盒子**（拖到列宽上限时也是），
 *    落进正文的宽度是屏幕上那个（被栏宽截过的），不是鼠标拖出来的数。
 *
 * 第 2 点用 `view.updateState(EditorState.create({ doc, plugins }))` 实现：
 * ProseMirror 会重算所有插件 state，历史自然归零。曾经误以为这招在 Tiptap v3 无效，
 * 于是退化成"换实例"；如果哪天有人把这行删了，下面的用例会立刻红。
 *
 * 第 3 点见下面那个 describe：jsdom 不做布局，所以那两条 CSS 契约
 * （容器 fit-content、包裹层里的图块级化）读源码钉，落盘口径用喂进去的
 * "浏览器量到的尺寸"钉。
 */
import { flushPromises, mount } from '@vue/test-utils'
import type { Editor } from '@tiptap/core'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import NoteCanvas from '@/components/notes/NoteCanvas.vue'

async function mountCanvas(content: string, noteId?: string) {
  const wrapper = mount(NoteCanvas, {
    props: { modelValue: content, noteId },
    attachTo: document.body,
  })
  // useEditor 在 onMounted 里建实例，ready 要等一轮刷新才送出
  await flushPromises()
  const editor = (wrapper.emitted('ready')?.at(-1)?.[0] ?? null) as Editor | null
  return { wrapper, editor: editor as Editor }
}

/** 本组件从始至终只应交给父组件一个实例。 */
function readyInstances(wrapper: ReturnType<typeof mount>): Editor[] {
  const all = (wrapper.emitted('ready') ?? []).map((event) => event[0]).filter(Boolean) as Editor[]
  return [...new Set(all)]
}

/**
 * 正文栏的内容宽：`.editor-column` 是 `max-width: 780px` + 左右各 `--space-6`（24px），
 * 780 - 48 = 732。headless Chrome 里量出来就是这个数，图片最宽只能到这里。
 */
const COLUMN_WIDTH = 732

/**
 * jsdom 没有布局引擎：`offsetWidth` / `offsetHeight` 恒为 0，而 ResizableNodeView
 * 正是靠它们算尺寸、并在 mouseup 时把尺寸落进节点（0 会让"拖完宽度变成 0"）。
 * 这里按**我们 CSS 决定的渲染规则**喂一份：宽度取自图片的内联样式（拖拽时它就在变），
 * 但**被栏宽截住**（`.tiptap img { max-width: 100% }`）；高度跟着宽度与原图比例走
 * （`[data-resize-wrapper] img { height: auto !important }`）。
 * 也就是说，量到的是"浏览器里那张图有多大"，而不是"鼠标拖了多远"。
 */
function stubImageLayout(
  image: HTMLImageElement,
  natural: { width: number; height: number } = { width: 400, height: 300 },
): void {
  const renderedWidth = (): number =>
    Math.min(Math.round(parseFloat(image.style.width) || natural.width), COLUMN_WIDTH)
  Object.defineProperty(image, 'offsetWidth', { configurable: true, get: renderedWidth })
  Object.defineProperty(image, 'offsetHeight', {
    configurable: true,
    get: () => Math.round((renderedWidth() * natural.height) / natural.width),
  })
}

/** 拖右下角手柄：按下 → 移动 → 松开（松手那一下才把尺寸落进节点）。 */
function dragHandle(handle: HTMLElement, fromX: number, toX: number): void {
  const fire = (type: string, x: number): void => {
    const target: EventTarget = type === 'mousedown' ? handle : document
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 300 }),
    )
  }
  fire('mousedown', fromX)
  fire('mousemove', toX)
  fire('mouseup', toX)
}

/** 画布组件的源码：jsdom 不跑样式表，样式契约只能这么钉（同 NoteEditor.test.ts 的 styleRule）。 */
function canvasSource(): string {
  // 用 node:url 的 URL：jsdom 环境里全局 URL 是 jsdom 那个实现，
  // 拿它解析 `file:` 基准会得到 http://localhost 的路径（实测）
  const file = fileURLToPath(
    new NodeURL('../../../src/components/notes/NoteCanvas.vue', import.meta.url),
  )
  return readFileSync(file, 'utf8')
}

/** 画布样式里第一条"选择器含某个片段"的规则的声明块。 */
function styleRule(fragment: string): string {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = canvasSource().match(new RegExp(`\\n[^{}]*${escaped}[^{}]*\\{([^}]*)\\}`))
  expect(match, `没在画布样式里找到含 ${fragment} 的规则`).toBeTruthy()
  return match?.[1] ?? ''
}

describe('NoteCanvas', () => {
  it('挂载后把实例交出来，内容来自 modelValue、撤销栈为空', async () => {
    const { wrapper, editor } = await mountCanvas('# 第一条\n\n正文', 'a')

    expect(editor).toBeTruthy()
    expect(editor.getText()).toContain('第一条')
    expect(editor.can().undo()).toBe(false)

    wrapper.unmount()
  })

  it('编辑后会上报 markdown 与交易', async () => {
    const { wrapper, editor } = await mountCanvas('正文', 'a')
    editor.commands.insertContent('追加')

    const updates = wrapper.emitted('update:modelValue') ?? []
    expect(String(updates.at(-1)?.[0])).toContain('追加')
    expect(wrapper.emitted('change')?.length ?? 0).toBeGreaterThan(0)
    expect(editor.can().undo()).toBe(true)

    wrapper.unmount()
  })

  it('切换笔记：复用同一个实例换内容，且撤销栈被清空', async () => {
    const { wrapper, editor } = await mountCanvas('第一条的正文', 'a')
    editor.commands.insertContent('改了一下')
    expect(editor.can().undo()).toBe(true)

    await wrapper.setProps({ modelValue: '第二条的正文', noteId: 'b' })
    await flushPromises()

    // 关键：实例没有重建
    expect(readyInstances(wrapper)).toHaveLength(1)
    expect(editor.getText()).toContain('第二条')
    expect(editor.getText()).not.toContain('第一条')
    // 关键：上一条的编辑不可撤销回来（否则会被自动保存写进这一条）
    expect(editor.can().undo()).toBe(false)

    wrapper.unmount()
  })

  it('A→B→A 来回切：每次都换对内容、每次都清空历史（走文档缓存那条路）', async () => {
    const { wrapper, editor } = await mountCanvas('甲的正文', 'a')

    await wrapper.setProps({ modelValue: '乙的正文', noteId: 'b' })
    await flushPromises()
    expect(editor.getText()).toContain('乙')
    expect(editor.can().undo()).toBe(false)

    await wrapper.setProps({ modelValue: '甲的正文', noteId: 'a' })
    await flushPromises()

    expect(readyInstances(wrapper)).toHaveLength(1)
    expect(editor.getText()).toContain('甲')
    expect(editor.getText()).not.toContain('乙')
    expect(editor.can().undo()).toBe(false)

    wrapper.unmount()
  })

  it('预热过的那篇切过来内容正确、历史清空（warm 产出的文档与正常装载一致）', async () => {
    const { wrapper, editor } = await mountCanvas('甲的正文', 'a')
    const target = '# 乙的标题\n\n乙的正文，带 **粗体** 与列表\n\n- 一\n- 二'

    // 模拟 hover 预取命中后的预热（空闲时提前解析）
    ;(wrapper.vm as unknown as { warm: (markdown: string) => void }).warm(target)

    await wrapper.setProps({ modelValue: target, noteId: 'b' })
    await flushPromises()

    expect(editor.getText()).toContain('乙的标题')
    expect(editor.getText()).toContain('粗体')
    expect(editor.getText()).not.toContain('甲的正文')
    expect(editor.can().undo()).toBe(false)

    wrapper.unmount()
  })

  it('同一条笔记内容被外部改写（AI 写回）：换内容但**保留**撤销栈', async () => {
    const { wrapper, editor } = await mountCanvas('原文', 'a')
    editor.commands.insertContent('我自己加的')
    expect(editor.can().undo()).toBe(true)

    await wrapper.setProps({ modelValue: 'AI 整理后的正文' })
    await flushPromises()

    expect(editor.getText()).toContain('AI 整理后的正文')
    // 保留历史：用户要能撤销掉 AI 的改动（提示里就是这么承诺的）
    expect(editor.can().undo()).toBe(true)

    wrapper.unmount()
  })

  it('拖右下角改图片尺寸：宽高进节点属性，尺寸随正文（Markdown）往返', async () => {
    const { wrapper, editor } = await mountCanvas('![图](https://example.test/a.png)', 'a')
    const image = wrapper.get('.tiptap img').element as HTMLImageElement
    stubImageLayout(image)

    const handle = wrapper.get('[data-resize-handle="bottom-right"]').element as HTMLElement
    dragHandle(handle, 400, 460) // 往右拖 60px
    await flushPromises()

    const node = editor.state.doc.firstChild
    expect(node?.attrs.width).toBe(460)
    // 高度按原图比例算出来（400x300 的图拖到 460 宽 → 345 高），不会被拖变形
    expect(node?.attrs.height).toBe(345)

    // 尺寸写进正文：Markdown 是唯一事实源，写的就是上面那个宽度
    const saved = String(wrapper.emitted('update:modelValue')?.at(-1)?.[0] ?? '')
    expect(saved).toBe('![图](https://example.test/a.png){width=460}')

    wrapper.unmount()

    // 用这份正文重新装载（等价于刷新/切走再回来）：尺寸还在
    // （从 HTML 属性解析回来时 Tiptap 会顺手转成数字，所以这里是 460 而不是 '460'）
    const reopened = await mountCanvas(saved, 'a')
    expect(reopened.editor.state.doc.firstChild?.attrs.width).toBe(460)
    expect(reopened.wrapper.find('[data-resize-container]').exists()).toBe(true)

    reopened.wrapper.unmount()
  })
})

/**
 * 「蓝框比图片大一圈、左右还超出图片边界」（v0.1.1 用户报的第 1 条）。
 *
 * 根因不是尺寸没落库，而是**蓝框画在另一个盒子上**：`ResizableNodeView` 生成的
 * 容器是块级 flex、默认铺满整栏，图往往比整栏窄，框于是永远比图宽；
 * 再加上包裹层里的图是行内元素、底下留一条基线的缝，框的下沿与右下角手柄
 * 又会落到图片边框下面。实测（headless Chrome，栏宽 732）：
 * 图 460 时框右边多 272px、图 120 时多 612px，下沿一律多 7.3px。
 *
 * 修法是**让尺寸只有一个来源**：宽度只写在图片的内联样式上，容器收缩到内容宽
 * （fit-content），包裹层不设尺寸、只兜"别超栏宽"，图块级化去掉那条基线缝。
 * 于是三层是同一个盒子，框与手柄正好落在图片边框上。
 *
 * jsdom 不做布局，这两条只能分开钉：DOM/落盘口径用喂进去的尺寸钉，
 * CSS 契约读源码钉（同 NoteEditor.test.ts 手柄契约那两条）。
 */
describe('笔记配图：缩放的蓝框与图片是同一个盒子', () => {
  const WITH_SIZE = '![图](https://example.test/a.png){width=460}'

  it('拖到超过列宽：落进正文的 width 是栏宽（浏览器量到的那个），不是鼠标拖出来的数', async () => {
    const { wrapper, editor } = await mountCanvas('![图](https://example.test/a.png)', 'a')
    const image = wrapper.get('.tiptap img').element as HTMLImageElement
    stubImageLayout(image)

    // 一路拖到 1200，远远超出正文栏
    const handle = wrapper.get('[data-resize-handle="bottom-right"]').element as HTMLElement
    dragHandle(handle, 400, 1200)
    await flushPromises()

    const node = editor.state.doc.firstChild
    // 拖拽确实把内联宽度写成了 1200（不是没拖动）
    expect(image.style.width).toBe('1200px')
    // 但屏幕上那张图被 `max-width: 100%` 截在栏宽上，落库读的又是 offsetWidth，
    // 所以正文里存的是 732：用户拖到列宽上限时看到的宽度 = 存下来的宽度，
    // 刷新回来不会突然变宽/变扁
    expect(node?.attrs.width).toBe(COLUMN_WIDTH)
    // 高度仍按原图比例（400x300 → 549），没被截断压扁
    expect(node?.attrs.height).toBe(549)
    expect(String(wrapper.emitted('update:modelValue')?.at(-1)?.[0] ?? '')).toBe(
      '![图](https://example.test/a.png){width=732}',
    )

    wrapper.unmount()
  })

  it('框与图同宽：容器 > 包裹层 > 图片一根链，宽度只有图片内联 width 一个来源', async () => {
    const { wrapper } = await mountCanvas(WITH_SIZE, 'a')
    const container = wrapper.get('[data-resize-container]').element as HTMLElement
    const box = wrapper.get('[data-resize-wrapper]').element as HTMLElement
    const image = wrapper.get('.tiptap img').element as HTMLImageElement

    // 三层之间没有别的盒子——蓝框的宿主（容器）与图片之间只隔一层包裹层
    expect(box.parentElement).toBe(container)
    expect(image.parentElement).toBe(box)

    // 尺寸只有一个来源：图片自己的内联 width。容器与包裹层都不带自己的宽度，
    // 免得出现"框一套尺寸、图另一套"（这正是这次报的 bug）
    expect(image.style.width).toBe('460px')
    expect(box.style.width).toBe('')
    expect(container.style.width).toBe('')

    // 蓝框画在容器上（拖完会 setNodeSelection，这只盒子就是屏幕上的蓝框）
    stubImageLayout(image)
    const handle = wrapper.get('[data-resize-handle="bottom-right"]').element as HTMLElement
    dragHandle(handle, 400, 460)
    await flushPromises()
    expect(container.classList.contains('ProseMirror-selectednode')).toBe(true)
    expect(styleRule(':deep([data-resize-container].ProseMirror-selectednode)')).toMatch(
      /outline:\s*2px/,
    )

    // 而容器得**收缩到内容宽**：它默认是块级 flex、铺满整栏，框因此永远比图宽
    const containerRule = styleRule(':deep([data-resize-container])')
    expect(containerRule).toMatch(/width:\s*fit-content/)
    expect(containerRule).toMatch(/max-width:\s*100%/)
    // 包裹层不设尺寸（兜"别超栏宽"而已），真正的截断点在图自己身上
    expect(styleRule(':deep([data-resize-wrapper])')).toMatch(/max-width:\s*100%/)
    expect(styleRule(':deep(.tiptap img)')).toMatch(/max-width:\s*100%/)

    // 包裹层里的图块级化：行内元素底下那条基线缝（实测 7.3px）会让包裹层比图高，
    // 跟着它走的容器下沿与右下角手柄就落到图片边框下面去了
    const imageRule = styleRule(':deep([data-resize-wrapper] img)')
    expect(imageRule).toMatch(/display:\s*block/)
    // 高度仍由宽度与图片自身比例决定（拖拽写进去的内联 height 要被压过）
    expect(imageRule).toMatch(/height:\s*auto\s*!important/)

    wrapper.unmount()
  })
})
