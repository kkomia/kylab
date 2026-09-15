<script setup lang="ts">
/**
 * 概览 = 驾驶舱（《前端设计规范》§6）。
 *
 * 回答"这个知识库系统现在什么状态、最近在不在动"，而不是"有哪些库"——
 * 库的清单有自己的页面（侧栏「知识库」）。
 *
 * 三条自我约束：
 * 1. **只画有数据支撑的图**：调用量（对话/向量化/检索）走 `/stats/usage`，
 *    检索原先只在日志里、v17 起也落库了；宁可少一块图，也不放一个编出来的数字；
 * 2. **颜色只来自主题 Token**：图表与页面共用一套灰阶 + 语义色，不另立一套"图表配色"；
 * 3. 数字先给**结论**（几个大数），再给**分布**（点状图 / 柱状图 / 趋势）。
 */
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'

import type { ActivityPoint } from '@/api/stats'
import ActivityHeatmap from '@/components/charts/ActivityHeatmap.vue'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageShell from '@/components/ui/PageShell.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { formatBytes, formatCount, formatRelativeTime } from '@/composables/useFormat'
import { DASHBOARD_WINDOW_DAYS, USAGE_WINDOW_DAYS, useStatsStore } from '@/stores/stats'

/**
 * 图表按需加载：`EChart.vue` 把整个 ECharts 拉进来（数百 KB）。
 * 静态 import 会让驾驶舱的**首屏**必须先下完这个包；异步化之后
 * 数字卡片与骨架先画出来，图表包到了再补上——首屏不再等一个图表库。
 */
const EChart = defineAsyncComponent(() => import('@/components/charts/EChart.vue'))

/**
 * 观察窗口天数：90 天（约 14 周）。
 *
 * 这个数是跟热力图的**格子边长一起定**的，因为两者互相约束：
 * 格子要近似正方形、又要在约 1100px 的面板里排满，那么
 * `列数 × 格子边长 ≈ 面板宽度`。三种取法的实测：
 *
 * | 窗口 | 列数 | 每列可用 | 结果 |
 * |------|------|----------|------|
 * | 120 天 | 18 | 63px | 只占 1/3 宽度，右边空一大片 |
 * | 365 天 | 52 | 22px | 能排满，但空数据太多、失去"节奏"的可读性 |
 * | **90 天** | **14** | **~78px** | 格子取上限后约占 6 成宽度，留白可接受 |
 *
 * 再短就不像"日历"了。窗口大小与统计口径无关，只是视觉选择。
 */
/**
 * 观察窗口天数：365 天（约 52 周）。
 *
 * 这个数是**扫参数量出来的**，不是拍的。约束有两条，互相拉扯：
 * 格子要近似正方形（且边长落在 10–14px 这个"密排小方块"的手感区间），
 * 同时图形要占住面板宽度的一大半（否则缩在左上角像没加载完）。
 * 实测（面板宽约 1100px，脚本见 `.shots/heatmap-sweep.cjs`）：
 *
 * | 窗口 | 列数 | 格子 | 图形宽 | 占面板 |
 * |------|------|------|--------|--------|
 * | 90 天 | 17 | 12px | 198px | **18%**（缩在角落） |
 * | 180 天 | 32 | 12px | 380px | 34% |
 * | **365 天** | **62** | **12px** | **744px** | **67%**（选定） |
 *
 * 一年也是这类图（GitHub 贡献图、Kimi 亲密度）的惯例刻度，顺便让"长期节奏"可读。
 */
const WINDOW_DAYS = DASHBOARD_WINDOW_DAYS
/** 格子边长上限：12px 与参考图同档；宽度不够时按列数自动缩小。 */
const MAX_CELL = 14

const stats = useStatsStore()
const data = computed(() => stats.dashboard)
const error = computed(() => stats.error)
/** 模型用量（G7）。与驾驶舱并行取：它是另一张表，取不到只是这一块空着。 */
const usage = computed(() => stats.usage)
const usageDays = USAGE_WINDOW_DAYS
/** 用量还没回来：数字显示占位符。**不能显示 0**——0 的含义是"确实没有调用"。 */
const usagePending = computed(() => usage.value === null && stats.loading)

/** 按用途画个相对的条形——一眼看出"钱花在哪一类调用上"。 */
function barWidth(calls: number): number {
  const top = Math.max(...(usage.value?.by_kind ?? []).map((item) => item.calls), 1)
  return Math.max(2, Math.round((calls / top) * 100))
}
/** 趋势图看哪个维度：文档 / 切块 / 任务，三选一。 */
const metric = ref<'documents' | 'chunks' | 'tasks'>('documents')

const METRIC_LABELS: Record<typeof metric.value, string> = {
  documents: '入库文档',
  chunks: '新增切块',
  tasks: '流水线任务',
}

onMounted(() => {
  // 已有缓存时这一次只是后台刷新：内容立刻就在，不闪骨架
  void stats.load()
})

const summary = computed(() => data.value)
const hasAnyDocument = computed(() => (data.value?.total_documents ?? 0) > 0)

/**
 * 顶部大数：每格一个"当前值 + 一句它是什么"。
 *
 * **数据没到也先把六个槽位画出来**（值为占位符、注解用静态说明）：
 * 这是流式渲染的一半——页面的骨架立刻可见，用户不用盯着一块空白等最慢的请求。
 */
const figureSlots = computed(() => {
  const d = data.value
  if (!d) {
    return [
      { label: '知识库', value: '—', note: '相互隔离的检索范围', ready: false },
      { label: '文档', value: '—', note: '正在统计…', ready: false },
      { label: '切块', value: '—', note: '向量化的最小单位', ready: false },
      { label: '原文体积', value: '—', note: '不含向量与索引', ready: false },
      { label: '索引完成率', value: '—', note: '正在统计…', ready: false },
      { label: `近 ${WINDOW_DAYS} 天入库`, value: '—', note: '正在统计…', ready: false },
    ]
  }
  const indexedRate = d.total_documents
    ? Math.round((d.indexed_documents / d.total_documents) * 100)
    : 0
  return [
    {
      label: '知识库',
      value: String(d.total_knowledge_bases),
      note: '相互隔离的检索范围',
      ready: true,
    },
    {
      label: '文档',
      value: String(d.total_documents),
      note: `已索引 ${d.indexed_documents} 篇`,
      ready: true,
    },
    { label: '切块', value: String(d.total_chunks), note: '向量化的最小单位', ready: true },
    { label: '原文体积', value: formatBytes(d.storage_bytes), note: '不含向量与索引', ready: true },
    {
      label: '索引完成率',
      value: `${indexedRate}%`,
      note: d.failed_documents > 0 ? `${d.failed_documents} 篇失败` : '没有失败文档',
      ready: true,
    },
    {
      label: `近 ${WINDOW_DAYS} 天入库`,
      // 注释必须与**主数字同义**：原来这里写的是"13 个任务在跑"——那是另一件事，
      // 读起来像"近 365 天入库 23 / 13 个任务在跑"（§12.116 审阅发现）。
      // 任务在跑的信息属于任务中心（那里有队列深度与槽位），不该蹭这张卡。
      value: String(d.recent_documents),
      note: d.total_documents > 0 ? `占全部 ${d.total_documents} 篇` : '还没有文档',
      ready: true,
    },
  ]
})

/** 按天趋势：观察窗口太长时按周聚合，否则折线全是锯齿。 */
const trendOption = computed(() => {
  const points: ActivityPoint[] = data.value?.activity ?? []
  const bucket = points.length > 60 ? 7 : 1
  const labels: string[] = []
  const values: number[] = []

  for (let index = 0; index < points.length; index += bucket) {
    const slice = points.slice(index, index + bucket)
    labels.push(slice[0].day.slice(5))
    values.push(slice.reduce((sum, point) => sum + point[metric.value], 0))
  }

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
})

/** 文件类型分布：横向条形，类型名放得下且不用旋转标签。 */
const suffixOption = computed(() => {
  const entries = Object.entries(data.value?.by_suffix ?? {})
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
        // 文件类型是"第一组数据"，用副色：主色留给趋势与活跃度，
        // 两张图并排时颜色不同才看得出是两组不同的东西
        itemStyle: { color: 'var(--accent-2)', borderRadius: 3 },
        label: { show: true, position: 'right', color: 'var(--text-secondary)', fontSize: 11 },
      },
    ],
  }
})

/** 阶段分布：让"卡在哪一步"一眼可见，而不是只给一个完成率。 */
const stageOption = computed(() => {
  const labels: Record<string, string> = {
    uploaded: '待处理',
    probing: '探测中',
    parsing: '解析中',
    parsed: '已解析',
    chunking: '切分中',
    chunked: '已切分',
    embedding: '向量化中',
    indexed: '已索引',
    enriching: '增强中',
    enriched: '已增强',
    failed: '失败',
  }
  const entries = Object.entries(data.value?.by_stage ?? {}).filter(([, count]) => count > 0)
  return {
    animationDuration: 300,
    tooltip: { trigger: 'item' },
    xAxis: {
      type: 'category',
      data: entries.map(([stage]) => labels[stage] ?? stage),
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
})
</script>

<template>
  <PageShell title="概览">
    <p v-if="error" class="error-line">{{ error }}</p>

    <!--
      **流式渲染**：页面的骨架（标题、分区标题、卡片框）立刻画出来，数字与图表
      各自到位后填进去，而不是等最慢的那条请求回来再整页一起出现。
      图例：数字未就绪时显示占位符 "—"，图表区显示骨架条。
    -->
    <!-- 一、结论：六个大数 -->
    <ul class="figures">
      <li v-for="item in figureSlots" :key="item.label" class="figure">
        <span class="figure-label">{{ item.label }}</span>
        <span class="figure-value tabular" :class="{ 'figure-pending': !item.ready }">
          {{ item.value }}
        </span>
        <span class="figure-note">{{ item.note }}</span>
      </li>
    </ul>

    <!-- 二、节奏：点状图 + 趋势 -->
    <h2 class="group-title">活跃度</h2>
    <div class="panel card-block">
      <div class="block-head">
        <span class="block-title">近 {{ summary?.window_days ?? WINDOW_DAYS }} 天入库节奏</span>
        <span class="block-hint">颜色越深表示当天入库越多</span>
      </div>
      <ActivityHeatmap v-if="summary" :activity="summary.activity" :max-cell="MAX_CELL" />
      <SkeletonBlock v-else variant="card" :rows="1" />
    </div>

    <div v-if="summary" class="panel card-block">
      <div class="block-head">
        <span class="block-title">趋势</span>
        <div class="metric-switch">
          <button
            v-for="(label, key) in METRIC_LABELS"
            :key="key"
            class="metric-tab"
            :class="{ 'metric-tab-active': metric === key }"
            type="button"
            @click="metric = key as typeof metric"
          >
            {{ label }}
          </button>
        </div>
      </div>
      <EChart :option="trendOption" :height="200" />
    </div>

    <!-- 三、构成 -->
    <template v-if="summary">
      <h2 class="group-title">构成</h2>
      <div class="chart-grid">
        <div class="panel card-block">
          <div class="block-head">
            <span class="block-title">流水线阶段分布</span>
          </div>
          <EChart :option="stageOption" :height="200" />
        </div>
        <div class="panel card-block">
          <div class="block-head">
            <span class="block-title">文件类型</span>
          </div>
          <EChart :option="suffixOption" :height="200" />
        </div>
      </div>
    </template>

    <!-- 三、模型用量（G7）。**刻意不算钱**：单价随供应商/版本/缓存/折扣不断变，
           内置价目表必然过期，而过期的价钱比不给更糟——用户会照着它做决定 -->
    <h2 class="group-title">模型用量</h2>
    <div class="panel card-block">
      <div class="block-head">
        <span class="block-title">近 {{ usageDays }} 天</span>
        <span class="block-hint"> 向量化接口通常不返回用量，那部分按字符数估算 </span>
      </div>

      <dl class="usage-figures">
        <div class="usage-figure">
          <dt>调用次数</dt>
          <dd class="tabular" :class="{ 'figure-pending': usagePending }">
            {{ usagePending ? '—' : formatCount(usage?.total.calls ?? 0) }}
          </dd>
        </div>
        <div class="usage-figure">
          <dt>输入 token</dt>
          <dd class="tabular" :class="{ 'figure-pending': usagePending }">
            {{ usagePending ? '—' : formatCount(usage?.total.prompt_tokens ?? 0) }}
          </dd>
        </div>
        <div class="usage-figure">
          <dt>输出 token</dt>
          <dd class="tabular" :class="{ 'figure-pending': usagePending }">
            {{ usagePending ? '—' : formatCount(usage?.total.completion_tokens ?? 0) }}
          </dd>
        </div>
        <div class="usage-figure">
          <dt>处理条数</dt>
          <dd class="tabular" :class="{ 'figure-pending': usagePending }">
            {{ usagePending ? '—' : formatCount(usage?.total.items ?? 0) }}
          </dd>
        </div>
      </dl>

      <p v-if="usagePending" class="usage-empty">正在统计…</p>
      <p v-else-if="!usage || usage.total.calls === 0" class="usage-empty">
        还没有用量记录。提问或上传文档之后这里会有数据。
      </p>

      <template v-else>
        <!-- 三态分开说：不区分的话会把"没报"画成"没用"、把"估算"画成"实测" -->
        <p v-if="usage.estimated_tokens > 0" class="usage-note">
          其中约 {{ formatCount(usage.estimated_tokens) }} token 是按字符数估算的（{{
            usage.estimated_calls
          }}
          次向量化调用，接口不返回用量）。这部分只用于看趋势，别拿它精确对账。
        </p>
        <p v-if="usage.unreported_calls > 0" class="usage-note">
          另有 {{ usage.unreported_calls }} 次调用供应商没有返回用量，
          它们只计入「调用次数」与「处理条数」，token 数字不含它们。
        </p>

        <ul class="usage-list">
          <li v-for="item in usage.by_kind" :key="item.kind" class="usage-row">
            <span class="usage-name">{{ item.label }}</span>
            <span class="usage-bar">
              <span class="usage-bar-fill" :style="{ width: `${barWidth(item.calls)}%` }" />
            </span>
            <!-- 有 token 的按 token 说，没有的（检索）说条数：把"输入 0 · 输出 0"
                 摆出来只会让人以为统计坏了 -->
            <span class="usage-figures-inline tabular">
              {{ formatCount(item.calls) }} 次<template
                v-if="item.prompt_tokens || item.completion_tokens"
              >
                · 输入 {{ formatCount(item.prompt_tokens) }} · 输出
                {{ formatCount(item.completion_tokens) }}</template
              ><template v-else-if="item.items"> · 共 {{ formatCount(item.items) }} 条</template>
            </span>
          </li>
        </ul>

        <p class="usage-note">
          按模型：{{
            usage.by_model.map((m) => `${m.model}（${formatCount(m.calls)} 次）`).join('、')
          }}
        </p>
      </template>
    </div>

    <!-- 四、各库规模 -->
    <template v-if="summary">
      <h2 class="group-title">知识库规模</h2>
      <EmptyState
        v-if="!hasAnyDocument"
        title="还没有文档"
        hint="到「知识库」页建一个库并上传文档，这里会出现规模与活跃度统计。"
      >
        <RouterLink to="/knowledge-bases">
          <AppButton variant="primary">去知识库</AppButton>
        </RouterLink>
      </EmptyState>

      <div v-else class="panel">
        <div class="panel-head kb-head" aria-hidden="true">
          <span class="col-name">知识库</span>
          <span class="col-num">文档</span>
          <span class="col-num">切块</span>
          <span class="col-time">最近活动</span>
        </div>
        <ul class="kb-rows">
          <li v-for="kb in summary.knowledge_bases" :key="kb.id" class="kb-row panel-row">
            <RouterLink class="kb-link" :to="`/kb/${kb.id}`">
              <span class="col-name">
                <span class="kb-name">{{ kb.name }}</span>
                <span class="kb-model">{{ kb.embedding_model_id }}</span>
              </span>
              <span class="col-num tabular">{{ kb.documents }}</span>
              <span class="col-num tabular">{{ kb.chunks }}</span>
              <span class="col-time">
                <StatusTag v-if="!kb.last_activity" tone="neutral" label="还没有文档" />
                <span v-else class="tabular">{{ formatRelativeTime(kb.last_activity) }}</span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </div>
    </template>
    <!-- 驾驶舱数据还没到：这一块先给骨架，标题已经在上面了 -->
    <SkeletonBlock v-else variant="list" :rows="3" />
  </PageShell>
</template>

<style scoped>
/* 用量四格：与顶部大数区分开——那里是"内容有多少"，这里是"用了多少"，
   所以数字小一号、不加注解，视觉上是二级信息 */
/* 数值未就绪时的占位符：弱化，不让人误以为"统计结果是 0" */
.figure-pending {
  color: var(--text-tertiary);
}

.usage-figures {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0 0 var(--space-4);
}

.usage-figure {
  min-width: 0;
}

.usage-figure dt {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.usage-figure dd {
  margin: var(--space-1) 0 0;
  font-size: var(--text-section-size);
  color: var(--text-primary);
}

.usage-empty,
.usage-note {
  margin: var(--space-2) 0 0;
  font-size: var(--text-micro-size);
  line-height: 1.7;
  color: var(--text-tertiary);
}

.usage-list {
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
}

.usage-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
}

.usage-row + .usage-row {
  border-top: 1px solid var(--border-hairline);
}

.usage-name {
  flex: 0 0 80px;
  font-size: var(--text-meta-size);
  color: var(--text-primary);
}

/* 相对条形：一眼看出"用量集中在哪一类调用上"。
   宽度是相对最大值算的，所以只有横向比较的意义——这正是它要表达的 */
.usage-bar {
  flex: 0 0 140px;
  height: 6px;
  background: var(--bg-subtle);
  border-radius: 3px;
  overflow: hidden;
}

.usage-bar-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
}

.usage-figures-inline {
  flex: 1;
  min-width: 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.error-line {
  margin: 0 0 var(--space-4);
  color: var(--status-danger);
}

/* 结论区：六个大数。数字用大号单层灰，标签在上、注解在下。
   列数**写死 3 列**而不是 auto-fit：一共 6 个数字，auto-fit 在 1440 视口下算出 5 列，
   第二行只剩「近 365 天入库」孤零零一张，视觉重心直接塌掉（评审也点了这一条）。
   6 = 3×2 是这两个数字唯一能排匀的分解，写成 3 列就不再依赖视口凑巧。 */
.figures {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 窄屏退两列、再退一列；上面写死 3 列，这里必须补回来，否则 800px 宽会硬挤 3 列 */
@media (max-width: 900px) {
  .figures {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .figures {
    grid-template-columns: minmax(0, 1fr);
  }
}

.figure {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-4) var(--space-5);
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.figure-label {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.figure-value {
  font-size: var(--text-page-title-size);
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.015em;
  color: var(--text-primary);
}

.figure-note {
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

.group-title {
  margin: var(--space-8) 0 var(--space-3);
  font-size: var(--text-section-size);
  font-weight: 600;
  letter-spacing: -0.005em;
}

.card-block {
  padding: var(--space-4) var(--space-5) var(--space-2);
}

.card-block + .card-block {
  margin-top: var(--space-3);
}

.chart-grid {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
}

.chart-grid .card-block + .card-block {
  margin-top: 0;
}

.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-2);
}

.block-title {
  font-size: var(--text-body-size);
  font-weight: 500;
  color: var(--text-primary);
}

.block-hint {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 维度切换：三个小标签，选中项给一条底线而不是整块底色——图表上方越安静越好 */
.metric-switch {
  display: flex;
  gap: var(--space-1);
}

.metric-tab {
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
}

.metric-tab:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.metric-tab-active {
  color: var(--accent-text);
  background: var(--accent-soft);
}

/* 各库规模：与其它清单共用 .panel / .panel-head / .panel-row */
.kb-head,
.kb-link {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.kb-head {
  padding: 0 var(--space-4);
}

.kb-rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.kb-link {
  padding: var(--space-3) var(--space-4);
  color: inherit;
  text-decoration: none;
  border-radius: var(--radius-row);
}

.kb-link:hover {
  text-decoration: none;
}

.col-name {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
}

.kb-name {
  overflow: hidden;
  font-size: var(--text-body-size);
  font-weight: 500;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-model {
  overflow: hidden;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-num {
  flex: 0 0 72px;
  text-align: right;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.col-time {
  flex: 0 0 120px;
  text-align: right;
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}
</style>
