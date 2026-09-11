/**
 * 多选下拉（AppMultiSelect）的交互契约。
 *
 * 它替换了原来"一排放不下的知识库胶囊"，所以最要紧的两条与单选不同：
 * **勾选后面板不关**（否则选三个库要开三次）、**有搜索与全选/清空**。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AppMultiSelect from '@/components/ui/AppMultiSelect.vue'

const OPTIONS = [
  { value: 'kb_1', label: '产品手册', hint: '2' },
  { value: 'kb_2', label: '眼科指南', hint: '3' },
  { value: 'kb_3', label: 'RSS 订阅测试' },
]

function mountSelect(value: string[] = []) {
  return mount(AppMultiSelect, {
    props: { options: OPTIONS, modelValue: value, ariaLabel: '知识库' },
    attachTo: document.body,
  })
}

describe('AppMultiSelect', () => {
  it('一个都没选时显示占位符', () => {
    const wrapper = mountSelect([])
    expect(wrapper.find('.multi-value').text()).toContain('未选择')
    expect(wrapper.find('.multi-pop').exists()).toBe(false)
  })

  it('全部选中时触发器的文案说"全部 N 个"', () => {
    const wrapper = mountSelect(['kb_1', 'kb_2', 'kb_3'])
    expect(wrapper.find('.multi-value').text()).toContain('全部 3 个')
  })

  it('部分选中时报个数', () => {
    const wrapper = mountSelect(['kb_1', 'kb_2'])
    expect(wrapper.find('.multi-value').text()).toContain('2 个已选')
  })

  it('点开显示全部选项，并支持搜索过滤', async () => {
    const wrapper = mountSelect([])

    await wrapper.find('.multi-trigger').trigger('click')
    expect(wrapper.findAll('.multi-option')).toHaveLength(3)

    await wrapper.find('.multi-search-input').setValue('眼科')
    expect(wrapper.findAll('.multi-option')).toHaveLength(1)
    expect(wrapper.find('.multi-option').text()).toContain('眼科指南')
  })

  it('点选项即切换勾选，且面板不关', async () => {
    const wrapper = mountSelect([])

    await wrapper.find('.multi-trigger').trigger('click')
    await wrapper.findAll('.multi-option')[1].trigger('pointerdown')

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['kb_2']])
    // 多选与单选的关键差别：勾完还开着，可以接着勾
    expect(wrapper.find('.multi-pop').exists()).toBe(true)
  })

  it('已选项再点一次即取消', async () => {
    const wrapper = mountSelect(['kb_1', 'kb_2'])

    await wrapper.find('.multi-trigger').trigger('click')
    await wrapper.findAll('.multi-option')[0].trigger('pointerdown')

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['kb_2']])
  })

  it('全选与清空', async () => {
    const wrapper = mountSelect([])

    await wrapper.find('.multi-trigger').trigger('click')
    await wrapper.findAll('.multi-action')[0].trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['kb_1', 'kb_2', 'kb_3']])

    await wrapper.findAll('.multi-action')[1].trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([[]])
  })

  it('Enter 切换高亮项，Esc 只关列表', async () => {
    const wrapper = mountSelect([])

    await wrapper.find('.multi-trigger').trigger('click')
    const search = wrapper.find('.multi-search-input')
    await search.trigger('keydown', { key: 'ArrowDown' })
    await search.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['kb_2']])

    await search.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.multi-pop').exists()).toBe(false)
  })

  it('点外部关闭', async () => {
    const wrapper = mountSelect([])
    await wrapper.find('.multi-trigger').trigger('click')
    expect(wrapper.find('.multi-pop').exists()).toBe(true)

    // jsdom 不实现 PointerEvent，用同名的普通 Event 触发即可（监听器只看类型）
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.multi-pop').exists()).toBe(false)
  })

  it('禁用时点不开', async () => {
    const wrapper = mount(AppMultiSelect, {
      props: { options: OPTIONS, modelValue: [], disabled: true },
      attachTo: document.body,
    })

    await wrapper.find('.multi-trigger').trigger('click')
    expect(wrapper.find('.multi-pop').exists()).toBe(false)
  })
})
