/**
 * 对话模型选择器（ModelPicker）的交互契约。
 *
 * 它把原来并排的三个控件（模型下拉 / 思考开关 / 强度下拉）收进一个浮层，
 * 所以这里钉的是"收进去之后还都能用"：选模型、切思考、切强度，
 * 以及两个容易在重构里坏掉的行为——**选模型后面板收起、切参数后面板留着**。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import ModelPicker from '@/components/ui/ModelPicker.vue'

const OPTIONS = [
  { value: 'deepseek-flash', label: 'deepseek-flash' },
  { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
]
const EFFORTS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

function mountPicker(value = 'deepseek-flash', thinking = true) {
  return mount(ModelPicker, {
    props: {
      options: OPTIONS,
      modelValue: value,
      thinking,
      effort: 'medium',
      efforts: EFFORTS,
      ariaLabel: '模型设置',
    },
    attachTo: document.body,
  })
}

describe('ModelPicker', () => {
  it('触发器显示当前模型名，默认收起', async () => {
    const wrapper = mountPicker()

    expect(wrapper.find('.mp-trigger').text()).toContain('deepseek-flash')
    expect(wrapper.find('.mp-panel').exists()).toBe(false)
    expect(wrapper.find('.mp-trigger').attributes('aria-expanded')).toBe('false')

    wrapper.unmount()
  })

  it('没有匹配模型时显示占位文案', async () => {
    const wrapper = mount(ModelPicker, {
      props: {
        options: [],
        modelValue: '',
        thinking: true,
        effort: 'medium',
        efforts: EFFORTS,
        placeholder: '默认模型',
      },
      attachTo: document.body,
    })

    expect(wrapper.find('.mp-trigger').text()).toContain('默认模型')

    wrapper.unmount()
  })

  it('展开后同时给出模型列表、思考开关与强度三档', async () => {
    const wrapper = mountPicker()

    await wrapper.find('.mp-trigger').trigger('click')

    expect(wrapper.findAll('.mp-model')).toHaveLength(2)
    expect(wrapper.find('[role="switch"]').exists()).toBe(true)
    expect(wrapper.findAll('.mp-seg-btn')).toHaveLength(3)

    wrapper.unmount()
  })

  it('选模型：发出更新并收起面板（这件事做完了）', async () => {
    const wrapper = mountPicker()
    await wrapper.find('.mp-trigger').trigger('click')

    await wrapper.findAll('.mp-model')[1].trigger('click')

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['deepseek-v4-pro'])
    expect(wrapper.find('.mp-panel').exists()).toBe(false)

    wrapper.unmount()
  })

  it('切思考开关：发出更新但**不关面板**（还可能要接着调强度）', async () => {
    const wrapper = mountPicker()
    await wrapper.find('.mp-trigger').trigger('click')

    await wrapper.find('[role="switch"]').trigger('click')

    expect(wrapper.emitted('update:thinking')?.at(-1)).toEqual([false])
    expect(wrapper.find('.mp-panel').exists()).toBe(true)

    wrapper.unmount()
  })

  it('切强度：发出 update:effort', async () => {
    const wrapper = mountPicker()
    await wrapper.find('.mp-trigger').trigger('click')

    await wrapper.findAll('.mp-seg-btn')[2].trigger('click')

    expect(wrapper.emitted('update:effort')?.at(-1)).toEqual(['high'])

    wrapper.unmount()
  })

  it('思考关掉时强度不可选（关着谈强度没有意义）', async () => {
    const wrapper = mountPicker('deepseek-flash', false)
    await wrapper.find('.mp-trigger').trigger('click')

    for (const button of wrapper.findAll('.mp-seg-btn')) {
      expect(button.attributes('disabled')).toBeDefined()
    }

    wrapper.unmount()
  })

  it('思考关掉时触发器带一个标记（非默认态要看得见）', async () => {
    const on = mountPicker('deepseek-flash', true)
    expect(on.find('.mp-badge').exists()).toBe(false)
    on.unmount()

    const off = mountPicker('deepseek-flash', false)
    expect(off.find('.mp-badge').text()).toContain('思考关')
    off.unmount()
  })

  it('点面板外部收起', async () => {
    const wrapper = mountPicker()
    await wrapper.find('.mp-trigger').trigger('click')
    expect(wrapper.find('.mp-panel').exists()).toBe(true)

    // jsdom 不实现 PointerEvent，用同名的普通 Event 触发即可（监听器只看类型）
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.mp-panel').exists()).toBe(false)

    wrapper.unmount()
  })
})
