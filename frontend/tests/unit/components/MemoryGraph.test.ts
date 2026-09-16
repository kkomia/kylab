import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import type { MemoryGraph as GraphData } from '@/api/memory'
import MemoryGraph from '@/components/memory/MemoryGraph.vue'
import { resizeTo, resetResizeObservers } from '../../setup'

/**
 * 记忆图谱（v0.14 三期）。
 *
 * 布局是**确定性**的（没有物理引擎，见组件头），所以坐标、连线数、节点数都能断言；
 * 这几条也正是"力导向图库"换不来的东西：同一份输入永远画出同一个形状，
 * 用户才能拿它比对"我改完之后结构变没变"。
 */
function graphOf(partial: Partial<GraphData>): GraphData {
  return { nodes: [], edges: [], dangling: [], ...partial }
}

function render(graph: GraphData) {
  return mount(MemoryGraph, { props: { graph } })
}

beforeEach(() => {
  resetResizeObservers()
})

describe('MemoryGraph', () => {
  it('一条边画一条线，节点数与输入一致', () => {
    const wrapper = render(
      graphOf({
        nodes: [
          { path: 'digest/a.md', title: 'A', kind: 'digest', degree: 1 },
          { path: 'digest/b.md', title: 'B', kind: 'digest', degree: 1 },
        ],
        edges: [['digest/a.md', 'digest/b.md']],
      }),
    )

    expect(wrapper.findAll('.graph-node')).toHaveLength(2)
    expect(wrapper.findAll('.graph-links line')).toHaveLength(1)
  })

  it('孤立节点不画进图里', () => {
    const wrapper = render(
      graphOf({
        nodes: [{ path: 'MEMORY.md', title: 'MEMORY.md', kind: 'core', degree: 0 }],
        edges: [],
      }),
    )

    expect(wrapper.findAll('.graph-node')).toHaveLength(0)
    expect(wrapper.text()).toContain('还没有链接')
  })

  it('同一份输入画出同一组坐标（可复现）', () => {
    const graph = graphOf({
      nodes: [
        { path: 'digest/hub.md', title: '枢纽', kind: 'digest', degree: 2 },
        { path: 'digest/a.md', title: 'A', kind: 'digest', degree: 1 },
        { path: 'digest/b.md', title: 'B', kind: 'digest', degree: 1 },
      ],
      edges: [
        ['digest/hub.md', 'digest/a.md'],
        ['digest/hub.md', 'digest/b.md'],
      ],
    })

    const once = render(graph)
      .findAll('.graph-node')
      .map((n) => n.attributes('transform'))
    const twice = render(graph)
      .findAll('.graph-node')
      .map((n) => n.attributes('transform'))

    expect(once).toEqual(twice)
    expect(new Set(once).size).toBe(3) // 三个节点不重叠
  })

  it('度数最大的节点当中心，同层节点等距铺开', () => {
    const wrapper = render(
      graphOf({
        nodes: [
          { path: 'digest/hub.md', title: '枢纽', kind: 'digest', degree: 2 },
          { path: 'digest/a.md', title: 'A', kind: 'digest', degree: 1 },
          { path: 'digest/b.md', title: 'B', kind: 'digest', degree: 1 },
        ],
        edges: [
          ['digest/hub.md', 'digest/a.md'],
          ['digest/hub.md', 'digest/b.md'],
        ],
      }),
    )

    // 断言**几何关系**而不是硬编码坐标：坐标是布局实现的产物，改一点就会变，
    // 而那不是"错了"；"枢纽在中间、同层等距"才是这张图要保证的东西。
    const points = wrapper.findAll('.graph-node').map((node) => {
      const [, x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(node.attributes('transform') ?? '')!
      return { x: Number(x), y: Number(y) }
    })
    const [hub, ...ring] = points

    const distances = ring.map((point) => Math.hypot(point.x - hub.x, point.y - hub.y))
    expect(distances[0]).toBeCloseTo(distances[1], 6)
    expect(distances[0]).toBeGreaterThan(1)
    // 中心节点的位置 = 同层两点的中点（半径 0 的枢纽就在圆心）
    expect(hub.x).toBeCloseTo((ring[0].x + ring[1].x) / 2, 6)
    expect(hub.y).toBeCloseTo((ring[0].y + ring[1].y) / 2, 6)
  })

  it('两个分量并排摆开，互不重叠', () => {
    const wrapper = render(
      graphOf({
        nodes: [
          { path: 'a/1.md', title: '1', kind: 'digest', degree: 1 },
          { path: 'a/2.md', title: '2', kind: 'digest', degree: 1 },
          { path: 'b/1.md', title: '1', kind: 'daily', degree: 1 },
          { path: 'b/2.md', title: '2', kind: 'daily', degree: 1 },
        ],
        edges: [
          ['a/1.md', 'a/2.md'],
          ['b/1.md', 'b/2.md'],
        ],
      }),
    )

    const xs = wrapper
      .findAll('.graph-node')
      .map((node) => Number(/translate\(([\d.]+)/.exec(node.attributes('transform') ?? '')?.[1]))

    // 前两点的 x 全部小于后两点 —— 分量按格子排布
    expect(Math.max(xs[0], xs[1])).toBeLessThan(Math.min(xs[2], xs[3]))
  })

  it('悬空链接单独报出来，不进图', () => {
    const wrapper = render(
      graphOf({
        nodes: [
          { path: 'digest/a.md', title: 'A', kind: 'digest', degree: 0 },
          { path: 'digest/b.md', title: 'B', kind: 'digest', degree: 0 },
        ],
        edges: [],
        dangling: [['digest/a.md', '写错的名字']],
      }),
    )

    const text = wrapper.text()
    expect(text).toContain('1 条链接指向不存在的文件')
    expect(text).toContain('写错的名字')
    expect(wrapper.findAll('.graph-node')).toHaveLength(0)
  })

  it('点了节点把路径抛给父组件', async () => {
    const wrapper = render(
      graphOf({
        nodes: [
          { path: 'digest/a.md', title: 'A', kind: 'digest', degree: 1 },
          { path: 'digest/b.md', title: 'B', kind: 'digest', degree: 1 },
        ],
        edges: [['digest/a.md', 'digest/b.md']],
      }),
    )

    await wrapper.findAll('.graph-node')[0].trigger('click')

    expect(wrapper.emitted('select')?.[0]).toEqual(['digest/a.md'])
  })

  it('画布变宽时把间距放大，字号不跟着放大', async () => {
    const wrapper = render(
      graphOf({
        nodes: [
          { path: 'digest/hub.md', title: '枢纽', kind: 'digest', degree: 2 },
          { path: 'digest/a.md', title: 'A', kind: 'digest', degree: 1 },
          { path: 'digest/b.md', title: 'B', kind: 'digest', degree: 1 },
        ],
        edges: [
          ['digest/hub.md', 'digest/a.md'],
          ['digest/hub.md', 'digest/b.md'],
        ],
      }),
    )

    const narrow = wrapper.find('svg').attributes('width')

    // 模拟画布变宽（jsdom 没有布局引擎，用 setup 里的桩手动喂一个尺寸）
    resizeTo(900)
    await wrapper.vm.$nextTick()

    const wide = wrapper.find('svg').attributes('width')
    expect(Number(wide)).toBeGreaterThan(Number(narrow))
    // 节点半径不跟着放大：放大间距是为了用上空间，不是把这一页的圆和字变大。
    // 度 2 → 7 + 2×1.8 = 10.6（半径常量在 graphLayout 里）
    expect(wrapper.find('.graph-node circle').attributes('r')).toBe('10.6')
  })
})
