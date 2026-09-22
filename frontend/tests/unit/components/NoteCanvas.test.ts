/**
 * 文档画布：**一个实例服务所有笔记**，切换笔记靠原地换文档 + 清撤销栈。
 *
 * 这里钉住两件容易退化的事：
 * 1. 切换笔记**不重建实例**（重建是之前"切换卡一下"的根因）；
 * 2. 撤销栈仍然按笔记隔离（上一条的编辑绝不能被撤销回当前这条——
 *    否则会自动保存把串台内容写进库里）。
 *
 * 第 2 点用 `view.updateState(EditorState.create({ doc, plugins }))` 实现：
 * ProseMirror 会重算所有插件 state，历史自然归零。曾经误以为这招在 Tiptap v3 无效，
 * 于是退化成"换实例"；如果哪天有人把这行删了，下面的用例会立刻红。
 */
import { flushPromises, mount } from '@vue/test-utils'
import type { Editor } from '@tiptap/core'
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

    // jsdom 没有布局引擎，offsetWidth/Height 恒为 0，而缩放正是靠它们算尺寸并在
    // 松手时落库；按我们的 CSS 规则喂一份：宽度取内联样式，高度跟宽度与原图比例
    // （`.editor-content [data-resize-wrapper] img { height: auto !important }`）。
    // 同一条模拟用在 NoteEditor.test.ts 的拖拽用例里。
    const renderedWidth = (): number => Math.round(parseFloat(image.style.width) || 400)
    Object.defineProperty(image, 'offsetWidth', { configurable: true, get: renderedWidth })
    Object.defineProperty(image, 'offsetHeight', {
      configurable: true,
      get: () => Math.round((renderedWidth() * 300) / 400),
    })

    const handle = wrapper.get('[data-resize-handle="bottom-right"]').element as HTMLElement
    const fire = (type: string, x: number): void => {
      const target: EventTarget = type === 'mousedown' ? handle : document
      target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 300 }),
      )
    }
    fire('mousedown', 400)
    fire('mousemove', 460) // 往右拖 60px
    fire('mouseup', 460)
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
