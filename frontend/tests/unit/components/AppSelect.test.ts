/**
 * 自绘下拉（AppSelect）的交互契约。
 *
 * 为什么值得测：它把原生 `<select>` 换成了自绘 combobox——**系统帮我们做对的那部分
 * 现在得自己保证**。这里钉三条最容易在重构里悄悄坏掉的性质：
 *
 * 1. 点触发器开、点外部关（`pointerdown` 在捕获阶段，内层 stopPropagation 挡不住）；
 * 2. 键盘：方向键移动高亮、Enter 选中、Esc 关闭，且**焦点始终留在触发器上**
 *    （WAI-ARIA combobox 的 activedescendant 模式，屏幕阅读器与键盘共用一份状态）；
 * 3. 选中的那一项带勾选标记——这是"当前值是哪个"的唯一视觉线索。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AppSelect from '@/components/ui/AppSelect.vue'

const OPTIONS = [
  { value: '', label: '（不指定）' },
  { value: 'read', label: '只读' },
  { value: 'write', label: '可写' },
]

function mountSelect(value = '') {
  return mount(AppSelect, {
    props: { options: OPTIONS, modelValue: value, ariaLabel: '档位' },
    attachTo: document.body,
  })
}

describe('AppSelect', () => {
  it('默认关闭，触发器显示当前选项的文案', () => {
    const wrapper = mountSelect('read')

    expect(wrapper.find('.select-trigger').text()).toContain('只读')
    expect(wrapper.find('.select-pop').exists()).toBe(false)
    expect(wrapper.find('.select-trigger').attributes('aria-expanded')).toBe('false')
  })

  it('点击触发器展开，并把高亮停在当前值上', async () => {
    const wrapper = mountSelect('write')

    await wrapper.find('.select-trigger').trigger('click')

    const options = wrapper.findAll('.select-option')
    expect(options).toHaveLength(3)
    expect(options[2].classes()).toContain('select-option-active')
  })

  it('方向键移动高亮、Enter 选中，焦点不离开触发器', async () => {
    const wrapper = mountSelect('')
    const trigger = wrapper.find('.select-trigger')

    await trigger.trigger('click')
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    await trigger.trigger('keydown', { key: 'Enter' })

    // 第一条是空值，向下一次应落到 'read'
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['read'])
    expect(wrapper.find('.select-pop').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.find('.select-trigger').element)
  })

  it('Esc 关闭且不改值', async () => {
    const wrapper = mountSelect('read')
    const trigger = wrapper.find('.select-trigger')

    await trigger.trigger('click')
    await trigger.trigger('keydown', { key: 'Escape' })

    expect(wrapper.find('.select-pop').exists()).toBe(false)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('点选项即选中并关闭', async () => {
    const wrapper = mountSelect('')

    await wrapper.find('.select-trigger').trigger('click')
    await wrapper.findAll('.select-option')[1].trigger('pointerdown')

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['read'])
    expect(wrapper.find('.select-pop').exists()).toBe(false)
  })

  it('选中的那一项带勾选标记', async () => {
    const wrapper = mountSelect('write')

    await wrapper.find('.select-trigger').trigger('click')

    const selected = wrapper
      .findAll('.select-option')
      .filter((o) => o.attributes('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].find('.select-check').exists()).toBe(true)
  })

  it('点外部关闭', async () => {
    const wrapper = mountSelect('')
    await wrapper.find('.select-trigger').trigger('click')
    expect(wrapper.find('.select-pop').exists()).toBe(true)

    // jsdom 不实现 PointerEvent，用同名的普通 Event 触发即可（监听器只看类型）
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))

    await wrapper.vm.$nextTick()
    expect(wrapper.find('.select-pop').exists()).toBe(false)
  })

  it('禁用时点不开', async () => {
    const wrapper = mount(AppSelect, {
      props: { options: OPTIONS, modelValue: '', disabled: true },
      attachTo: document.body,
    })

    await wrapper.find('.select-trigger').trigger('click')

    expect(wrapper.find('.select-pop').exists()).toBe(false)
  })
})
