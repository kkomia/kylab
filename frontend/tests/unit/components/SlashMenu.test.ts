/**
 * 输入框里的「/」命令菜单（P1-2，§12.225）。
 *
 * 这个组件钉三件事：
 *
 * 1. **按发现源分组**（内置 / 你放的 / 随代码自带）：出问题时先怀疑自己放的那份；
 * 2. **过滤跟着输入走**：打 `/m` 时 `/mode` 要排在前面（前缀命中优先）；
 * 3. **键盘与点击都要能选中**：↑↓ 由 ChatView 转发给 `move`，回车走 `pickActive`，
 *    点击直接 `pick(command)`——三条路都发同一个 `pick` 事件。
 *
 * 组件**不执行命令**（那是后端的事，见 ChatView 的 `runCommand`）：
 * 它只把用户选中的那一条交出去。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import type { ChatCommand } from '@/api/chat'
import SlashMenu from '@/components/chat/SlashMenu.vue'

function command(name: string, extra: Partial<ChatCommand> = {}): ChatCommand {
  return {
    name,
    summary: `${name} 的说明`,
    usage: `/${name}`,
    group: 'builtin',
    details: [],
    argument_hint: '',
    short_circuit: true,
    shadowed_by: '',
    error: '',
    path: '',
    ...extra,
  }
}

const ITEMS: ChatCommand[] = [
  command('help', { summary: '列出命令' }),
  command('mode', { usage: '/mode [plan|build|edit|yolo]', summary: '切模式' }),
  command('skill', { usage: '/skill <技能名> [任务]', summary: '注入技能', short_circuit: false }),
  command('deploy', { group: 'user', summary: '发版（你放的）' }),
  command('onboard', { group: 'repo', summary: '入职（随代码）' }),
]

function mountMenu(items = ITEMS, filter = '') {
  return mount(SlashMenu, { props: { items, filter } })
}

describe('SlashMenu', () => {
  it('按发现源分组，组内保持后端给的顺序', () => {
    const wrapper = mountMenu()
    expect(wrapper.findAll('.slash-group').map((node) => node.text())).toEqual([
      '内置',
      '自定义（你放的）',
      '自定义（随代码自带）',
    ])
    expect(wrapper.findAll('.slash-usage').map((node) => node.text())).toEqual([
      '/help',
      '/mode [plan|build|edit|yolo]',
      '/skill <技能名> [任务]',
      '/deploy',
      '/onboard',
    ])
  })

  it('空组不画标题（只有内置命令时不该冒出「自定义」那一行）', () => {
    const wrapper = mountMenu([command('help')])
    expect(wrapper.findAll('.slash-group').map((node) => node.text())).toEqual(['内置'])
  })

  it('过滤词命中名字前缀时排在前面', () => {
    const wrapper = mountMenu(ITEMS, 'm')
    expect(wrapper.findAll('.slash-usage').map((node) => node.text())).toEqual([
      '/mode [plan|build|edit|yolo]',
    ])
    // 说明里包含也会留下来（`/help` 的说明是"列出命令"，不含 m）
    const bySummary = mountMenu(ITEMS, '发版')
    expect(bySummary.findAll('.slash-usage').map((node) => node.text())).toEqual(['/deploy'])
  })

  it('上下键循环移动高亮，回车选中当前那条', async () => {
    const wrapper = mountMenu(ITEMS, '')
    const vm = wrapper.vm as unknown as {
      move: (delta: number) => void
      pickActive: () => void
      flat: ChatCommand[]
    }
    expect(vm.flat.map((item) => item.name)).toEqual(['help', 'mode', 'skill', 'deploy', 'onboard'])

    const active = (): string => wrapper.find('.slash-item-active .slash-usage').text()

    vm.move(1)
    await wrapper.vm.$nextTick()
    expect(active()).toBe('/mode [plan|build|edit|yolo]')

    vm.move(-1)
    await wrapper.vm.$nextTick()
    expect(active()).toBe('/help')

    // 到顶再往上回到底（循环，不是卡住）
    vm.move(-1)
    await wrapper.vm.$nextTick()
    expect(active()).toBe('/onboard')

    vm.pickActive()
    const picked = wrapper.emitted('pick')
    expect(picked).toBeTruthy()
    expect((picked?.[0]?.[0] as ChatCommand).name).toBe('onboard')
  })

  it('点击某一项直接选中它', async () => {
    const wrapper = mountMenu()
    await wrapper.findAll('.slash-item')[2]?.trigger('click')
    const picked = wrapper.emitted('pick')
    expect((picked?.[0]?.[0] as ChatCommand).name).toBe('skill')
  })

  it('过滤词一变，高亮回到第一条（不然会停在一条看不见的项上）', async () => {
    const wrapper = mountMenu(ITEMS, '')
    const vm = wrapper.vm as unknown as { move: (delta: number) => void }
    vm.move(1)
    vm.move(1)
    await wrapper.setProps({ filter: 'deploy' })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.slash-item-active .slash-usage').text()).toBe('/deploy')
  })

  it('菜单里写明命令不进模型历史（用户要看得见这件事）', () => {
    expect(mountMenu().find('.slash-foot').text()).toContain('不进模型历史')
  })
})
