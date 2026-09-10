<script setup lang="ts">
/**
 * 图表基座（ECharts 封装）。
 *
 * 五件事统一在这里处理，否则每个图表各写一遍就会不一致：
 *
 * 1. **颜色只从主题 Token 取**：绝不写死色值——深浅主题切换时图表要跟着变，
 *    而且规范 §4.3 本来就禁止硬编码颜色；
 * 2. **主题切换要重建**：CSS 变量的值在渲染时读取，切主题后必须重新取一次；
 * 3. **容器尺寸变化要重算**：侧栏是动态宽度（clamp(248px, 18vw, 320px)），
 *    窗口一改列宽图表就变形，所以用 ResizeObserver 而不是监听 window resize；
 * 4. **按需引入**：只注册真正用到的图表与组件，别把整包 ECharts 打进首屏；
 * 5. **正方形单元**（`squareCells`）：热力图默认会把格子双向拉伸填满绘图区，
 *    18 周 × 7 天这种比例会变成一排长方形（实测 60×16px）。给了 `cellSize` 之后
 *    ECharts 不再拉伸，再由"列数 × 边长"反推绘图区宽度与整体高度，格子必然是方的。
 */
import { BarChart, HeatmapChart, LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { useTheme } from '@/composables/useTheme'

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

const props = withDefaults(
  defineProps<{
    option: echarts.EChartsCoreOption
    height?: number
    squareCells?: SquareCells
  }>(),
  { height: 240, squareCells: undefined },
)

const host = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null
let observer: ResizeObserver | null = null
const { theme } = useTheme()

/** 容器当前可用的绘图宽度（px）。 */
function measure(): number {
  return host.value?.clientWidth ?? 0
}

/** 按容器宽度选一个能放下全部列、又不超过上限的格子边长。 */
function computeCellSize(): number {
  const cells = props.squareCells
  if (!cells || cells.columns <= 0) return 0
  const available = measure()
  if (available <= 0) return 0
  // 先扣掉格间缝隙，剩下的才是格子本身——否则最后一列会被挤出绘图区
  const forCells = available - (cells.columns - 1) * (cells.gap ?? 0)
  const fitted = Math.floor(forCells / cells.columns)
  return Math.max(cells.minSize ?? 8, Math.min(cells.maxSize ?? 16, fitted))
}

const cellSize = computed(() => (props.squareCells ? computeCellSize() : 0))

/** 高度：普通图表用传入值；正方形单元按"行数 × 边长"算，再加坐标轴与边距。 */
const boxHeight = computed(() => {
  const cells = props.squareCells
  if (!cells || !cellSize.value) return props.height
  return cells.rows * cellSize.value + 46
})

const resolvedOption = computed(() => {
  const base = props.option
  const cells = props.squareCells
  if (!cells || !cellSize.value) return base

  const gap = cells.gap ?? 0
  const series = (base as { series?: Record<string, unknown>[] }).series ?? []
  return {
    ...base,
    series: series.map((item) => ({
      ...item,
      cellSize: cellSize.value,
      // 格间缝隙：**必须用底色画**。用 transparent 或透明边框挡不住相邻格子的填充，
      // 整块热力图会糊成一个实心矩形（踩过，量了像素才看出来）。
      itemStyle: {
        borderWidth: gap,
        borderColor: 'var(--bg-canvas)',
        borderRadius: 3,
        ...((item.itemStyle as Record<string, unknown>) ?? {}),
      },
    })),
    grid: {
      ...((base as { grid?: Record<string, unknown> }).grid ?? {}),
      // 锁死绘图区宽度（不给 right）：宁可右侧留白，也不让格子被拉长
      width: cells.columns * cellSize.value,
      top: 6,
      bottom: 30,
    },
  } as echarts.EChartsCoreOption
})

/**
 * 读取当前主题下的设计 Token。
 *
 * 图表不能另立一套色板：颜色一律引用与页面相同的 CSS 变量，
 * 这样深色模式与将来的调色都只需要改一处。
 */
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

/**
 * 深拷贝，但**保留函数**。
 *
 * 不能用 `structuredClone`：ECharts 的 option 里常有 formatter 之类的回调，
 * 结构化克隆遇到函数会直接抛 `could not be cloned`，图表连同整个 mounted 钩子一起挂掉
 * （踩过：驾驶舱四块图一块都没画出来，控制台只报一句克隆失败）。
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

/** 把 Token 注入 option：调用方只关心数据与图形类型。 */
function applyTheme(option: echarts.EChartsCoreOption): echarts.EChartsCoreOption {
  const t = tokens()
  const merged = cloneWithFunctions(option) as Record<string, unknown> & {
    textStyle?: Record<string, unknown>
    tooltip?: Record<string, unknown>
  }

  merged.textStyle = { fontFamily: t.font, color: t.muted, fontSize: 12 }
  merged.tooltip = {
    backgroundColor: t.surface,
    borderColor: t.hairline,
    borderWidth: 1,
    textStyle: { color: t.text, fontSize: 12, fontFamily: t.font },
    extraCssText: 'border-radius: 8px; box-shadow: 0 4px 12px rgb(0 0 0 / 10%);',
    ...(merged.tooltip ?? {}),
  }
  // 坐标轴统一：网格线只留极淡的一条，轴线不画——图表不该比正文还吵
  const axes = merged as { xAxis?: unknown; yAxis?: unknown }
  for (const key of ['xAxis', 'yAxis'] as const) {
    const raw = axes[key]
    if (!raw) continue
    const list = Array.isArray(raw) ? raw : [raw]
    axes[key] = list.map((axis) => ({
      axisLine: { lineStyle: { color: t.hairline } },
      axisTick: { show: false },
      axisLabel: { color: t.faint, fontSize: 11 },
      splitLine: { lineStyle: { color: t.hairline, type: 'dashed' } },
      ...(axis as Record<string, unknown>),
    }))
  }
  return merged
}

/**
 * 把 option 里残留的 `var(--x)` / `color-mix(...)` 换成实际色值。
 *
 * **canvas 渲染器不认 CSS 变量，也不认 color-mix()**（只有 tooltip 这类 DOM 覆盖层才认），
 * 传进去会被当成无效颜色、那一块直接不画。所以调用方可以照常写主题色表达式，
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

function resolveColor(value: string): string {
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string) => styles.getPropertyValue(name).trim()

  let out = value
  const variable = out.match(/^var\((--[\w-]+)\)$/)
  if (variable) out = read(variable[1]) || out

  const mixed = out.match(
    /^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%\s*,\s*var\((--[\w-]+)\)\s*\)$/,
  )
  if (mixed) {
    out = blend(read(mixed[1]), read(mixed[3]), Number(mixed[2]) / 100)
  }
  return out
}

/** 按比例混合两个十六进制色。 */
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

function render(): void {
  if (!host.value) return
  if (!chart) {
    chart = echarts.init(host.value, undefined, { renderer: 'canvas' })
  }
  chart.setOption(
    resolveColors(applyTheme(resolvedOption.value)) as echarts.EChartsCoreOption,
    true,
  )
}

onMounted(() => {
  render()
  if (host.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      // 容器变宽要按新宽度重算格子边长，否则格子被拉成长方形
      render()
      chart?.resize()
    })
    observer.observe(host.value)
  }
})

watch(() => props.option, render, { deep: true })
// 主题切换要重画：CSS 变量的值在渲染时读取，不重建就还是旧颜色
watch(theme, render)

onBeforeUnmount(() => {
  observer?.disconnect()
  chart?.dispose()
  chart = null
})
</script>

<template>
  <div ref="host" class="chart" :style="{ height: `${boxHeight}px` }" />
</template>

<style scoped>
.chart {
  width: 100%;
}
</style>
