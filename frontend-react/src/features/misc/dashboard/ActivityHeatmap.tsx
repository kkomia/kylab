/**
 * 活跃度点状图（GitHub 贡献图那种）——与旧前端 `components/charts/ActivityHeatmap.vue` 对应。
 *
 * 三个刻意的做法：
 * 1. **每一格是正方形**：用热力图 + 底色的格间边框实现，而不是靠圆角小圆点。
 *    方块之间留一道细缝、整体接近密排，才能读成"一片节奏"而不是"一堆散点"；
 * 2. **空值也有底色**：没有活动的日子画淡灰方块（`--heat-0`），
 *    这样整块图形是连续的，数据缺口和"零活动"能分开；
 * 3. **月份刻度放底部**：x 轴按周分列，月份标签只在每月第一周出现——
 *    放在顶部会和色块挤在一起。
 *
 * **ECharts 在这个文件里也是异步加载的**（`lazy`）：热力图是驾驶舱最下面的一块，
 * 静态引 EChart 会把几百 KB 拽进驾驶舱的静态依赖图，让别处的按需拆分全部失效。
 */
import { lazy, Suspense, useMemo } from 'react'

import type { ActivityPoint } from '@/api/stats'

import { SkeletonBlock } from '../shared/composites'

const EChart = lazy(() => import('./EChart').then((module) => ({ default: module.EChart })))

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

/** 第一天的星期几决定它落在纵轴第几格，所以列数要把它算进去。 */
export function leadingBlanksOf(activity: ActivityPoint[]): number {
  if (activity.length === 0) return 0
  const first = new Date(activity[0].day)
  return (first.getDay() + 6) % 7
}

export function weekCountOf(activity: ActivityPoint[]): number {
  if (activity.length === 0) return 0
  return Math.ceil((activity.length + leadingBlanksOf(activity)) / 7)
}

export function ActivityHeatmap({
  activity,
  maxCell = 20,
}: {
  activity: ActivityPoint[]
  maxCell?: number
}) {
  const hasData = activity.some((point) => point.documents > 0)
  const weekCount = weekCountOf(activity)

  const option = useMemo(() => {
    // 第一天的星期几决定它在纵轴上的位置：让每一列恰好是一周
    const leadingBlanks = leadingBlanksOf(activity)
    const data: [number, number, number][] = []
    activity.forEach((point, index) => {
      const slot = index + leadingBlanks
      data.push([Math.floor(slot / 7), slot % 7, point.documents])
    })
    const weeks = Math.ceil((activity.length + leadingBlanks) / 7)

    // 月份刻度：标签打在"当月第一周"这一列上，一列只有一个标签。所以同一周里跨月时，
    // 后一个月**必然**丢标签——这是"月首落在周中"的固有现象，不是 bug
    const labelByWeek = new Map<number, string>()
    activity.forEach((point, index) => {
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
          const point = activity[index]
          if (!point) return ''
          return `${point.day}<br/>入库文档 ${point.documents} 篇`
        },
      },
      xAxis: {
        type: 'category',
        data: Array.from({ length: weeks }, (_, index) => String(index)),
        axisLabel: {
          show: true,
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
        // 离散分档而不是连续渐变：1 篇和 2 篇必须**看得出区别**。
        // 四档对应"零 / 少 / 中 / 多"
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
          // 缝隙由 EChart 统一用底色画（透明边框挡不住相邻格子）
          itemStyle: { borderRadius: 3 },
          emphasis: { itemStyle: { borderColor: 'var(--text-secondary)' } },
        },
      ],
    }
  }, [activity])

  if (!hasData) {
    return <p className="m-empty-note">窗口内还没有入库记录。上传文档后这里会显示活跃度。</p>
  }

  return (
    <Suspense fallback={<SkeletonBlock variant="list" rows={3} />}>
      <EChart
        option={option}
        squareCells={{ columns: weekCount, rows: 7, maxSize: maxCell, minSize: 9, gap: 3 }}
      />
    </Suspense>
  )
}
