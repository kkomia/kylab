<script setup lang="ts">
/**
 * 活跃度点状图（GitHub 贡献图 / Kimi 亲密度那种）。
 *
 * 三个刻意的做法：
 *
 * 1. **每一格是正方形**：用热力图 + 透明的格间边框实现，而不是靠圆角小圆点。
 *    方块之间留一道细缝、整体接近密排，才能读成"一片节奏"而不是"一堆散点"；
 *    上一轮格子太大且圆角过头（borderRadius 3 + borderWidth 2），看着像一排药丸。
 * 2. **空值也有底色**：没有活动的日子画淡灰方块（`--bg-active`），
 *    这样整块图形是连续的，数据缺口和"零活动"能分开。
 * 3. **月份刻度放底部**：x 轴按周分列，月份标签只在每月第一周出现——
 *    放在顶部会和色块挤在一起（上一轮就是这么糊的）。
 */
import { computed, defineAsyncComponent } from 'vue'

import type { ActivityPoint } from '@/api/stats'

/**
 * 图表基座**异步**引入：ECharts 是几百 KB 的重依赖，而这张热力图是驾驶舱里
 * 最下面的一块。静态 import 会把它拽进驾驶舱的静态依赖图，让"按需加载图表"
 * 在别处做的拆分全部失效（实测：拆了 DashboardView 的 EChart，
 * 包体还是 595KB，因为这里又静态引了一次）。
 */
const EChart = defineAsyncComponent(() => import('@/components/charts/EChart.vue'))

const props = withDefaults(defineProps<{ activity: ActivityPoint[]; maxCell?: number }>(), {
  maxCell: 20,
})

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

const hasData = computed(() => props.activity.some((point) => point.documents > 0))

/** 周列数：第一天的星期几决定它落在纵轴第几格，所以列数要把它算进去。 */
const weekCount = computed(() => {
  const points = props.activity
  if (points.length === 0) return 0
  const first = new Date(points[0].day)
  const leadingBlanks = (first.getDay() + 6) % 7
  return Math.ceil((points.length + leadingBlanks) / 7)
})

const option = computed(() => {
  const points = props.activity

  // 第一天的星期几决定它在纵轴上的位置：让每一列恰好是一周
  const first = points[0] ? new Date(points[0].day) : new Date()
  const leadingBlanks = (first.getDay() + 6) % 7

  const data: [number, number, number][] = []
  points.forEach((point, index) => {
    const slot = index + leadingBlanks
    data.push([Math.floor(slot / 7), slot % 7, point.documents])
  })

  const weeks = Math.ceil((points.length + leadingBlanks) / 7)

  // 月份刻度：标签打在"当月第一周"这一列上，一列只有一个标签（ECharts 的轴标签
  // 每列至多绘制一个）。所以同一周里跨月时，后一个月**必然**丢标签——
  // 这是"月首落在周中"的固有现象，不是 bug；一年 12 个月里有 2–3 个月会因重叠而省略。
  const labelByWeek = new Map<number, string>()
  points.forEach((point, index) => {
    const day = new Date(point.day)
    if (day.getDate() > 7) return // 只标注"这个月开头那一周"
    const week = Math.floor((index + leadingBlanks) / 7)
    if (!labelByWeek.has(week)) labelByWeek.set(week, `${day.getMonth() + 1} 月`)
  })

  return {
    animationDuration: 300,
    // 只留左侧星期标签的位置；绘图区宽度由 squareCells 反推锁死
    grid: { left: 28 },
    tooltip: {
      formatter: (params: { value: [number, number, number] }) => {
        const index = params.value[0] * 7 - leadingBlanks + params.value[1]
        const point = points[index]
        if (!point) return ''
        return `${point.day}<br/>入库文档 ${point.documents} 篇`
      },
    },
    xAxis: {
      type: 'category',
      data: Array.from({ length: weeks }, (_, index) => String(index)),
      axisLabel: {
        show: true,
        // 只显示月份刻度，其余留空
        formatter: (value: string) => labelByWeek.get(Number(value)) ?? '',
        fontSize: 11,
        margin: 10,
      },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'category',
      data: WEEKDAY_LABELS,
      splitLine: { show: false },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { fontSize: 10 },
    },
    visualMap: {
      show: false,
      type: 'piecewise',
      // 离散分档而不是连续渐变：实例数据里 1 篇和 2 篇必须**看得出区别**，
      // 连续映射会把它们压成同一个色。四档对应"零 / 少 / 中 / 多"。
      pieces: [
        { min: 3, color: 'var(--heat-3)' },
        { min: 2, max: 2, color: 'var(--heat-2)' },
        { min: 1, max: 1, color: 'var(--heat-1)' },
        { value: 0, color: 'var(--heat-0)' },
      ],
      outOfRange: { color: 'var(--heat-0)' },
    },
    series: [
      {
        type: 'heatmap',
        data,
        // 缝隙由 EChart 统一用底色画（见那边注释：透明边框挡不住相邻格子）
        itemStyle: { borderRadius: 3 },
        emphasis: { itemStyle: { borderColor: 'var(--text-secondary)' } },
      },
    ],
  }
})
</script>

<template>
  <div>
    <EChart
      v-if="hasData"
      :option="option"
      :square-cells="{ columns: weekCount, rows: 7, maxSize: maxCell, minSize: 9, gap: 3 }"
    />
    <p v-else class="empty-note">窗口内还没有入库记录——上传文档后这里会出现活跃度分布。</p>
  </div>
</template>

<style scoped>
.empty-note {
  margin: 0;
  padding: var(--space-8) 0;
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}
</style>
