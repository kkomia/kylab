/**
 * 数值滑杆（RangeField）的契约。
 *
 * 这个控件的价值全在"位置算得准不准"上：刻度点铺在轨道上，只要位置换算错半个滑块，
 * 用户拖到点上就不再是那个值——肉眼看着"差不多"，实际永远差几格。所以钉三条：
 * 1. 值 → 位置的换算必须带上滑块半径（`--range-thumb`），不能裸用百分比；
 * 2. 刻度点不能挡住拖动（`pointer-events: none` 写在样式里，这里用 class 位置断言替身
 *    没法验证，改为断言它确实是 `aria-hidden` 的纯展示元素、且不参与 tab 序列）；
 * 3. 读数常驻——滑杆藏了精度，没有读数就只能靠猜。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import RangeField from '@/components/ui/RangeField.vue'

function mountRange(props: Record<string, unknown> = {}) {
  return mount(RangeField, {
    props: { modelValue: 512, min: 128, max: 2048, ...props },
  })
}

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
    // 补一句类型：原生 input 回传的是字符串，控件要负责转成 number，
    // 否则父组件的 number 模型会收到字符串（类型拦不住运行期）
    expect(typeof (wrapper.emitted('update:modelValue')?.at(-1)?.[0] as number)).toBe('number')
  })

  it('读数常驻', () => {
    expect(mountRange().get('output').text()).toBe('512')
    expect(mountRange({ modelValue: 1024 }).get('output').text()).toBe('1024')
  })

  it('刻度点位置带上滑块半径，不是裸百分比', () => {
    const wrapper = mountRange({ marks: [{ value: 512, primary: true }] })
    const left = wrapper.get('.range-mark').attributes('style') ?? ''
    // 512 在 [128, 2048] 上正好是 20%
    expect(left).toContain('0.2')
    // 关键：位置要从 (100% - 滑块) 里算——裸 20% 会在两端各差半个滑块
    expect(left).toContain('--range-thumb')
    // 「默认」小字必须与刻度点用同一个算式；两处各写一份迟早会错开。
    // 注意：`--range-thumb` 定义在哪个元素上（必须挂在两者共同的祖先，
    // 否则 calc 失效、left 退回 auto）只有真机能验证，jsdom 不做变量解析——
    // 这条改动真机量过（见 开发计划 §12.83）。
    expect(wrapper.get('.range-note').attributes('style')).toBe(left)
  })

  it('默认值那个点带 primary 标记；普通刻度点不带', () => {
    const wrapper = mountRange({
      marks: [{ value: 512, primary: true }, { value: 1024 }],
    })
    const marks = wrapper.findAll('.range-mark')
    expect(marks).toHaveLength(2)
    expect(marks[0].classes()).toContain('range-mark-primary')
    expect(marks[1].classes()).not.toContain('range-mark-primary')
  })

  it('刻度点对读屏器与键盘都不可达——它只是路标，不是第二个把手', () => {
    const mark = mountRange({ marks: [{ value: 512, primary: true }] }).get('.range-mark')
    expect(mark.attributes('aria-hidden')).toBe('true')
    expect(mark.element.tagName).not.toBe('BUTTON')
  })

  it('没有 primary 刻度点时不渲染「默认」标注，也不留空行', () => {
    const wrapper = mountRange({ marks: [{ value: 1024 }] })
    expect(wrapper.find('.range-note').exists()).toBe(false)
    expect(wrapper.find('.range-col-marked').exists()).toBe(false)
  })
})
