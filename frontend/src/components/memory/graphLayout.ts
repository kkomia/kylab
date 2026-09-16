/**
 * 记忆图谱的布局（纯函数，v0.14 三期）。
 *
 * **确定性、没有物理引擎**：不引第三方图库、不做力导向迭代。三条理由：
 *
 * 1. 力导向每次跑出来都不一样——同一份记忆刷新两次是两个形状，用户记不住，
 *    也没法用它比对"我改完之后结构变了没有"；
 * 2. 这张图的规模是几十个节点（工作区里的 .md），不是几万个，不需要退化布局；
 * 3. 可测：给定一份输入就一定能算出同一组坐标，"连线对不对、枢纽在不在中间"
 *    能写成断言——力导向图库最难测的正是这个。
 *
 * 算法：按无向连通分量切开，每个分量从**度数最大的节点**（枢纽）出发做 BFS 分层；
 * 第 0 层放中心，第 n 层放第 n 个环上，同层均匀铺开。分量按格子横向排开、各自
 * 垂直居中，互不重叠。
 *
 * **坐标空间就是像素空间**（1:1）。这一点是踩过的坑：先前把坐标直接塞进
 * `viewBox` 而 SVG 又被 `width: 100%` 撑满，于是浏览器按 viewBox 把整张图**放大**
 * 了好几倍——节点和文字一起变成巨型，标签被裁掉半边。修法是让 SVG 用固有尺寸
 * （只在放不下时按比例缩小），而尺寸由这里算出来。
 */

import type { MemoryGraphNode } from '@/api/memory'

/** 节点半径：底 7px，每个链接加 1.8px，最多加到 6 个链接（度 6 与度 40 一样大）。 */
const RADIUS_MIN = 7
const RADIUS_STEP = 1.8
const RADIUS_MAX_STEPS = 6

/** 相邻两层之间的环间距（**最小**值）。留给"线上有标签"的空间，太挤会糊成一片。 */
const RING_GAP = 92

/** 分量之间的横向间隔。 */
const CELL_GAP = 56

/** 四周留白：节点标签画在节点下方、居中，所以左右都要留出文字的位置。 */
const LABEL_PAD = 90

/**
 * 已知画布宽度时，最多把间距放大到几倍。
 *
 * 为什么要有上限、而且只有 1.6：放大间距是为了让中等规模的图用上空间，
 * 不是把节点摊到两端的角落——五六个节点的图拉满 1300px 之后，两个分量
 * 隔着半个屏幕对望，反而看不出"谁和谁抱团"（实测过 2.2 倍就是这个效果）。
 */
const MAX_SPREAD = 1.6

/**
 * 节点数不超过这个值时**全部标名字**，超过就只标度 ≥ 2 的。
 *
 * 为什么分两档：三五份记忆时，不给名字的圆点等于没信息（用户看不出那是谁）；
 * 几十份时全标就糊成一片，而标签的价值本来就在枢纽上。
 */
const LABEL_ALL_UP_TO = 12
const LABEL_MIN_DEGREE = 2

export interface PlacedNode {
  node: MemoryGraphNode
  x: number
  y: number
  r: number
  labelled: boolean
}

export interface GraphLink {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface GraphLayout {
  placed: PlacedNode[]
  links: GraphLink[]
  /** SVG 的 `viewBox`（已含标签留白），以及内容固有尺寸。 */
  viewBox: string
  width: number
  height: number
}

export interface LayoutOptions {
  /**
   * 画布可用宽度（px）。给了就把间距按比例放大（上限 `MAX_SPREAD` 倍），
   * 让中等规模的图用上空间；不给则用最小间距，结果只取决于输入。
   *
   * **只放大间距、不放大字号与半径**：字号跟着放大就会变成"这一页字突然很大"，
   * 与整个界面的字号阶脱节。
   */
  width?: number
}

const EMPTY: GraphLayout = { placed: [], links: [], viewBox: '0 0 1 1', width: 0, height: 0 }

/**
 * 算出整张图。
 *
 * **只画连上边的节点**：后端本来就不返回孤立节点（`graph_of` 只发度 > 0 的），
 * 但这一层也自己保证——图要回答的是"结构"，一堆散点会把它淹掉。
 */
export function layoutGraph(
  nodes: MemoryGraphNode[],
  edges: [string, string][],
  options: LayoutOptions = {},
): GraphLayout {
  const visible = nodes.filter((node) => node.degree > 0)
  if (!visible.length) return EMPTY

  const index = new Map(visible.map((node) => [node.path, node]))
  const adjacency = new Map<string, string[]>()
  for (const node of visible) adjacency.set(node.path, [])
  for (const [from, to] of edges) {
    // 两端都可能指向图外的节点，挡一下更稳
    if (!index.has(from) || !index.has(to)) continue
    adjacency.get(from)?.push(to)
    adjacency.get(to)?.push(from)
  }

  const labelAll = visible.length <= LABEL_ALL_UP_TO
  const components = splitComponents(visible, adjacency).map((group) => bfsLayers(group, adjacency))
  const ringGap = RING_GAP * spreadOf(components, options.width)
  // 每个分量的"半径"由它自己的层数决定；所有分量按最高那个对齐高度，
  // 各自垂直居中——否则两个分量会一个贴顶一个居中，看着像没排过版。
  const extents = components.map((layers) => Math.max(ringGap * (layers.length - 1), ringGap * 0.6))
  const rowHeight = Math.max(...extents) * 2
  const totalWidth =
    extents.reduce((sum, extent) => sum + extent * 2, 0) + CELL_GAP * (extents.length - 1)

  const placed: PlacedNode[] = []
  let cursorX = 0
  components.forEach((layers, componentAt) => {
    const extent = extents[componentAt]
    layers.forEach((layer, ring) => {
      const radius = ring * ringGap
      layer.forEach((path, position) => {
        const node = index.get(path)
        if (!node) return
        // 同层均匀铺开；每层加一个偏移，免得外圈的第一个点永远压在内圈的同一个
        // 角度上（那样会连成一条假直线）
        const angle =
          (position / Math.max(layer.length, 1)) * Math.PI * 2 + (ring % 2) * (Math.PI / 6)
        placed.push({
          node,
          x: cursorX + extent + radius * Math.cos(angle),
          // 分量在自己的格子里垂直居中
          y: rowHeight / 2 + radius * Math.sin(angle),
          r: RADIUS_MIN + Math.min(node.degree, RADIUS_MAX_STEPS) * RADIUS_STEP,
          labelled: labelAll || node.degree >= LABEL_MIN_DEGREE,
        })
      })
    })
    cursorX += extent * 2 + CELL_GAP
  })

  const positions = new Map(placed.map((item) => [item.node.path, item]))
  const links: GraphLink[] = []
  for (const [from, to] of edges) {
    const a = positions.get(from)
    const b = positions.get(to)
    if (!a || !b) continue
    links.push({ key: `${from}\u0000${to}`, x1: a.x, y1: a.y, x2: b.x, y2: b.y })
  }

  return {
    placed,
    links,
    viewBox: `${-LABEL_PAD} ${-LABEL_PAD} ${totalWidth + LABEL_PAD * 2} ${rowHeight + LABEL_PAD * 2}`,
    width: totalWidth,
    height: rowHeight,
  }
}

/** 间距放大倍数：够用就好，不追求填满（见 `MAX_SPREAD`）。 */
function spreadOf(components: string[][][], width?: number): number {
  if (!width || components.length === 0) return 1
  const natural =
    components.reduce(
      (sum, layers) => sum + Math.max(RING_GAP * (layers.length - 1), RING_GAP * 0.6) * 2,
      0,
    ) +
    CELL_GAP * (components.length - 1)
  if (natural <= 0 || width <= natural) return 1
  // 留出标签留白：放大的只是间距，留白不跟着放大，所以按"减去留白后的可用宽度"算
  return Math.min(Math.max(1, (width - LABEL_PAD * 2) / natural), MAX_SPREAD)
}

/** 无向连通分量。**按大小降序**：最大的那份排在最前面，用户先看到主体。 */
function splitComponents(nodes: MemoryGraphNode[], adjacency: Map<string, string[]>): string[][] {
  const seen = new Set<string>()
  const components: string[][] = []
  for (const node of nodes) {
    if (seen.has(node.path)) continue
    const queue = [node.path]
    const group: string[] = []
    seen.add(node.path)
    while (queue.length) {
      const current = queue.shift() as string
      group.push(current)
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    components.push(group)
  }
  return components.sort((a, b) => b.length - a.length)
}

/**
 * 从度数最大的节点出发做 BFS 分层。
 *
 * 出发点选**枢纽**而不是随便一个：中心放枢纽，图读起来就是"这几份记忆围着一条
 * 核心结论"。同分的节点按路径排——`sort` 在等值时不稳定，不比这一下就不可复现。
 */
function bfsLayers(component: string[], adjacency: Map<string, string[]>): string[][] {
  const degree = (path: string) => (adjacency.get(path) ?? []).length
  // 分量内的顺序也要定死（splitComponents 的顺序取决于输入顺序，那没问题，
  // 但同分枢纽的选择必须与输入顺序无关）
  const sorted = [...component].sort((a, b) => a.localeCompare(b))
  const root = sorted.reduce((best, path) => (degree(path) > degree(best) ? path : best), sorted[0])

  const layers: string[][] = []
  const seen = new Set<string>([root])
  let frontier = [root]
  while (frontier.length) {
    layers.push([...frontier].sort((a, b) => a.localeCompare(b)))
    const next: string[] = []
    for (const path of frontier) {
      for (const neighbour of adjacency.get(path) ?? []) {
        if (seen.has(neighbour)) continue
        seen.add(neighbour)
        next.push(neighbour)
      }
    }
    frontier = next
  }
  return layers
}
