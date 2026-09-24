/**
 * 记忆图谱（wikilink 关系，v0.14 三期）——与旧前端 `components/memory/MemoryGraph.vue` 对应。
 *
 * 这一层只管**画**：节点怎么摆、分量怎么排全在 `graphLayout.ts` 里算好了
 * （纯函数、确定性、可单测）。
 *
 * **尺寸用固有值**（`width`/`height` 属性 + `max-width: 100%`），不是 `width: 100%`：
 * 后者会让浏览器按 viewBox 把整张图放大到铺满，节点与文字一起变成巨型、标签被裁。
 */
import { useEffect, useRef, useState } from 'react'

import type { MemoryGraph as MemoryGraphData } from '@/api/memory'
import { formatCount } from '@/lib/format'

import { layoutGraph } from './graphLayout'

const LEGEND = [
  { kind: 'core', label: '核心（注入）' },
  { kind: 'daily', label: '每日现场（可召回）' },
  { kind: 'digest', label: '长期知识（可召回）' },
  { kind: 'other', label: '其它' },
]

export function MemoryGraph({
  graph,
  selected,
  onSelect,
}: {
  graph: MemoryGraphData
  selected?: string | null
  onSelect: (path: string) => void
}) {
  const canvas = useRef<HTMLDivElement | null>(null)
  const [available, setAvailable] = useState(0)

  /**
   * 量一下画布有多宽，交给布局去决定间距放大多少。
   *
   * 用 ResizeObserver 而不是读一次 `clientWidth`：侧栏折叠、窗口缩放都会让宽度变，
   * 读一次的话图就停在旧尺寸上了。
   */
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    setAvailable(element.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width > 0) setAvailable(width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const layout = layoutGraph(graph.nodes, graph.edges, { width: available })

  return (
    <div className="m-graph">
      {/* 画布铺满整行（图在里面居中）：灰色底只包住图本身时，一张两三个节点的图
          会在页面上留下一小块"孤岛"，看起来像没画完。 */}
      <div className="m-graph-canvas" ref={canvas}>
        {layout.placed.length > 0 ? (
          <svg
            viewBox={layout.viewBox}
            width={layout.width}
            height={layout.height}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="记忆之间的链接关系图"
          >
            <g>
              {layout.links.map((link) => (
                <line
                  key={link.key}
                  className="m-graph-link"
                  x1={link.x1}
                  y1={link.y1}
                  x2={link.x2}
                  y2={link.y2}
                />
              ))}
            </g>
            <g>
              {layout.placed.map((item) => (
                <g
                  key={item.node.path}
                  className={`m-graph-node m-graph-node-${item.node.kind}${
                    selected === item.node.path ? ' m-graph-node-on' : ''
                  }`}
                  transform={`translate(${item.x} ${item.y})`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(item.node.path)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onSelect(item.node.path)
                  }}
                >
                  <circle r={item.r} />
                  <title>{`${item.node.path}（${formatCount(item.node.degree)} 条链接）`}</title>
                  {item.labelled && (
                    <text y={item.r + 14}>{item.node.title || item.node.path}</text>
                  )}
                </g>
              ))}
            </g>
          </svg>
        ) : (
          <p className="m-empty-hint">
            还没有链接。在记忆正文里写 <code>[[另一份记忆]]</code> 就能连起来。
          </p>
        )}
      </div>

      <div className="m-graph-foot">
        <ul className="m-graph-legend">
          {LEGEND.map((item) => (
            <li key={item.kind}>
              <span className={`m-legend-dot m-legend-dot-${item.kind}`} />
              {item.label}
            </li>
          ))}
        </ul>
        <p className="text-micro">圆越大 = 连的链接越多。点一个节点可跳到那份记忆。</p>
      </div>

      {graph.dangling.length > 0 && (
        <p className="m-graph-dangling">
          有 {formatCount(graph.dangling.length)} 条链接指向不存在的文件：
          {graph.dangling.map((item, at) => (
            <span key={`${item[0]}-${item[1]}-${at}`}>
              <code>{item[0]}</code> → <code>{item[1]}</code>
            </span>
          ))}
        </p>
      )}
    </div>
  )
}
