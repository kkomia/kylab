/**
 * 笔记编辑器：**粘贴图片 + 拖拽改尺寸**（《开发计划》§12.224 用户报的第 3 条）。
 *
 * 四件事各钉一条：
 * 1. 剪贴板里有图片文件时**接管**这次粘贴，走与「插入图片」按钮同一条上传链路；
 * 2. 上传失败时正文**一个字都不改**（宁可没插上，也不要把半截内容留在正文里），并且有错误提示；
 * 3. 拖右下角手柄改宽度，尺寸以 `{width=…}` 写进 Markdown（正文是唯一事实源），
 *    用这份正文重新挂载（等价于刷新）后尺寸还在；
 * 4. 原有两条路——「插入图片」按钮与 AI 动作——不回归。
 *
 * jsdom 的两个缺口在这里各补一次（都只影响本文件，所以不往 setup 放）：
 * **没有 DataTransfer**（自己拼一个最小的 clipboardData）、
 * **没有布局引擎**（offsetWidth/Height 恒为 0，而缩放正是靠它们落库的——按我们的 CSS
 * 规则喂一份尺寸，见 `stubLayout`）。另外 ProseMirror 的 `.focus()` 会去量文字矩形，
 * 那条补丁是全局的（`Range` 缺两个方法，见 tests/setup.ts）。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NoteImage } from '@/api/notes'

const uploadNoteImage = vi.fn()

vi.mock('@/api/notes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/notes')>()
  return {
    ...actual,
    uploadNoteImage: (...args: unknown[]) => uploadNoteImage(...args),
  }
})

import NoteEditor from '@/components/notes/NoteEditor.vue'

const URL_A = '/api/v1/notes/n1/images/aaa.png?expires=99&signature=sig'
const IMAGE: NoteImage = { url: URL_A, name: 'aaa.png', alt: 'image.png' }

/** 造一次"剪贴板里有图片"的粘贴。jsdom 没有 DataTransfer，只能给个最小面。 */
function pasteFiles(target: Element, files: File[]): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      // ProseMirror 会先读纯文本/HTML 来算粘贴的切片，这里给空串表示"没有文字"
      getData: () => '',
    },
  })
  target.dispatchEvent(event)
}

/**
 * jsdom 没有布局引擎：`offsetWidth` / `offsetHeight` 恒为 0，而 `ResizableNodeView`
 * 正是靠它们算新尺寸、并在 mouseup 时把结果落库（0 会让"拖完宽度变成 0"）。
 * 这里按**我们 CSS 决定的渲染规则**喂一份：宽度取自内联样式（拖拽时它就在变），
 * 高度跟着宽度与原图比例走——与 `height: auto` 的行为一致。
 */
function stubLayout(img: HTMLElement, natural: { width: number; height: number }): void {
  const renderedWidth = (): number => Math.round(parseFloat(img.style.width) || natural.width)
  Object.defineProperty(img, 'offsetWidth', { configurable: true, get: renderedWidth })
  Object.defineProperty(img, 'offsetHeight', {
    configurable: true,
    get: () => Math.round((renderedWidth() * natural.height) / natural.width),
  })
}

/** 拖动手柄：按下 → 移动 → 松开（松手那一下才会把尺寸落进节点）。 */
function dragHandle(handle: HTMLElement, from: [number, number], to: [number, number]): void {
  const fire = (type: string, x: number, y: number, target: EventTarget): void => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    )
  }
  fire('mousedown', from[0], from[1], handle)
  fire('mousemove', to[0], to[1], document)
  fire('mouseup', to[0], to[1], document)
}

async function mountEditor(
  modelValue = '',
  noteId: string | undefined = 'n1',
): Promise<VueWrapper> {
  const wrapper = mount(NoteEditor, {
    props: { modelValue, noteId },
    attachTo: document.body,
  })
  // useEditor 在 onMounted 里建实例，编辑器就绪要等一轮刷新
  await flushPromises()
  return wrapper
}

/** 编辑器最近一次交出去的正文（就是要存进库的那份 Markdown）。 */
function lastMarkdown(wrapper: VueWrapper): string {
  return String(wrapper.emitted('update:modelValue')?.at(-1)?.[0] ?? '')
}

/** 画布组件的源码：jsdom 不应用样式表，样式契约只能这么钉（见用例里的注记）。 */
function canvasStyleText(): string {
  // 用 node:url 的 URL：jsdom 环境里全局 URL 是 jsdom 那个实现，
  // 拿它解析 `file:` 基准会得到 http://localhost 的路径（实测）
  const file = fileURLToPath(
    new NodeURL('../../../src/components/notes/NoteCanvas.vue', import.meta.url),
  )
  return readFileSync(file, 'utf8')
}

/** 画布样式里第一条"选择器含某个片段"的规则的声明块。 */
function styleRule(fragment: string): string {
  // 片段里有 `[attr]` 这类正则元字符，得先转义（同 NotesView.test.ts 的 cssRule）
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = canvasStyleText().match(new RegExp(`\\n[^{}]*${escaped}[^{}]*\\{([^}]*)\\}`))
  expect(match, `没在画布样式里找到含 ${fragment} 的规则`).toBeTruthy()
  return match?.[1] ?? ''
}

beforeEach(() => {
  uploadNoteImage.mockReset().mockResolvedValue(IMAGE)
  document.body.innerHTML = ''
})

describe('笔记编辑器：粘贴图片', () => {
  it('剪贴板里有图片：上传并插入，正文里是带签名地址的 Markdown 图片', async () => {
    const wrapper = await mountEditor('开头')

    // 截图工具给的 File 往往**没有文件名**：后端按后缀判白名单，所以这里要按 MIME 补一个
    pasteFiles(wrapper.get('.tiptap').element, [
      new File([new Uint8Array([1, 2, 3])], '', { type: 'image/png' }),
    ])
    await flushPromises()

    expect(uploadNoteImage).toHaveBeenCalledTimes(1)
    const [noteId, sent] = uploadNoteImage.mock.calls[0] as [string, File]
    expect(noteId).toBe('n1')
    expect(sent.name).toMatch(/\.png$/)
    expect(sent.type).toBe('image/png')

    // 插入的是图片节点：正文（Markdown）里有它，地址就是上传回来的那个
    expect(lastMarkdown(wrapper)).toContain(`![image.png](${URL_A})`)

    wrapper.unmount()
  })

  it('上传期间有可见提示，落图之后提示消失', async () => {
    let resolveUpload: (image: NoteImage) => void = () => {}
    uploadNoteImage.mockReturnValue(
      new Promise<NoteImage>((resolve) => {
        resolveUpload = resolve
      }),
    )
    const wrapper = await mountEditor('开头')

    pasteFiles(wrapper.get('.tiptap').element, [
      new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }),
    ])
    await flushPromises()
    expect(wrapper.get('.upload-hint').text()).toContain('上传中')

    resolveUpload(IMAGE)
    await flushPromises()
    expect(wrapper.find('.upload-hint').exists()).toBe(false)
    expect(lastMarkdown(wrapper)).toContain(`![image.png](${URL_A})`)

    wrapper.unmount()
  })

  it('上传失败：正文里没有图片、有错误提示，且原文一字未改', async () => {
    uploadNoteImage.mockRejectedValue(new Error('图片超过 10MB 上限'))
    const wrapper = await mountEditor('原来的正文')

    pasteFiles(wrapper.get('.tiptap').element, [
      new File([new Uint8Array([1])], 'big.png', { type: 'image/png' }),
    ])
    await flushPromises()

    expect(wrapper.find('.tiptap img').exists()).toBe(false)
    const notices = wrapper.emitted('notify') ?? []
    expect(notices.at(-1)?.[0]).toEqual({ type: 'error', message: '图片超过 10MB 上限' })
    // 失败时**不落任何东西**：宁可不插，也不要把半截内容（比如 data URL）留在正文里
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    wrapper.unmount()
  })

  it('没有图片文件的粘贴不接管（默认行为照旧）', async () => {
    const wrapper = await mountEditor('开头')

    pasteFiles(wrapper.get('.tiptap').element, [
      new File(['纯文本'], 'note.txt', { type: 'text/plain' }),
    ])
    await flushPromises()

    expect(uploadNoteImage).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})

describe('笔记编辑器：拖拽改图片尺寸', () => {
  const ONE_IMAGE = `![图](${URL_A})`

  it('拖右下角手柄改宽，尺寸写进正文；用这份正文重新挂载后尺寸还在', async () => {
    const wrapper = await mountEditor(ONE_IMAGE)
    const image = wrapper.get('.tiptap img').element as HTMLImageElement
    stubLayout(image, { width: 400, height: 300 })

    const handle = wrapper.get('[data-resize-handle="bottom-right"]').element as HTMLElement
    dragHandle(handle, [400, 300], [460, 300]) // 往右拖 60px
    await flushPromises()

    // 尺寸落进正文：宽度 400 + 60，且只带 width（高度由宽度与图片自身比例决定）
    const saved = lastMarkdown(wrapper)
    expect(saved).toContain(`![图](${URL_A}){width=460}`)
    expect(image.style.width).toBe('460px')

    wrapper.unmount()

    // 刷新：把刚存下来的正文重新挂一遍，宽度仍然在
    const reopened = await mountEditor(saved)
    const restored = reopened.get('.tiptap img').element as HTMLImageElement
    expect(restored.style.width).toBe('460px')

    reopened.unmount()
  })

  it('没有尺寸的图不会被写上尺寸（只有在拖过之后才有）', async () => {
    const wrapper = await mountEditor(ONE_IMAGE)

    expect(wrapper.html()).not.toContain('{width=')
    expect(wrapper.find('[data-resize-handle="bottom-right"]').exists()).toBe(true)

    wrapper.unmount()
  })

  it('图片外面是 ResizableNodeView 的那套壳（样式才有的放矢）', async () => {
    const wrapper = await mountEditor(ONE_IMAGE)

    // 手柄挂在"包裹层"里、图片是包裹层的孩子——画布的两条样式
    // （`[data-resize-wrapper] img` 的高度、手柄的样子）都指着这两个钩子
    expect(wrapper.find('[data-resize-container]').exists()).toBe(true)
    expect(wrapper.find('[data-resize-wrapper] img').exists()).toBe(true)

    wrapper.unmount()
  })

  it('手柄是安静的：平时透明，悬停/拖拽时才现出来（样式契约）', () => {
    // vitest 默认 `css: false`，SFC 的 <style> 根本不进 jsdom（同 NotesView.test.ts 的注记），
    // "手柄不铺一圈常驻边框"这条只能读源码钉住
    expect(styleRule('data-resize-handle]')).toMatch(/opacity:\s*0/)
    expect(styleRule(':hover [data-resize-handle]')).toMatch(/opacity:\s*1/)
    expect(styleRule("data-resize-state='true'")).toMatch(/opacity:\s*1/)
  })

  it('只读笔记：编辑器进只读态，缩放手柄被样式藏起来', async () => {
    const wrapper = mount(NoteEditor, {
      props: { modelValue: ONE_IMAGE, noteId: 'n1', editable: false },
      attachTo: document.body,
    })
    await flushPromises()

    expect(wrapper.get('.tiptap').attributes('contenteditable')).toBe('false')
    // 手柄由 Tiptap 的 ResizableNodeView 挂上，它要等到**文档有改动**（update 事件）
    // 才摘手柄——只读笔记可能一直不产生 update，所以用一条样式规则兜底
    expect(styleRule("contenteditable='false'")).toMatch(/display:\s*none/)

    wrapper.unmount()
  })
})

describe('笔记编辑器：既有行为不回归', () => {
  it('「插入图片」按钮：选文件后照样上传并插入', async () => {
    const wrapper = await mountEditor('开头')
    const input = wrapper.get('input.file-input').element as HTMLInputElement
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File([new Uint8Array([1, 2])], 'picked.png', { type: 'image/png' })],
    })

    await wrapper.get('input.file-input').trigger('change')
    await flushPromises()

    expect(uploadNoteImage).toHaveBeenCalledTimes(1)
    expect(lastMarkdown(wrapper)).toContain(`![image.png](${URL_A})`)

    wrapper.unmount()
  })

  it('AI 动作仍然照常发出', async () => {
    const wrapper = await mountEditor('正文')

    const items = wrapper.findAll('.menu-list button')
    expect(items.length).toBeGreaterThan(0)
    await items[0].trigger('click')

    expect(wrapper.emitted('ai')?.[0]?.[0]).toBe('format')

    wrapper.unmount()
  })
})
