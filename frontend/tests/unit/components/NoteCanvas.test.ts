/**
 * 文档画布：切换笔记靠"换实例"来隔离撤销栈。
 *
 * 背景：Tiptap v3 自己维护 state，没有清撤销栈的公开 API
 * （`editor.view.updateState(EditorState.create(...))` 在 v3 上不生效——
 * 实测 `editor.state === before` 仍为真，`can().undo()` 依旧 true）。
 * 所以隔离只能靠新实例；本用例钉住"新实例的历史是空的"这个前提，
 * 免得哪天有人把它换回"重建 state"的写法而悄悄退化成跨笔记撤销。
 */
import { flushPromises, mount } from '@vue/test-utils'
import type { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'

import NoteCanvas from '@/components/notes/NoteCanvas.vue'

async function mountCanvas(content: string) {
  const wrapper = mount(NoteCanvas, {
    props: { modelValue: content },
    attachTo: document.body,
  })
  // useEditor 在 onMounted 里建实例，ready 要等一轮刷新才送出
  await flushPromises()
  const editor = (wrapper.emitted('ready')?.at(-1)?.[0] ?? null) as Editor | null
  return { wrapper, editor: editor as Editor }
}

describe('NoteCanvas', () => {
  it('挂载后把实例交出来，内容来自 modelValue、撤销栈为空', async () => {
    const { wrapper, editor } = await mountCanvas('# 第一条\n\n正文')

    expect(editor).toBeTruthy()
    expect(editor.getText()).toContain('第一条')
    expect(editor.can().undo()).toBe(false)

    wrapper.unmount()
  })

  it('编辑后会上报 markdown 与交易', async () => {
    const { wrapper, editor } = await mountCanvas('正文')
    editor.commands.insertContent('追加')

    const updates = wrapper.emitted('update:modelValue') ?? []
    expect(String(updates.at(-1)?.[0])).toContain('追加')
    expect(wrapper.emitted('change')?.length ?? 0).toBeGreaterThan(0)
    expect(editor.can().undo()).toBe(true)

    wrapper.unmount()
  })

  it('换一个实例（按 noteId 上 key 的效果）= 新内容 + 空撤销栈', async () => {
    const first = await mountCanvas('第一条的正文')
    first.editor.commands.insertContent('改了一下')
    expect(first.editor.can().undo()).toBe(true)
    first.wrapper.unmount()

    // 模拟 :key 变化后的重建
    const second = await mountCanvas('第二条的正文')

    expect(second.editor).not.toBe(first.editor)
    expect(second.editor.getText()).toContain('第二条')
    // 关键：上一条的编辑不可撤销回来（否则会自动保存写进这一条）
    expect(second.editor.getText()).not.toContain('第一条')
    expect(second.editor.can().undo()).toBe(false)

    second.wrapper.unmount()
  })

  it('外部改 modelValue（AI 写回）会灌进当前实例', async () => {
    const { wrapper, editor } = await mountCanvas('原文')
    await wrapper.setProps({ modelValue: 'AI 整理后的正文' })
    await flushPromises()

    expect(editor.getText()).toContain('AI 整理后的正文')

    wrapper.unmount()
  })
})
