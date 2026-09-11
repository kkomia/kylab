/**
 * 可搜索 + 手写组合框（AppCombobox）的交互契约。
 *
 * 它要同时满足两件本来互相拉扯的事：**能从候选里挑**（搜索、方向键、点选），
 * 也**允许候选之外的值**（上游探测不到时手写）。这里把那两条都钉住——
 * 因为它们正是加这个组件的理由（见组件头注释）。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AppCombobox from '@/components/ui/AppCombobox.vue'

const OPTIONS = [
  { value: 'BAAI/bge-m3', label: 'BAAI/bge-m3 · siliconflow' },
  { value: 'deepseek-chat', label: 'deepseek-chat' },
  { value: 'Qwen/Qwen2.5', label: 'Qwen/Qwen2.5 · alibaba' },
]

function mountCombo(value = '', props: Record<string, unknown> = {}) {
  return mount(AppCombobox, {
    props: { options: OPTIONS, modelValue: value, ariaLabel: '模型 ID', ...props },
    attachTo: document.body,
  })
}

describe('AppCombobox', () => {
  it('默认关闭，输入框显示当前值', () => {
    const wrapper = mountCombo('deepseek-chat')

    expect((wrapper.find('.combo-input').element as HTMLInputElement).value).toBe('deepseek-chat')
    expect(wrapper.find('.combo-pop').exists()).toBe(false)
  })

  it('聚焦展开全部候选，即使输入框里已经有值', async () => {
    const wrapper = mountCombo('deepseek-chat')

    await wrapper.find('.combo-input').trigger('focus')

    // 有值时也要看到别的候选，否则等于"只能选到当前这一条"
    expect(wrapper.findAll('.combo-option')).toHaveLength(3)
  })

  it('输入即搜索：按 id 或归属过滤', async () => {
    const wrapper = mountCombo('')
    const input = wrapper.find('.combo-input')

    await input.setValue('bge')
    expect(wrapper.findAll('.combo-option')).toHaveLength(1)

    await input.setValue('alibaba')
    expect(wrapper.findAll('.combo-option')).toHaveLength(1)
    expect(wrapper.find('.combo-option').text()).toContain('Qwen/Qwen2.5')
  })

  it('点候选项即选中并关闭', async () => {
    const wrapper = mountCombo('')

    await wrapper.find('.combo-input').trigger('focus')
    await wrapper.findAll('.combo-option')[1].trigger('pointerdown')

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['deepseek-chat'])
    expect(wrapper.find('.combo-pop').exists()).toBe(false)
  })

  it('方向键移动高亮、Enter 选中', async () => {
    const wrapper = mountCombo('')
    const input = wrapper.find('.combo-input')

    await input.trigger('focus')
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['deepseek-chat'])
    expect(wrapper.find('.combo-pop').exists()).toBe(false)
  })

  it('候选之外的值可以直接手写', async () => {
    const wrapper = mountCombo('')

    // 输入一个不在候选里的 id：不作任何拦截，原样作为值
    await wrapper.find('.combo-input').setValue('my/private-model')

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['my/private-model'])
  })

  it('Esc 只关列表、不改值', async () => {
    const wrapper = mountCombo('deepseek-chat')

    await wrapper.find('.combo-input').trigger('focus')
    await wrapper.find('.combo-input').trigger('keydown', { key: 'Escape' })

    expect(wrapper.find('.combo-pop').exists()).toBe(false)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('拉取中显示加载态；候选为空时提示可直接输入', async () => {
    const loading = mountCombo('', { loading: true })
    await loading.find('.combo-input').trigger('focus')
    expect(loading.find('.combo-note').text()).toContain('正在拉取')

    const empty = mountCombo('', { options: [] })
    await empty.find('.combo-input').trigger('focus')
    expect(empty.find('.combo-note').text()).toContain('直接输入')
  })

  it('禁用时点不开', async () => {
    const wrapper = mountCombo('', { disabled: true })

    await wrapper.find('.combo-toggle').trigger('click')

    expect(wrapper.find('.combo-pop').exists()).toBe(false)
  })
})
