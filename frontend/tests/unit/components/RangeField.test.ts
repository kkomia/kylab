/**
 * 数值滑杆（RangeField）的契约。
 *
 * 这个控件的价值全在"位置算得准不准"上：刻度点与刻度数值铺在轨道上，只要位置换算
 * 错半个滑块，用户拖到点上就不再是那个值——肉眼看着"差不多"，实际永远差几格。
 * 所以钉四条：
 * 1. 值 → 位置的换算必须带上滑块半径（`--range-thumb`），不能裸用百分比；
 * 2. 刻度数值与刻度点必须用**同一个**算式（两处各写一份迟早会错开）；
 * 3. 越界的刻度要丢掉——重叠的上限跟着块长走，块长调小时 128/256 必须消失；
 * 4. 读数常驻——滑杆藏了精度，没有读数就只能靠猜。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import RangeField from '@/components/ui/RangeField.vue'

function mountRange(props: Record<string, unknown> = {}) {
  return mount(RangeField, {
    props: { modelValue: 512, min: 128, max: 2048, ...props },
  })
}

const MARKS = [
  { value: 128 },
  { value: 256 },
  { value: 512, primary: true },
  { value: 1024 },
  { value: 2048 },
]

describe('RangeField', () => {
  it('渲染原生 range，范围/步长/当前值都透传', () => {
    const input = mountRange({ step: 2 }).get('input')
    expect(input.attributes('type')).toBe('range')
    expect(input.attributes('min')).toBe('128')
    expect(input.attributes('max')).toBe('2048')
    expect(input.attributes('step')).toBe('2')
    expect(input.attributes('value')).toBe('512')
  })

  it('拖动时把值作为 number 抛给父组件', async () => {
    const wrapper = mountRange()
    const input = wrapper.get('input')
    ;(input.element as HTMLInputElement).value = '700'
    await input.trigger('input')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([700])
    // 原生 input 回传的是字符串，控件要负责转成 number，
    // 否则父组件的 number 模型会收到字符串（类型拦不住运行期）
    expect(typeof (wrapper.emitted('update:modelValue')?.at(-1)?.[0] as number)).toBe('number')
  })

  it('读数常驻', () => {
    expect(mountRange().get('output').text()).toBe('512')
    expect(mountRange({ modelValue: 1024 }).get('output').text()).toBe('1024')
  })

  it('每个常用值都有一个刻度点 + 一个数值标签', () => {
    const wrapper = mountRange({ marks: MARKS })
    expect(wrapper.findAll('.range-mark')).toHaveLength(5)
    expect(wrapper.findAll('.range-mark-label').map((el) => el.text())).toEqual([
      '128',
      '256',
      '512',
      '1024',
      '2048',
    ])
  })

  it('刻度位置带上滑块半径，不是裸百分比；点与数值用同一算式', () => {
    const wrapper = mountRange({ marks: [{ value: 512, primary: true }] })
    const mark = wrapper.get('.range-mark')
    const left = mark.attributes('style') ?? ''
    // 512 在 [128, 2048] 上正好是 20%
    expect(left).toContain('0.2')
    // 关键：位置要从 (100% - 滑块) 里算——裸 20% 会在两端各差半个滑块
    expect(left).toContain('--range-thumb')
    // 数值标签与刻度点必须落在同一个 x 上；两处各写一份算式迟早会错开。
    // 注意：`--range-thumb` 定义在哪个元素上（必须挂在两者共同的祖先，
    // 否则 calc 失效、left 退回 auto）只有真机能验证，jsdom 不做变量解析——
    // 这个坑真机量到过 145px 的偏差，见 开发计划 §12.83。
    expect(wrapper.get('.range-mark-label').attributes('style')).toBe(left)
  })

  it('越界的刻度点直接丢掉（重叠上限跟着块长变时必须如此）', () => {
    const wrapper = mountRange({
      modelValue: 32,
      min: 0,
      max: 64,
      marks: [
        { value: 0 },
        { value: 32 },
        { value: 64, primary: true },
        { value: 128 },
        { value: 256 },
      ],
    })
    expect(wrapper.findAll('.range-mark-label').map((el) => el.text())).toEqual(['0', '32', '64'])
  })

  it('默认值那个点与它的数值都带 primary 标记；普通刻度不带', () => {
    const wrapper = mountRange({ marks: MARKS })
    const marks = wrapper.findAll('.range-mark')
    const labels = wrapper.findAll('.range-mark-label')
    expect(marks[2].classes()).toContain('range-mark-primary')
    expect(labels[2].classes()).toContain('range-mark-label-primary')
    expect(marks[1].classes()).not.toContain('range-mark-primary')
    expect(labels[1].classes()).not.toContain('range-mark-label-primary')
  })

  it('刻度对读屏器与键盘都不可达——它只是路标，不是第二个把手', () => {
    const wrapper = mountRange({ marks: MARKS })
    for (const mark of [
      ...wrapper.findAll('.range-mark'),
      ...wrapper.findAll('.range-mark-label'),
    ]) {
      expect(mark.attributes('aria-hidden')).toBe('true')
      expect(mark.element.tagName).not.toBe('BUTTON')
    }
  })

  it('没有刻度时不渲染标签行、也不留空行', () => {
    const wrapper = mountRange()
    expect(wrapper.find('.range-mark-label').exists()).toBe(false)
    expect(wrapper.find('.range-col-marked').exists()).toBe(false)
  })
})
