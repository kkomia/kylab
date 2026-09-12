/**
 * 图标基座与"用户点名来源"图标的契约（《前端设计规范》§3）。
 *
 * 全仓图标走同一套口径：24×24 网格、`currentColor`、不引外链图标库。
 * `IconChatNew` 的几何来自 Ant Design Icons（阿里体系，MIT），是本仓第二处
 * 例外（第一处是用户提供的 `IconSidebar`）。例外的代价是**必须自己把坐标系搬对、
 * 把颜色交还给 `currentColor`**——这两件事一错就是"某个主题下图标看不见"
 * 或者"比旁边大一圈"，属于看着正常却悄悄退化的问题，所以钉在这里。
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

  it('对读屏器隐藏——图标语义由外层 aria-label / title 承担', () => {
    const svg = mount(IconBase).get('svg')
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('focusable')).toBe('false')
  })
})

describe('IconChatNew', () => {
  it('把 Ant 的 64..960 内容盒映射到 2..22（与 Remix 图标同一光学尺寸）', () => {
    const transform = mount(IconChatNew).get('g').attributes('transform') ?? ''
    const m =
      /translate\(([\d.]+) ([\d.]+)\)\s*scale\(([\d.]+)\)\s*translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(
        transform,
      )
    expect(m, `transform 的形状变了：${transform}`).toBeTruthy()
    const [tx, ty, scale, ix, iy] = m!.slice(1).map(Number)
    // 里层平移把 Ant 的 64 原点挪到 0
    expect(ix).toBeCloseTo(-64, 6)
    expect(iy).toBeCloseTo(-64, 6)
    // 内容盒 64..960 → [tx, tx + 896·scale]，必须正好是 [2, 22]：
    // 铺满 0..24 会比旁边 Remix 图标大一圈（Ant 满格、Remix 内缩 2），缩错则肉眼才看得出
    expect(tx).toBeCloseTo(2, 6)
    expect(ty).toBeCloseTo(2, 6)
    expect(tx + 896 * scale).toBeCloseTo(22, 6)
  })

  it('不留死 fill——颜色只能由 currentColor 决定', () => {
    const wrapper = mount(IconChatNew)
    expect(wrapper.find('svg').attributes('fill')).toBe('currentColor')
    // 只有根 svg 带 fill：任何一条 path 上再挂个 fill 都会在深色主题下露馅
    expect(wrapper.findAll('[fill]')).toHaveLength(1)
  })

  it('几何完整：圆圈 + 加号两条路径', () => {
    const paths = mount(IconChatNew).findAll('path')
    expect(paths).toHaveLength(2)
    for (const path of paths) {
      expect((path.attributes('d') ?? '').length).toBeGreaterThan(40)
    }
  })
})
