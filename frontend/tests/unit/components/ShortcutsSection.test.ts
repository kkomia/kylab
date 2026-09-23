/**
 * 设置里的那一节「快捷键」（P2-1）。
 *
 * 验收④要的四件事在这一层能看全：**能改**（点「修改」再按一下）、
 * **冲突有提示**（「已被「X」占用」）、**恢复默认可用**、**刷新后还在**
 * （写的是 localStorage，用例直接读它）。
 */
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import ShortcutsSection from '@/components/settings/ShortcutsSection.vue'
import {
  SHORTCUTS_STORAGE_KEY,
  bindingsOf,
  resetAllShortcuts,
  setBinding,
} from '@/composables/useShortcuts'

beforeEach(() => {
  window.localStorage.clear()
  resetAllShortcuts()
})

function mountSection() {
  return mount(ShortcutsSection)
}

/** 找到某条命令那一行（按名字）。 */
function rowOf(wrapper: ReturnType<typeof mountSection>, label: string) {
  return wrapper.findAll('.shortcut-row').find((node) => node.text().includes(label))!
}

describe('快捷键设置', () => {
  it('四条命令都列出来，各自摆着当前的绑定与作用域', () => {
    const wrapper = mountSection()

    expect(wrapper.findAll('.shortcut-row')).toHaveLength(4)
    expect(wrapper.text()).toContain('发送消息')
    expect(wrapper.text()).toContain('新建会话')
    // 作用域要标出来（输入框 / 全局）：它决定"这一条在哪管用"
    expect(rowOf(wrapper, '发送消息').text()).toContain('输入框')
    expect(rowOf(wrapper, '新建会话').text()).toContain('全局')
    // 小片是读注册表的：默认那两条
    expect(
      rowOf(wrapper, '新建会话')
        .findAll('kbd')
        .map((node) => node.text()),
    ).toEqual(['Ctrl', 'K'])
  })

  it('点「修改」再按一下：新绑定生效、**写进 localStorage**、界面跟着变', async () => {
    const wrapper = mountSection()

    const button = rowOf(wrapper, '新建会话').find('.shortcut-keys-btn')
    await button.trigger('click')
    expect(wrapper.text()).toContain('按下新快捷键')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, shiftKey: true }))
    await wrapper.vm.$nextTick()

    expect(bindingsOf('chat.new')).toEqual(['Mod+Shift+O'])
    expect(JSON.parse(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY) as string)).toEqual({
      'chat.new': ['Mod+Shift+O'],
    })
    expect(
      rowOf(wrapper, '新建会话')
        .findAll('kbd')
        .map((node) => node.text()),
    ).toEqual(['Ctrl', 'Shift', 'O'])
  })

  it('撞上别人的绑定就当场说「已被「X」占用」', async () => {
    setBinding('chat.send', 0, 'Mod+K')
    const wrapper = mountSection()

    expect(rowOf(wrapper, '发送消息').text()).toContain('已被「新建会话」占用')
    // 提示是"说一句"，不是"拦着不让改"（用户可能正要把另一条挪走）
    expect(bindingsOf('chat.send')).toEqual(['Mod+K', 'Mod+Enter'])
  })

  it('「恢复默认」只把改过的那一条收回去；「全部恢复默认」把整份记录抹掉', async () => {
    setBinding('chat.new', 0, 'Mod+Shift+O')
    setBinding('layout.toggleSidebar', 0, 'Mod+Shift+B')
    const wrapper = mountSection()

    await rowOf(wrapper, '新建会话')
      .findAll('button')
      .find((n) => n.text() === '恢复默认')!
      .trigger('click')
    expect(bindingsOf('chat.new')).toEqual(['Mod+K'])
    expect(bindingsOf('layout.toggleSidebar')).toEqual(['Mod+Shift+B'])

    await wrapper.find('.shortcut-foot button').trigger('click')
    expect(bindingsOf('layout.toggleSidebar')).toEqual(['Mod+B'])
    expect(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)).toBeNull()
  })

  it('一条命令可以加第二条绑定（加完立刻进入录制）', async () => {
    const wrapper = mountSection()

    await rowOf(wrapper, '切换侧栏')
      .findAll('button')
      .find((n) => n.text() === '添加')!
      .trigger('click')
    expect(wrapper.text()).toContain('按下新快捷键')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, shiftKey: true }))
    await wrapper.vm.$nextTick()

    expect(bindingsOf('layout.toggleSidebar')).toEqual(['Mod+B', 'Mod+Shift+B'])
  })

  it('录制中按 Esc 取消，不留一条空绑定', async () => {
    const wrapper = mountSection()

    await rowOf(wrapper, '切换侧栏')
      .findAll('button')
      .find((n) => n.text() === '添加')!
      .trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()

    expect(bindingsOf('layout.toggleSidebar')).toEqual(['Mod+B'])
    expect(wrapper.text()).not.toContain('按下新快捷键')
  })
})
