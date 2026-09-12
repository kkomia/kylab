/**
 * 图标基座与"用户指定来源"图标的契约（《前端设计规范》§3）。
 *
 * 全仓图标走同一套口径：24×24 网格、`currentColor`、不引外链图标库。
 * `IconChatNew` 是本仓第三处例外（前两处是 `IconSidebar`、`IconLogo`），几何照用户
 * 给的参考图描出。例外的代价是**必须自己把网格与线宽调对、把颜色交还给 `currentColor`**
 * ——这几件事一错就是"某个主题下图标看不见"或者"比旁边粗/大一圈"，看着正常却悄悄退化。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import IconBase from '@/components/icons/IconBase.vue'
import IconChatNew from '@/components/icons/IconChatNew.vue'

describe('IconBase', () => {
  it('统一 24 网格、currentColor、默认 16px', () => {
    const svg = mount(IconBase, { slots: { default: '<path d="M0 0h24v24z" />' } }).get('svg')
    expect(svg.attributes('viewBox')).toBe('0 0 24 24')
    expect(svg.attributes('fill')).toBe('currentColor')
    expect(svg.attributes('width')).toBe('16')
    expect(svg.attributes('height')).toBe('16')
  })

  it('size 控制宽高', () => {
    const svg = mount(IconBase, { props: { size: 24 } }).get('svg')
    expect(svg.attributes('width')).toBe('24')
    expect(svg.attributes('height')).toBe('24')
  })

  it('对读屏器隐藏——图标语义由外层的文字 / aria-label 承担', () => {
    const svg = mount(IconBase).get('svg')
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('focusable')).toBe('false')
  })
})

describe('IconChatNew', () => {
  it('直接按 24 网格布点：没有第二套坐标系，就不该有 transform 缩放', () => {
    const wrapper = mount(IconChatNew)
    expect(wrapper.find('g').attributes('transform')).toBeUndefined()
  })

  it('是线稿而不是实心块：fill=none + stroke 走 currentColor', () => {
    const group = mount(IconChatNew).get('g')
    expect(group.attributes('fill')).toBe('none')
    expect(group.attributes('stroke')).toBe('currentColor')
    // 线宽写 1.8：16px 下约 1.2px，与旁边 Remix 那套相当。
    // 描边会随尺寸缩放，写成 24 网格之外的大数（比如 40）会糊成一坨
    expect(Number(group.attributes('stroke-width'))).toBeGreaterThanOrEqual(1.5)
    expect(Number(group.attributes('stroke-width'))).toBeLessThanOrEqual(2.1)
  })

  it('颜色只能来自 currentColor：任何 fill 都只能是 none / currentColor', () => {
    const wrapper = mount(IconChatNew)
    const fills = wrapper.findAll('[fill]').map((el) => el.attributes('fill'))
    expect(fills.length).toBeGreaterThan(0)
    for (const fill of fills) {
      expect(['none', 'currentColor']).toContain(fill)
    }
    // 写死的色值（#hex / rgb()）会在另一套主题下露馅
    expect(wrapper.html()).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgba?\(/)
  })

  it('几何完整：气泡轮廓 + 时钟指针（竖一笔再斜一笔）', () => {
    const paths = mount(IconChatNew).findAll('path')
    expect(paths).toHaveLength(2)
    // 气泡轮廓：圆角矩形 + 左下角小尾巴，点很多，长度自然长
    expect((paths[0].attributes('d') ?? '').length).toBeGreaterThan(80)
    // 指针：竖到圆心再斜向右下——参考图里就是这个形状，
    // 换成别的走向（比如整根横线）这条断言会拦住
    const hands = paths[1].attributes('d') ?? ''
    expect(hands).toMatch(/^M[\d. ]+v[\d.]+l[\d. ]+$/)
  })
})
