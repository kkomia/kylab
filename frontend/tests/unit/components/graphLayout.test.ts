import { describe, expect, it } from 'vitest'

import type { MemoryGraphNode } from '@/api/memory'
import { layoutGraph } from '@/components/memory/graphLayout'

/**
 * 图谱布局（v0.14 三期）。
 *
 * 这是纯函数，所以坐标、连边、居中都直接断言——**布局确定性正是选它而不是
 * 力导向图库的理由**（见 graphLayout.ts 的模块头）：同一份输入永远画出同一个
 * 形状，用户才能拿它比对"改完之后结构变没变"。
 */
function node(
  path: string,
  degree: number,
  kind: MemoryGraphNode['kind'] = 'digest',
): MemoryGraphNode {
  return { path, title: path, kind, degree }
}

function positionOf(
  placed: { node: MemoryGraphNode; x: number; y: number }[],
  path: string,
): { x: number; y: number } {
  const found = placed.find((item) => item.node.path === path)
  if (!found) throw new Error(`没有这个节点：${path}`)
  return { x: found.x, y: found.y }
}

describe('layoutGraph', () => {
  it('两个节点一条边：一中心一外环，连线对上', () => {
    const layout = layoutGraph([node('a.md', 1), node('b.md', 1)], [['a.md', 'b.md']])

    expect(layout.placed).toHaveLength(2)
    expect(layout.links).toHaveLength(1)
    const a = positionOf(layout.placed, 'a.md')
    expect(layout.links[0]).toMatchObject({ x1: a.x, y1: a.y })
    const b = positionOf(layout.placed, 'b.md')

    // 两点间距 = **一层的环间距**。不比一个写死的数字（那是布局常量，改了不算错），
    // 而是比"同样是隔一层"的另一处：两处相等，说明层距是统一的。
    const oneRing = layoutGraph(
      [node('hub.md', 2), node('x.md', 1), node('y.md', 1)],
      [
        ['hub.md', 'x.md'],
        ['hub.md', 'y.md'],
      ],
    )
    const hub = positionOf(oneRing.placed, 'hub.md')
    const leaf = positionOf(oneRing.placed, 'x.md')

    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(
      Math.hypot(hub.x - leaf.x, hub.y - leaf.y),
      6,
    )
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(20)
  })

  it('枢纽在中心、同层等距铺开', () => {
    const layout = layoutGraph(
      [node('hub.md', 2), node('a.md', 1), node('b.md', 1)],
      [
        ['hub.md', 'a.md'],
        ['hub.md', 'b.md'],
      ],
    )

    const hub = positionOf(layout.placed, 'hub.md')
    const a = positionOf(layout.placed, 'a.md')
    const b = positionOf(layout.placed, 'b.md')

    // 中心 = 两点的中点，且两点到中心的距离相等
    expect(hub.x).toBeCloseTo((a.x + b.x) / 2, 6)
    expect(hub.y).toBeCloseTo((a.y + b.y) / 2, 6)
    expect(Math.hypot(a.x - hub.x, a.y - hub.y)).toBeCloseTo(
      Math.hypot(b.x - hub.x, b.y - hub.y),
      6,
    )
  })

  it('同一份输入永远算出同一组坐标', () => {
    const nodes = [node('hub.md', 2), node('a.md', 1), node('b.md', 1), node('c.md', 1)]
    const edges: [string, string][] = [
      ['hub.md', 'a.md'],
      ['hub.md', 'b.md'],
      ['hub.md', 'c.md'],
    ]
    const once = layoutGraph(nodes, edges)
    const twice = layoutGraph(nodes, edges)

    expect(once.placed.map((item) => [item.x, item.y])).toEqual(
      twice.placed.map((item) => [item.x, item.y]),
    )
  })

  it('度数决定半径：链接越多圆越大', () => {
    const layout = layoutGraph(
      [
        node('hub.md', 6),
        node('a.md', 1),
        node('b.md', 1),
        node('c.md', 1),
        node('d.md', 1),
        node('e.md', 1),
        node('f.md', 1),
      ],
      [
        ['hub.md', 'a.md'],
        ['hub.md', 'b.md'],
        ['hub.md', 'c.md'],
        ['hub.md', 'd.md'],
        ['hub.md', 'e.md'],
        ['hub.md', 'f.md'],
      ],
    )

    const hub = layout.placed.find((item) => item.node.path === 'hub.md')
    const leaf = layout.placed.find((item) => item.node.path === 'a.md')
    expect(hub!.r).toBeGreaterThan(leaf!.r)
    // 半径有上限：度 6 与度 20 的圆一样大，否则一个超级枢纽会把画布撑爆
    const capped = layoutGraph([node('mega.md', 40), node('x.md', 1)], [['mega.md', 'x.md']])
    expect(capped.placed.find((item) => item.node.path === 'mega.md')!.r).toBe(hub!.r)
  })

  it('孤立节点（度 0）不画', () => {
    const layout = layoutGraph(
      [node('core.md', 0, 'core'), node('a.md', 1), node('b.md', 1)],
      [['a.md', 'b.md']],
    )

    expect(layout.placed.map((item) => item.node.path)).toEqual(['a.md', 'b.md'])
  })

  it('完全没有边时返回空布局，且 viewBox 合法', () => {
    const layout = layoutGraph([node('a.md', 0)], [])

    expect(layout.placed).toHaveLength(0)
    // 空布局也要给一个能用的 viewBox：SVG 的 viewBox 为 "0 0 0 0" 是无效值
    expect(
      layout.viewBox
        .split(' ')
        .map(Number)
        .every((n) => Number.isFinite(n)),
    ).toBe(true)
    expect(layout.viewBox).not.toContain('0 0 0 0')
  })

  it('两个分量横向排开、各自垂直居中', () => {
    const layout = layoutGraph(
      [
        node('a/1.md', 2),
        node('a/2.md', 1),
        node('a/3.md', 1),
        node('b/1.md', 1),
        node('b/2.md', 1),
      ],
      [
        ['a/1.md', 'a/2.md'],
        ['a/1.md', 'a/3.md'],
        ['b/1.md', 'b/2.md'],
      ],
    )

    const big = ['a/1.md', 'a/2.md', 'a/3.md'].map((path) => positionOf(layout.placed, path))
    const small = ['b/1.md', 'b/2.md'].map((path) => positionOf(layout.placed, path))

    // 横向不重叠
    expect(Math.max(...big.map((p) => p.x))).toBeLessThan(Math.min(...small.map((p) => p.x)))
    // 两个分量共用一条垂直中线。断言的是**各自枢纽的 y 相同**，而不是
    // "两点集包围盒的中心相同"——环上只有 1 个节点时它落在某个角度上，
    // 包围盒本来就不对称，那是布局的正常结果，不是居中没做。
    expect(positionOf(layout.placed, 'a/1.md').y).toBeCloseTo(
      positionOf(layout.placed, 'b/1.md').y,
      6,
    )
  })

  it('节点少时全标名字，节点多时只标枢纽', () => {
    const few = layoutGraph(
      [node('hub.md', 2), node('a.md', 1), node('b.md', 1)],
      [
        ['hub.md', 'a.md'],
        ['hub.md', 'b.md'],
      ],
    )
    expect(few.placed.every((item) => item.labelled)).toBe(true)

    // 铺开一条长链，节点数超过阈值
    const chain = Array.from({ length: 15 }, (_, at) =>
      node(`n${at}.md`, at === 0 || at === 14 ? 1 : 2),
    )
    const chainEdges: [string, string][] = chain
      .slice(1)
      .map((item, at) => [`n${at}.md`, item.path] as [string, string])
    const many = layoutGraph(chain, chainEdges)

    expect(many.placed.some((item) => !item.labelled)).toBe(true)
    expect(many.placed.filter((item) => item.labelled).every((item) => item.node.degree >= 2)).toBe(
      true,
    )
  })

  it('viewBox 给标签留了四周的空白', () => {
    const layout = layoutGraph([node('a.md', 1), node('b.md', 1)], [['a.md', 'b.md']])

    const [minX, minY, width, height] = layout.viewBox.split(' ').map(Number)
    // 标签画在节点下方并居中，所以左边与下边必须有富余，否则会被裁掉
    expect(minX).toBeLessThan(0)
    expect(minY).toBeLessThan(0)
    expect(minX + width).toBeGreaterThan(layout.width)
    expect(minY + height).toBeGreaterThan(layout.height)
  })
})
