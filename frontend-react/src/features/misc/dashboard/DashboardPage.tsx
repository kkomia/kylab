/**
 * 概览 = 驾驶舱（《前端设计规范》§6）——与旧前端 `views/DashboardView.vue` 逐条对应。
 *
 * 回答"这个知识库系统现在什么状态、最近在不在动"，而不是"有哪些库"——
 * 库的清单有自己的页面（侧栏「知识库」）。
 *
 * 三条自我约束：
 * 1. **只画有数据支撑的图**：调用量走 `/stats/usage`；宁可少一块图，也不放一个编出来的数字；
 * 2. **颜色只来自主题 Token**：图表与页面共用一套灰阶 + 语义色，不另立一套"图表配色"；
 * 3. 数字先给**结论**（几个大数），再给**分布**（点状图 / 柱状图 / 趋势）。
 *
 * **图表按需加载**：`EChart` 把整个 ECharts 拉进来（数百 KB），所以这里与热力图
 * 都用 `React.lazy`——静态 import 会让驾驶舱首屏必须先下完这个包；异步化之后
 * 数字卡片与骨架先画出来，图表包到了再补上。
 */
import { lazy, Suspense, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'

import type { ActivityPoint } from '@/api/stats'
import { getDashboard, getUsage } from '@/api/stats'
import { formatBytes, formatCount, formatRelativeTime } from '@/lib/format'

import { documentStageView } from '../shared/status'
import { EmptyState, ErrorLine, PageShell, SkeletonBlock, StatusTag } from '../shared/ui'
import { ActivityHeatmap } from './ActivityHeatmap'

const EChart = lazy(() => import('./EChart').then((module) => ({ default: module.EChart })))

export const DASHBOARD_WINDOW_DAYS = 365
export const USAGE_WINDOW_DAYS = 30
/** 格子边长上限：12px 与参考图同档；宽度不够时按列数自动缩小。 */
const MAX_CELL = 14

const METRIC_LABELS = {
  documents: '入库文档',
  chunks: '新增切块',
  tasks: '流水线任务',
} as const

type Metric = keyof typeof METRIC_LABELS

/**
 * 按天趋势的聚合口径（纯函数，导出供用例钉住）。
 *
 * 观察窗口太长时按周聚合，否则折线全是锯齿——365 天一天一个点的话，
 * 一屏里塞 365 个锯齿，读不出"最近是不是更忙了"。
 */
export function checkableTrend(
  points: ActivityPoint[],
  metric: Metric,
): { labels: string[]; values: number[] } {
  const bucket = points.length > 60 ? 7 : 1
  const labels: string[] = []
  const values: number[] = []
  for (let index = 0; index < points.length; index += bucket) {
    const slice = points.slice(index, index + bucket)
    labels.push(slice[0].day.slice(5))
    values.push(slice.reduce((sum, point) => sum + point[metric], 0))
  }
  return { labels, values }
}

export function DashboardPage() {
  const windowDays = DASHBOARD_WINDOW_DAYS
  const usageDays = USAGE_WINDOW_DAYS
  const [metric, setMetric] = useState<Metric>('documents')

  const dashboard = useQuery({
    queryKey: ['stats', 'dashboard', windowDays],
    queryFn: () => getDashboard(windowDays),
  })
  /** 模型用量：与驾驶舱并行取；取不到只是这一块空着。 */
  const usage = useQuery({
    queryKey: ['stats', 'usage', usageDays],
    queryFn: () => getUsage(usageDays),
    retry: false,
  })

  const data = dashboard.data ?? null
  /** 用量还没回来：数字显示占位符。**不能显示 0**——0 的含义是"确实没有调用"。 */
  const usagePending = usage.data === undefined && usage.isLoading
  const summary = data
  const hasAnyDocument = (data?.total_documents ?? 0) > 0

  /**
   * 顶部大数：每格一个"当前值 + 一句它是什么"。
   *
   * **数据没到也先把六个槽位画出来**（值为占位符、注解用静态说明）：
   * 这是流式渲染的一半——页面的骨架立刻可见，用户不用盯着一块空白等最慢的请求。
   */
  const figureSlots = (() => {
    if (!data) {
      return [
        { label: '知识库', value: '—', note: '相互隔离的检索范围', ready: false },
        { label: '文档', value: '—', note: '正在统计…', ready: false },
        { label: '切块', value: '—', note: '向量化的最小单位', ready: false },
        { label: '原文体积', value: '—', note: '不含向量与索引', ready: false },
        { label: '索引完成率', value: '—', note: '正在统计…', ready: false },
        { label: `近 ${windowDays} 天入库`, value: '—', note: '正在统计…', ready: false },
      ]
    }
    const indexedRate = data.total_documents
      ? Math.round((data.indexed_documents / data.total_documents) * 100)
      : 0
    return [
      {
        label: '知识库',
        value: String(data.total_knowledge_bases),
        note: '相互隔离的检索范围',
        ready: true,
      },
      {
        label: '文档',
        value: String(data.total_documents),
        note: `已索引 ${data.indexed_documents} 篇`,
        ready: true,
      },
      { label: '切块', value: String(data.total_chunks), note: '向量化的最小单位', ready: true },
      {
        label: '原文体积',
        value: formatBytes(data.storage_bytes),
        note: '不含向量与索引',
        ready: true,
      },
      {
        label: '索引完成率',
        value: `${indexedRate}%`,
        note: data.failed_documents > 0 ? `${data.failed_documents} 篇失败` : '没有失败文档',
        ready: true,
      },
      {
        label: `近 ${windowDays} 天入库`,
        // 注释必须与**主数字同义**：任务在跑的信息属于任务中心，不该蹭这张卡
        value: String(data.recent_documents),
        note: data.total_documents > 0 ? `占全部 ${data.total_documents} 篇` : '还没有文档',
        ready: true,
      },
    ]
  })()

  /** 按天趋势：观察窗口太长时按周聚合，否则折线全是锯齿。 */
  const trendOption = (() => {
    const points: ActivityPoint[] = data?.activity ?? []
    const { labels, values } = checkableTrend(points, metric)
    return {
      animationDuration: 300,
      grid: { left: 44, right: 12, top: 16, bottom: 24 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: labels, boundaryGap: false },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: values,
          lineStyle: { width: 2, color: 'var(--accent)' },
          areaStyle: { color: 'var(--accent)', opacity: 0.1 },
        },
      ],
    }
  })()

  /** 文件类型分布：横向条形，类型名放得下且不用旋转标签。 */
  const suffixOption = (() => {
    const entries = Object.entries(data?.by_suffix ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
    return {
      animationDuration: 300,
      grid: { left: 76, right: 24, top: 8, bottom: 8 },
      tooltip: { trigger: 'item' },
      xAxis: { type: 'value', minInterval: 1 },
      yAxis: {
        type: 'category',
        data: entries.map(([suffix]) => suffix),
        splitLine: { show: false },
        inverse: true,
      },
      series: [
        {
          type: 'bar',
          data: entries.map(([, count]) => count),
          barWidth: 12,
          // 文件类型是"第一组数据"，用副色：主色留给趋势与活跃度
          itemStyle: { color: 'var(--accent-2)', borderRadius: 3 },
          label: { show: true, position: 'right', color: 'var(--text-secondary)', fontSize: 11 },
        },
      ],
    }
  })()

  /** 阶段分布：让"卡在哪一步"一眼可见，而不是只给一个完成率。 */
  const stageOption = (() => {
    const entries = Object.entries(data?.by_stage ?? {}).filter(([, count]) => count > 0)
    return {
      animationDuration: 300,
      tooltip: { trigger: 'item' },
      xAxis: {
        type: 'category',
        data: entries.map(([stage]) => documentStageView(stage).label),
        axisLabel: { interval: 0, fontSize: 10 },
      },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        {
          type: 'bar',
          data: entries.map(([stage, count]) => ({
            value: count,
            itemStyle: {
              // 阶段分布里"失败"必须是红色；"已索引"用成功色；其余中间态用中性灰，
              // 避免整张图变成一根彩虹柱
              color:
                stage === 'failed'
                  ? 'var(--status-danger)'
                  : stage === 'indexed' || stage === 'enriched'
                    ? 'var(--status-success)'
                    : 'var(--text-tertiary)',
              borderRadius: [3, 3, 0, 0],
            },
          })),
          barMaxWidth: 36,
        },
      ],
    }
  })()

  /** 按用途画个相对的条形——一眼看出"钱花在哪一类调用上"。 */
  const barWidth = (calls: number): number => {
    const top = Math.max(...(usage.data?.by_kind ?? []).map((item) => item.calls), 1)
    return Math.max(2, Math.round((calls / top) * 100))
  }

  return (
    <PageShell title="概览">
      {dashboard.isError && <ErrorLine>{messageOf(dashboard.error)}</ErrorLine>}

      {/* 一、结论：六个大数 */}
      <ul className="m-figures">
        {figureSlots.map((item) => (
          <li key={item.label} className="m-figure">
            <span className="m-figure-label">{item.label}</span>
            <span
              className={
                item.ready ? 'm-figure-value tabular' : 'm-figure-value tabular m-figure-pending'
              }
            >
              {item.value}
            </span>
            <span className="m-figure-note">{item.note}</span>
          </li>
        ))}
      </ul>

      {/* 二、节奏：点状图 + 趋势 */}
      <h2 className="m-group-title">活跃度</h2>
      <div className="panel m-card-block">
        <div className="m-block-head">
          <span className="m-block-title">近 {summary?.window_days ?? windowDays} 天入库节奏</span>
          <span className="m-block-hint">颜色越深表示当天入库越多</span>
        </div>
        {summary ? (
          <ActivityHeatmap activity={summary.activity} maxCell={MAX_CELL} />
        ) : (
          <SkeletonBlock variant="card" rows={1} />
        )}
      </div>

      {summary && (
        <div className="panel m-card-block">
          <div className="m-block-head">
            <span className="m-block-title">趋势</span>
            <div className="m-metric-switch">
              {(Object.keys(METRIC_LABELS) as Metric[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={metric === key ? 'm-metric-tab m-metric-tab-on' : 'm-metric-tab'}
                  onClick={() => setMetric(key)}
                >
                  {METRIC_LABELS[key]}
                </button>
              ))}
            </div>
          </div>
          <Suspense fallback={<SkeletonBlock variant="card" rows={1} />}>
            <EChart option={trendOption} height={200} />
          </Suspense>
        </div>
      )}

      {/* 三、构成 */}
      {summary && (
        <>
          <h2 className="m-group-title">构成</h2>
          <div className="m-chart-grid">
            <div className="panel m-card-block">
              <div className="m-block-head">
                <span className="m-block-title">流水线阶段分布</span>
              </div>
              <Suspense fallback={<SkeletonBlock variant="card" rows={1} />}>
                <EChart option={stageOption} height={200} />
              </Suspense>
            </div>
            <div className="panel m-card-block">
              <div className="m-block-head">
                <span className="m-block-title">文件类型</span>
              </div>
              <Suspense fallback={<SkeletonBlock variant="card" rows={1} />}>
                <EChart option={suffixOption} height={200} />
              </Suspense>
            </div>
          </div>
        </>
      )}

      {/* 三、模型用量。**刻意不算钱**：单价随供应商/版本/缓存/折扣不断变，
          内置价目表必然过期，而过期的价钱比不给更糟——用户会照着它做决定 */}
      <h2 className="m-group-title">模型用量</h2>
      <div className="panel m-card-block">
        <div className="m-block-head">
          <span className="m-block-title">近 {usageDays} 天</span>
          <span className="m-block-hint">向量化接口通常不返回用量，那部分按字符数估算</span>
        </div>

        <dl className="m-usage-figures">
          {[
            { label: '调用次数', value: usage.data?.total.calls },
            { label: '输入 token', value: usage.data?.total.prompt_tokens },
            { label: '输出 token', value: usage.data?.total.completion_tokens },
            { label: '处理条数', value: usage.data?.total.items },
          ].map((item) => (
            <div key={item.label} className="m-usage-figure">
              <dt>{item.label}</dt>
              <dd className={usagePending ? 'tabular m-figure-pending' : 'tabular'}>
                {usagePending ? '—' : formatCount(item.value ?? 0)}
              </dd>
            </div>
          ))}
        </dl>

        {usagePending ? (
          <p className="m-usage-empty">正在统计…</p>
        ) : !usage.data || usage.data.total.calls === 0 ? (
          <p className="m-usage-empty">还没有用量记录。提问或上传文档之后这里会有数据。</p>
        ) : (
          <>
            {/* 三态分开说：不区分的话会把"没报"画成"没用"、把"估算"画成"实测" */}
            {usage.data.estimated_tokens > 0 && (
              <p className="m-usage-note">
                其中约 {formatCount(usage.data.estimated_tokens)} token 是按字符数估算的（
                {usage.data.estimated_calls} 次向量化调用，接口不返回用量）。
                这部分只用于看趋势，别拿它精确对账。
              </p>
            )}
            {usage.data.unreported_calls > 0 && (
              <p className="m-usage-note">
                另有 {usage.data.unreported_calls} 次调用供应商没有返回用量，
                它们只计入「调用次数」与「处理条数」，token 数字不含它们。
              </p>
            )}

            <ul className="m-usage-list">
              {usage.data.by_kind.map((item) => (
                <li key={item.kind} className="m-usage-row">
                  <span className="m-usage-name">{item.label}</span>
                  <span className="m-usage-bar">
                    <span
                      className="m-usage-bar-fill"
                      style={{ width: `${barWidth(item.calls)}%` }}
                    />
                  </span>
                  {/* 有 token 的按 token 说，没有的（检索）说条数：
                      把"输入 0 · 输出 0"摆出来只会让人以为统计坏了 */}
                  <span className="m-usage-figures-inline tabular">
                    {formatCount(item.calls)} 次
                    {item.prompt_tokens || item.completion_tokens
                      ? ` · 输入 ${formatCount(item.prompt_tokens)} · 输出 ${formatCount(item.completion_tokens)}`
                      : item.items
                        ? ` · 共 ${formatCount(item.items)} 条`
                        : ''}
                  </span>
                </li>
              ))}
            </ul>

            <p className="m-usage-note">
              按模型：
              {usage.data.by_model
                .map((model) => `${model.model}（${formatCount(model.calls)} 次）`)
                .join('、')}
            </p>
          </>
        )}
      </div>

      {/* 四、各库规模 */}
      {summary ? (
        <>
          <h2 className="m-group-title">知识库规模</h2>
          {!hasAnyDocument ? (
            <EmptyState
              title="还没有文档"
              hint="到「知识库」页建一个库并上传文档，这里会出现规模与活跃度统计。"
            >
              <Link to="/knowledge-bases">
                <span className="m-btn m-btn-primary">去知识库</span>
              </Link>
            </EmptyState>
          ) : (
            <div className="panel">
              <div className="panel-head m-list-head" aria-hidden="true">
                <span className="m-col-name">知识库</span>
                <span className="m-col-num">文档</span>
                <span className="m-col-num">切块</span>
                <span className="m-col-time">最近活动</span>
              </div>
              <ul className="m-list">
                {summary.knowledge_bases.map((kb) => (
                  <li key={kb.id} className="m-list-item">
                    <Link className="m-kb-link" to={`/kb/${kb.id}`}>
                      <span className="m-col-name">
                        <span className="m-kb-name">{kb.name}</span>
                        <span className="m-kb-model">{kb.embedding_model_id}</span>
                      </span>
                      <span className="m-col-num tabular">{kb.documents}</span>
                      <span className="m-col-num tabular">{kb.chunks}</span>
                      <span className="m-col-time">
                        {kb.last_activity ? (
                          <span className="tabular">{formatRelativeTime(kb.last_activity)}</span>
                        ) : (
                          <StatusTag tone="neutral" label="还没有文档" />
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        // 驾驶舱数据还没到：这一块先给骨架，标题已经在上面了
        <SkeletonBlock variant="list" rows={3} />
      )}
    </PageShell>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '驾驶舱数据加载失败'
}
