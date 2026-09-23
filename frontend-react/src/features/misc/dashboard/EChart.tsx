/**
 * 图表基座（ECharts 封装）——与旧前端 `components/charts/EChart.vue` 逐条对应。
 *
 * **本文件是"重依赖边界"**：它静态 import 整个 echarts（数百 KB）。
 * 调用方**必须**通过 `React.lazy` / 动态 import 引它，否则那一天 ECharts 会被拽进
 * 主 chunk（旧版踩过：拆了驾驶舱的异步组件，包体还是 595KB，因为热力图里又静态引了一次）。
 *
 * 五件事统一在这里处理，否则每个图表各写一遍就会不一致：
 * 1. **颜色只从主题 Token 取**：绝不写死色值——深浅主题切换时图表要跟着变；
 * 2. **主题切换要重建**：CSS 变量的值在渲染时读取，切主题后必须重新取一次；
 * 3. **容器尺寸变化要重算**：用 ResizeObserver 而不是监听 window resize；
 * 4. **按需引入**：只注册真正用到的图表与组件，别把整包 ECharts 打进首屏；
 * 5. **正方形单元**（`squareCells`）：热力图默认会把格子双向拉伸填满绘图区，
 *    18 周 × 7 天这种比例会变成一排长方形。给了 `cellSize` 之后 ECharts 不再拉伸。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart, HeatmapChart, LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'

import { useThemeMode } from '../settings/useTheme'

echarts.use([
  BarChart,
  HeatmapChart,
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
])

/** 正方形单元的参数：列数、行数，以及格子边长的上下限。 */
export interface SquareCells {
  columns: number
  rows: number
  maxSize?: number
  minSize?: number
  /** 格间缝隙（px）。必须用底色画，不能用 transparent——见 ActivityHeatmap 的注释。 */
  gap?: number
}

export type ChartOption = Record<string, unknown>

/**
 * 深拷贝，但**保留函数**。
 *
 * 不能用 `structuredClone`：ECharts 的 option 里常有 formatter 之类的回调，
 * 结构化克隆遇到函数会直接抛 `could not be cloned`（踩过：驾驶舱四块图一块都没画出来）。
 */
function cloneWithFunctions<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneWithFunctions) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cloneWithFunctions(item)
    }
    return out as T
  }
  return value
}

/** 读取当前主题下的设计 Token。图表不能另立一套色板。 */
function tokens() {
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string) => styles.getPropertyValue(name).trim()
  return {
    text: read('--text-primary'),
    muted: read('--text-secondary'),
    faint: read('--text-tertiary'),
    hairline: read('--border-hairline'),
    surface: read('--bg-surface'),
    font: styles.getPropertyValue('font-family').trim(),
  }
}

function blend(from: string, to: string, ratio: number): string {
  const parse = (hex: string): [number, number, number] | null => {
    const match = hex.trim().match(/^#([0-9a-f]{6})$/i)
    if (!match) return null
    const value = parseInt(match[1], 16)
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
  }
  const a = parse(from)
  const b = parse(to)
  if (!a || !b) return from
  const channel = (index: number) =>
    Math.round(a[index] * ratio + b[index] * (1 - ratio))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(0)}${channel(1)}${channel(2)}`
}

function resolveColor(value: string): string {
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string) => styles.getPropertyValue(name).trim()

  let out = value
  const variable = out.match(/^var\((--[\w-]+)\)$/)
  if (variable) out = read(variable[1]) || out

  const mixed = out.match(
    /^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%\s*,\s*var\((--[\w-]+)\)\s*\)$/,
  )
  if (mixed) out = blend(read(mixed[1]), read(mixed[3]), Number(mixed[2]) / 100)
  return out
}

/**
 * 把 option 里残留的 `var(--x)` / `color-mix(...)` 换成实际色值。
 *
 * **canvas 渲染器不认 CSS 变量，也不认 color-mix()**（只有 tooltip 这类 DOM 覆盖层才认），
 * 传进去会被当成无效颜色、那一块直接不画。所以调用方照常写主题色表达式，
 * 由这里统一解析——这样图表里的颜色仍然只有"主题 Token"这一个来源。
 */
function resolveColors(value: unknown): unknown {
  if (typeof value === 'string') {
    return /^(var\(|color-mix\()/.test(value) ? resolveColor(value) : value
  }
  if (Array.isArray(value)) return value.map(resolveColors)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = resolveColors(item)
    return out
  }
  return value
}

/** 把 Token 注入 option：调用方只关心数据与图形类型。 */
function applyTheme(option: ChartOption): ChartOption {
  const theme = tokens()
  const merged = cloneWithFunctions(option) as ChartOption & {
    tooltip?: Record<string, unknown>
  }
  merged.textStyle = { fontFamily: theme.font, color: theme.muted, fontSize: 12 }
  merged.tooltip = {
    backgroundColor: theme.surface,
    borderColor: theme.hairline,
    borderWidth: 1,
    textStyle: { color: theme.text, fontSize: 12, fontFamily: theme.font },
    extraCssText: 'border-radius: 8px; box-shadow: 0 4px 12px rgb(0 0 0 / 10%);',
    ...(merged.tooltip ?? {}),
  }
  // 坐标轴统一：网格线只留极淡的一条，轴线不画——图表不该比正文还吵
  for (const key of ['xAxis', 'yAxis'] as const) {
    const raw = merged[key]
    if (!raw) continue
    const list = Array.isArray(raw) ? raw : [raw]
    merged[key] = list.map((axis) => ({
      axisLine: { lineStyle: { color: theme.hairline } },
      axisTick: { show: false },
      axisLabel: { color: theme.faint, fontSize: 11 },
      splitLine: { lineStyle: { color: theme.hairline, type: 'dashed' } },
      ...(axis as Record<string, unknown>),
    }))
  }
  return merged
}

export function EChart({
  option,
  height = 240,
  squareCells,
}: {
  option: ChartOption
  height?: number
  squareCells?: SquareCells
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const themeMode = useThemeMode()
  /**
   * 容器当前可用的绘图宽度（px）——**放在 state 里而不是现读**：
   * 格子边长由它算出来，而"宽度变了"必须触发一次重算（见下面的 ResizeObserver）。
   */
  const [available, setAvailable] = useState(0)

  useEffect(() => {
    const element = host.current
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

  /** 按容器宽度选一个能放下全部列、又不超过上限的格子边长。 */
  const cellSize = useMemo(() => {
    if (!squareCells || squareCells.columns <= 0 || available <= 0) return 0
    // 先扣掉格间缝隙，剩下的才是格子本身——否则最后一列会被挤出绘图区
    const forCells = available - (squareCells.columns - 1) * (squareCells.gap ?? 0)
    const fitted = Math.floor(forCells / squareCells.columns)
    return Math.max(squareCells.minSize ?? 8, Math.min(squareCells.maxSize ?? 16, fitted))
  }, [squareCells, available])

  /** 高度：普通图表用传入值；正方形单元按"行数 × 边长"算，再加坐标轴与边距。 */
  const boxHeight = useMemo(() => {
    if (!squareCells || !cellSize) return height
    return squareCells.rows * cellSize + 46
  }, [squareCells, cellSize, height])

  const resolvedOption = useMemo(() => {
    if (!squareCells || !cellSize) return option
    const gap = squareCells.gap ?? 0
    const series = (option.series as Record<string, unknown>[] | undefined) ?? []
    return {
      ...option,
      series: series.map((item) => ({
        ...item,
        cellSize,
        // 格间缝隙：**必须用底色画**。用 transparent 或透明边框挡不住相邻格子的填充，
        // 整块热力图会糊成一个实心矩形（踩过，量了像素才看出来）
        itemStyle: {
          borderWidth: gap,
          borderColor: 'var(--bg-canvas)',
          borderRadius: 3,
          ...((item.itemStyle as Record<string, unknown>) ?? {}),
        },
      })),
      grid: {
        ...((option.grid as Record<string, unknown>) ?? {}),
        // 锁死绘图区宽度（不给 right）：宁可右侧留白，也不让格子被拉长
        width: squareCells.columns * cellSize,
        top: 6,
        bottom: 30,
      },
    }
  }, [option, squareCells, cellSize])

  function render(): void {
    if (!host.current) return
    if (!chart.current)
      chart.current = echarts.init(host.current, undefined, { renderer: 'canvas' })
    chart.current.setOption(resolveColors(applyTheme(resolvedOption)) as never, true)
  }

  // option 变了就重画（`resolvedOption` 已经含了格子尺寸那部分的重算）
  useEffect(() => {
    render()
    chart.current?.resize()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedOption, boxHeight])

  // 主题切换要重画：CSS 变量的值在渲染时读取，不重建就还是旧颜色
  useEffect(() => {
    render()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeMode])

  useEffect(
    () => () => {
      chart.current?.dispose()
      chart.current = null
    },
    [],
  )

  return <div ref={host} className="m-chart" style={{ height: `${boxHeight}px` }} />
}
