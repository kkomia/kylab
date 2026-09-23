/**
 * 文档画布：**一个实例服务所有笔记**，切换笔记靠原地换文档 + 清撤销栈。
 *
 * 这是旧用例 `tests/unit/components/NoteCanvas.test.ts` 的 React 版翻译，钉住四件
 * 容易退化的事（第 2、4 条是用户报过的 bug）：
 * 1. 切换笔记**不重建实例**（重建是"切换卡一下"的根因）；
 * 2. 撤销栈按笔记隔离（上一条的编辑绝不能被撤销回当前这条——否则自动保存会串台）；
 * 3. 配图缩放的**蓝框与图片是同一个盒子**（拖到列宽上限时也是）；
 * 4. 落进正文的宽度是屏幕上那个（被栏宽截过的），不是鼠标拖出来的数。
 *
 * jsdom 的两个缺口在本文件里各补一次（同旧前端做法，**不往全局 setup 放**）：
 * 没有布局引擎（offsetWidth/Height 恒为 0，而缩放正是靠它们落库的——按我们的 CSS
 * 规则喂一份尺寸，见 `stubImageLayout`），以及 ProseMirror 的 `.focus()` 会去量
 * 文字矩形（`Range` 缺两个方法）。
 */
import { fireEvent, render } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { useRef, useState } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import { NoteCanvas, type NoteCanvasHandle } from '@/features/notes/NoteCanvas'

/* ---------------------------------------------------------- jsdom 的两处补丁 */

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

/**
 * 正文栏的内容宽：`.editor-column` 是 `max-width: 780px` + 左右各 `--space-6`（24px），
 * 780 - 48 = 732。headless Chrome 里量出来就是这个数，图片最宽只能到这里。
 */
const COLUMN_WIDTH = 732

/**
 * jsdom 没有布局引擎：按**我们 CSS 决定的渲染规则**喂一份尺寸——宽度取自图片的
 * 内联样式（拖拽时它就在变），但**被栏宽截住**（`.tiptap img { max-width: 100% }`）；
 * 高度跟着宽度与原图比例走（`[data-resize-wrapper] img { height: auto !important }`）。
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

/* ------------------------------------------------------------------ 用例基座 */

interface Hosted {
  value: string
  noteId?: string
}

/** 一个能改 props 的宿主：`rerender` 换 props 就等于"换笔记/外部改写"。 */
function CanvasHost({ value, noteId, wire }: Hosted & { wire: Wire }): React.ReactElement {
  wire.values = []
  return (
    <NoteCanvas
      value={value}
      noteId={noteId}
      onValueChange={(markdown) => {
        wire.values.push(markdown)
      }}
      onReady={(editor) => {
        if (editor) wire.instances.push(editor)
      }}
      onChange={() => {
        wire.changes += 1
      }}
    />
  )
}

interface Wire {
  values: string[]
  instances: Editor[]
  changes: number
}

function newWire(): Wire {
  return { values: [], instances: [], changes: 0 }
}

function mountCanvas(value: string, noteId?: string) {
  const wire = newWire()
  const view = render(<CanvasHost value={value} noteId={noteId} wire={wire} />)
  const rerender = (next: Hosted): void => {
    view.rerender(<CanvasHost {...next} wire={wire} />)
  }
  return { wire, rerender, view }
}

const lastValue = (wire: Wire): string => wire.values.at(-1) ?? ''

const IMAGE = '![图](https://example.test/a.png)'
const IMAGE_WITH_SIZE = '![图](https://example.test/a.png){width=460}'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('NoteCanvas：内容装载与切换', () => {
  it('挂载后内容来自 value、撤销栈为空', () => {
    const { wire, view } = mountCanvas('# 第一条\n\n正文', 'a')

    const editor = wire.instances.at(-1)!
    expect(editor.getText()).toContain('第一条')
    expect(editor.can().undo()).toBe(false)

    view.unmount()
  })

  it('编辑后会上报 markdown 与交易', () => {
    const { wire, view } = mountCanvas('正文', 'a')
    const editor = wire.instances.at(-1)!
    editor.commands.insertContent('追加')

    expect(lastValue(wire)).toContain('追加')
    expect(wire.changes).toBeGreaterThan(0)
    expect(editor.can().undo()).toBe(true)

    view.unmount()
  })

  it('切换笔记：复用同一个实例换内容，且撤销栈被清空', () => {
    const { wire, rerender, view } = mountCanvas('第一条的正文', 'a')
    const editor = wire.instances.at(-1)!
    editor.commands.insertContent('改了一下')
    expect(editor.can().undo()).toBe(true)

    rerender({ value: '第二条的正文', noteId: 'b' })

    // 关键：实例没有重建
    expect(new Set(wire.instances).size).toBe(1)
    expect(editor.getText()).toContain('第二条')
    expect(editor.getText()).not.toContain('第一条')
    // 关键：上一条的编辑不可撤销回来（否则会被自动保存写进这一条）
    expect(editor.can().undo()).toBe(false)

    view.unmount()
  })

  it('A→B→A 来回切：每次都换对内容、每次都清空历史（走文档缓存那条路）', () => {
    const { wire, rerender, view } = mountCanvas('甲的正文', 'a')
    const editor = wire.instances.at(-1)!

    rerender({ value: '乙的正文', noteId: 'b' })
    expect(editor.getText()).toContain('乙')
    expect(editor.can().undo()).toBe(false)

    rerender({ value: '甲的正文', noteId: 'a' })

    expect(new Set(wire.instances).size).toBe(1)
    expect(editor.getText()).toContain('甲')
    expect(editor.getText()).not.toContain('乙')
    expect(editor.can().undo()).toBe(false)

    view.unmount()
  })

  it('预热过的那篇切过来内容正确、历史清空（warm 产出的文档与正常装载一致）', () => {
    const wire = newWire()
    const view = render(
      <WarmHost
        wire={wire}
        initial={IMAGE}
        target={'# 乙的标题\n\n乙的正文，带 **粗体** 与列表\n\n- 一\n- 二'}
      />,
    )

    // 模拟 hover 预取命中后的预热（空闲时提前解析），再切过去
    fireEvent.click(view.getByRole('button', { name: 'switch' }))

    const editor = wire.instances.at(-1)!
    expect(new Set(wire.instances).size).toBe(1)
    expect(editor.getText()).toContain('乙的标题')
    expect(editor.getText()).toContain('粗体')
    expect(editor.getText()).not.toContain('图')
    expect(editor.can().undo()).toBe(false)

    view.unmount()
  })

  it('同一条笔记内容被外部改写（AI 写回）：换内容但**保留**撤销栈', () => {
    const { wire, rerender, view } = mountCanvas('原文', 'a')
    const editor = wire.instances.at(-1)!
    editor.commands.insertContent('我自己加的')
    expect(editor.can().undo()).toBe(true)

    rerender({ value: 'AI 整理后的正文', noteId: 'a' })

    expect(editor.getText()).toContain('AI 整理后的正文')
    // 保留历史：用户要能撤销掉 AI 的改动（提示里就是这么承诺的）
    expect(editor.can().undo()).toBe(true)

    view.unmount()
  })
})

/** 「先 warm 再切」的宿主：warm 只能从外部经 ref 调，所以这里自己持一个 ref。 */
function WarmHost({
  wire,
  initial,
  target,
}: {
  wire: Wire
  initial: string
  target: string
}): React.ReactElement {
  const ref = useRef<NoteCanvasHandle | null>(null)
  const [current, setCurrent] = useState({ value: initial, noteId: 'a' })
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          ref.current?.warm(target)
          setCurrent({ value: target, noteId: 'b' })
        }}
      >
        switch
      </button>
      <NoteCanvas
        ref={ref}
        value={current.value}
        noteId={current.noteId}
        onValueChange={(markdown) => {
          wire.values.push(markdown)
        }}
        onReady={(editor) => {
          if (editor) wire.instances.push(editor)
        }}
      />
    </div>
  )
}

describe('笔记配图：缩放与拖拽', () => {
  it('拖右下角改尺寸：宽高进节点属性，尺寸随正文（Markdown）往返', () => {
    const { wire, view } = mountCanvas(IMAGE, 'a')
    const editor = wire.instances.at(-1)!
    const image = view.container.querySelector('.tiptap img') as HTMLImageElement
    stubImageLayout(image)

    const handle = view.container.querySelector(
      '[data-resize-handle="bottom-right"]',
    ) as HTMLElement
    dragHandle(handle, 400, 460) // 往右拖 60px

    const node = editor.state.doc.firstChild
    expect(node?.attrs.width).toBe(460)
    // 高度按原图比例算出来（400x300 的图拖到 460 宽 → 345 高），不会被拖变形
    expect(node?.attrs.height).toBe(345)

    // 尺寸写进正文：Markdown 是唯一事实源，写的就是上面那个宽度
    expect(lastValue(wire)).toBe(IMAGE_WITH_SIZE)

    view.unmount()

    // 用这份正文重新装载（等价于刷新/切走再回来）：尺寸还在
    const reopened = mountCanvas(lastValue(wire), 'a')
    const restoredImage = reopened.view.container.querySelector('.tiptap img') as HTMLImageElement
    expect(restoredImage.style.width).toBe('460px')
    expect(reopened.view.container.querySelector('[data-resize-container]')).toBeTruthy()
    expect(reopened.wire.instances.at(-1)!.state.doc.firstChild?.attrs.width).toBe(460)

    reopened.view.unmount()
  })

  it('没有尺寸的图不会被写上尺寸（只有在拖过之后才有）', () => {
    const { view } = mountCanvas(IMAGE, 'a')

    const image = view.container.querySelector('.tiptap img') as HTMLImageElement
    expect(image.getAttribute('width')).toBeNull()
    expect(view.container.querySelector('[data-resize-handle="bottom-right"]')).toBeTruthy()

    view.unmount()
  })

  it('拖到超过列宽：落进正文的 width 是栏宽（浏览器量到的那个），不是鼠标拖出来的数', () => {
    const { wire, view } = mountCanvas(IMAGE, 'a')
    const editor = wire.instances.at(-1)!
    const image = view.container.querySelector('.tiptap img') as HTMLImageElement
    stubImageLayout(image)

    // 一路拖到 1200，远远超出正文栏
    const handle = view.container.querySelector(
      '[data-resize-handle="bottom-right"]',
    ) as HTMLElement
    dragHandle(handle, 400, 1200)

    // 拖拽确实把内联宽度写成了 1200（不是没拖动）
    expect(image.style.width).toBe('1200px')
    // 但屏幕上那张图被 `max-width: 100%` 截在栏宽上，落库读的又是 offsetWidth，
    // 所以正文里存的是 732：用户拖到列宽上限时看到的宽度 = 存下来的宽度
    expect(editor.state.doc.firstChild?.attrs.width).toBe(COLUMN_WIDTH)
    // 高度仍按原图比例（400x300 → 549），没被截断压扁
    expect(editor.state.doc.firstChild?.attrs.height).toBe(549)
    expect(lastValue(wire)).toBe('![图](https://example.test/a.png){width=732}')

    view.unmount()
  })
})

/**
 * 「蓝框比图片大一圈、左右还超出图片边界」（v0.1.1 用户报的第 1 条）。
 *
 * 根因不是尺寸没落库，而是**蓝框画在另一个盒子上**：`ResizableNodeView` 生成的
 * 容器是块级 flex、默认铺满整栏，图往往比整栏窄，框于是永远比图宽；
 * 再加上包裹层里的图是行内元素、底下留一条基线的缝，框的下沿与右下角手柄
 * 又会落到图片边框下面。
 *
 * 修法是**让尺寸只有一个来源**：宽度只写在图片的内联样式上，容器收缩到内容宽
 * （fit-content），包裹层不设尺寸、只兜"别超栏宽"，图块级化去掉那条基线缝。
 * jsdom 不做布局，所以 DOM/落盘口径用喂进去的尺寸钉，CSS 契约读源码钉。
 */
describe('笔记配图：缩放的蓝框与图片是同一个盒子', () => {
  it('框与图同宽：容器 > 包裹层 > 图片一根链，宽度只有图片内联 width 一个来源', () => {
    const { view } = mountCanvas(IMAGE_WITH_SIZE, 'a')
    const container = view.container.querySelector('[data-resize-container]') as HTMLElement
    const box = view.container.querySelector('[data-resize-wrapper]') as HTMLElement
    const image = view.container.querySelector('.tiptap img') as HTMLImageElement

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
    const handle = view.container.querySelector(
      '[data-resize-handle="bottom-right"]',
    ) as HTMLElement
    dragHandle(handle, 400, 460)
    expect(container.classList.contains('ProseMirror-selectednode')).toBe(true)

    view.unmount()
  })

  it('样式契约：容器收缩到内容宽、包裹层不设尺寸、图块级化且高度由宽度决定', () => {
    const css = styleText()

    // 而容器得**收缩到内容宽**：它默认是块级 flex、铺满整栏，框因此永远比图宽
    const containerRule = cssRule(css, '.editor-content [data-resize-container]')
    expect(containerRule).toMatch(/width:\s*fit-content/)
    expect(containerRule).toMatch(/max-width:\s*100%/)
    expect(containerRule).toMatch(/width:\s*fit-content/)
    // 包裹层不设尺寸（兜"别超栏宽"而已），真正的截断点在图自己身上
    expect(cssRule(css, '.editor-content [data-resize-wrapper]')).toMatch(/max-width:\s*100%/)
    expect(cssRule(css, '.editor-content .tiptap img')).toMatch(/max-width:\s*100%/)

    // 包裹层里的图块级化：行内元素底下那条基线缝（实测 7.3px）会让包裹层比图高，
    // 跟着它走的容器下沿与右下角手柄就落到图片边框下面去了
    const imageRule = cssRule(css, '.editor-content [data-resize-wrapper] img')
    expect(imageRule).toMatch(/display:\s*block/)
    // 高度仍由宽度与图片自身比例决定（拖拽写进去的内联 height 要被压过）
    expect(imageRule).toMatch(/height:\s*auto\s*!important/)

    // 蓝框画在容器上，且就是强调色的一圈 —— 不是"框比图大"的那一圈
    const selected = cssRule(
      css,
      '.editor-content [data-resize-container].ProseMirror-selectednode',
    )
    expect(selected).toMatch(/outline:\s*2px/)
  })

  it('手柄是安静的：平时透明，悬停/拖拽时才现出来；只读时藏起来', () => {
    const css = styleText()
    expect(cssRule(css, '.editor-content [data-resize-handle]')).toMatch(/opacity:\s*0/)
    expect(
      cssRule(css, '.editor-content [data-resize-container]:hover [data-resize-handle]'),
    ).toMatch(/opacity:\s*1/)
    // 只读笔记可能一直不产生 update，手柄留在图上，拖了还会改文档
    expect(
      cssRule(css, ".editor-content .tiptap[contenteditable='false'] [data-resize-handle]"),
    ).toMatch(/display:\s*none/)
  })
})

/**
 * **Markdown 序列化口径**：给定 Tiptap JSON（编辑器里的文档）→ 期望 Markdown（落库的正文）。
 *
 * `content_md` 是唯一事实源，所以这一层的口径就是"用户下次打开看到什么"。
 * 三处口径值得逐字钉住：
 * - 标题/列表/引用走标准 Markdown（不带多余空行）；
 * - **下划线落不进 Markdown**（Markdown 没有这个语法），序列化时会被丢掉——
 *   这是旧实现就有的口径（同一套 `tiptap-markdown` 与同一个 StarterKit 配置），
 *   在这里写明，免得以后有人以为预览里"下划线没了"是新 bug；
 * - 配图的尺寸按 Pandoc 后缀写在图片后面（`{width=460}`，见 noteImage.ts）。
 */
describe('Markdown 序列化口径', () => {
  const text = (value: string, marks?: string[]): Record<string, unknown> => ({
    type: 'text',
    text: value,
    ...(marks ? { marks: marks.map((type) => ({ type })) } : {}),
  })

  const cases: { name: string; doc: Record<string, unknown>; markdown: string }[] = [
    {
      name: '标题与行内标记',
      doc: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [text('标题')] },
          {
            type: 'paragraph',
            content: [
              text('粗', ['bold']),
              text('斜', ['italic']),
              text('删', ['strike']),
              text('普通'),
            ],
          },
        ],
      },
      markdown: '# 标题\n\n**粗***斜*~~删~~普通',
    },
    {
      name: '无序列表',
      doc: {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [text('一')] }] },
              { type: 'listItem', content: [{ type: 'paragraph', content: [text('二')] }] },
            ],
          },
        ],
      },
      markdown: '- 一\n- 二',
    },
    {
      name: '有序列表',
      doc: {
        type: 'doc',
        content: [
          {
            type: 'orderedList',
            attrs: { start: 1 },
            content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [text('一')] }] },
              { type: 'listItem', content: [{ type: 'paragraph', content: [text('二')] }] },
            ],
          },
        ],
      },
      markdown: '1. 一\n2. 二',
    },
    {
      name: '待办清单（勾选状态落在 [x] 上）',
      doc: {
        type: 'doc',
        content: [
          {
            type: 'taskList',
            content: [
              {
                type: 'taskItem',
                attrs: { checked: false },
                content: [{ type: 'paragraph', content: [text('未完成')] }],
              },
              {
                type: 'taskItem',
                attrs: { checked: true },
                content: [{ type: 'paragraph', content: [text('完成')] }],
              },
            ],
          },
        ],
      },
      // 待办清单序列化成**松列表**（项之间空一行）：`tiptap-markdown` 的 `tightLists`
      // 默认是关的，而旧实现同样没开——口径一致，逐字钉住
      markdown: '- [ ] 未完成\n\n- [x] 完成',
    },
    {
      name: '引用与分隔线',
      doc: {
        type: 'doc',
        content: [
          { type: 'blockquote', content: [{ type: 'paragraph', content: [text('引用')] }] },
          { type: 'horizontalRule' },
        ],
      },
      markdown: '> 引用\n\n---',
    },
    {
      name: '代码块',
      doc: {
        type: 'doc',
        content: [{ type: 'codeBlock', attrs: { language: null }, content: [text('const a = 1')] }],
      },
      markdown: '```\nconst a = 1\n```',
    },
    {
      name: '链接（href 就是正文里那个地址）',
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '文字',
                marks: [{ type: 'link', attrs: { href: 'https://example.test/a' } }],
              },
            ],
          },
        ],
      },
      markdown: '[文字](https://example.test/a)',
    },
    {
      name: '下划线落不进 Markdown：正文保留、标记丢掉（旧实现同一口径）',
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [text('下划线', ['underline'])] }],
      },
      markdown: '下划线',
    },
    {
      name: '带尺寸的配图：尺寸写在图片后面的 Pandoc 后缀里',
      doc: {
        type: 'doc',
        content: [
          {
            type: 'image',
            attrs: { src: 'https://example.test/a.png', alt: '图', width: 460 },
          },
        ],
      },
      markdown: '![图](https://example.test/a.png){width=460}',
    },
    {
      name: '没拖过尺寸的配图不带后缀',
      doc: {
        type: 'doc',
        content: [
          { type: 'image', attrs: { src: 'https://example.test/a.png', alt: '图', width: null } },
        ],
      },
      markdown: '![图](https://example.test/a.png)',
    },
  ]

  it.each(cases)('$name', ({ doc, markdown }) => {
    const { wire, view } = mountCanvas('', 'a')
    const editor = wire.instances.at(-1)!

    editor.commands.setContent(doc)

    expect(lastValue(wire)).toBe(markdown)
    view.unmount()
  })

  it('Markdown 再解析回来是同一份文档（往返一致）', () => {
    const once = mountCanvas(
      '# 标题\n\n- 一\n- 二\n\n![图](https://example.test/a.png){width=460}',
      'a',
    )
    once.view.unmount()

    // 上一轮装载出来的正文就是这份 markdown（warm/序列化两侧口径一致）
    const again = mountCanvas(
      '# 标题\n\n- 一\n- 二\n\n![图](https://example.test/a.png){width=460}',
      'a',
    )
    const editor = again.wire.instances.at(-1)!
    expect(editor.getText()).toContain('标题')
    expect(editor.getText()).toContain('一')
    expect(editor.state.doc.firstChild?.attrs.level).toBe(1)

    editor.commands.setContent(editor.state.doc.toJSON())
    expect(lastValue(again.wire)).toBe(
      '# 标题\n\n- 一\n- 二\n\n![图](https://example.test/a.png){width=460}',
    )

    again.view.unmount()
  })
})

/* --------------------------------------------------------------- 源码小工具 */
/** 笔记域的样式正文（jsdom 不应用样式表，结构契约只能这么钉）。 */
function styleText(): string {
  return readFileSync(
    fileURLToPath(new NodeURL('../src/features/notes/notes.css', import.meta.url)),
    'utf8',
  )
}

/** 去掉块注释：中文注释里的括号不该参与"这是哪条规则"的判断。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 样式里某条 CSS 规则的声明块（`选择器 { … }` 之间的那段）。 */
function cssRule(source: string, selector: string): string {
  const rules = [...stripComments(source).matchAll(/\n\s*([^{}]+?)\s*\{([^{}]*)\}/g)]
  const found = rules.find((rule) =>
    (rule[1] ?? '').split(',').some((part) => part.trim() === selector),
  )
  expect(found, `没在源码里找到 CSS 规则 ${selector}`).toBeTruthy()
  return found?.[2] ?? ''
}
