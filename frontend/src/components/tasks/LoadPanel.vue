<script setup lang="ts">
/**
 * 运行负载面板（任务中心顶部，§12.115）。
 *
 * **要回答的是"后台为什么慢"**，而这个问题在任务列表里找不到答案——列表说的是
 * "每个任务怎么了"，慢的原因却常常与任何单个任务无关：是 CPU 满了、并发槽位只有 1 个、
 * 还是云端额度用尽在降级排队。这一格把那些数摊开。
 *
 * 四格的分工（每一格都对应一种**可操作**的结论）：
 *
 * | 格 | 什么时候该看它 | 看完了做什么 |
 * |----|----------------|--------------|
 * | 系统负载 | 摄入变慢、机器发烫 | 降并发、别同时跑别的重活 |
 * | 任务并发 | 文档一直在"排队中" | 抬 `KYLAB_WORKER_CONCURRENCY` |
 * | 进程内存 | 跑久了越来越慢 | 重启 / 查是不是有东西在漏 |
 * | 云端额度 | 解析忽然长时间不动 | 等次日额度，或改用本地解析路线 |
 *
 * **CPU 可能是"—"**：后端按两次采样之差算，第一次问就是没有差值。这不是缺失，
 * 界面上如实显示"—"而不是画一根 0% 的条（那会被读成"机器很空闲"）。
 */
import { computed } from 'vue'

import type { SystemLoad } from '@/api/tasks'
import InfoTip from '@/components/ui/InfoTip.vue'
import RingGauge from '@/components/ui/RingGauge.vue'
import { taskKindLabel } from '@/components/ui/status'
import { formatBytes, formatDuration } from '@/composables/useFormat'

const props = defineProps<{
  load: SystemLoad | null
  /** 是否在跑（有排队/执行中的任务）。静止时这一格也静止，不制造"一直在动"的错觉。 */
  live?: boolean
}>()

const hardware = computed(() => props.load?.hardware ?? null)
const queue = computed(() => props.load?.queue ?? null)
const quota = computed(() => props.load?.quota ?? null)

/** 首屏还没拿到数据。**照常画出骨架结构**，不整块消失：
 *  面板出现在列表上方，晚一步渲染会把下面的内容整体推下去。 */
const pendingData = computed(() => props.load === null)

/**
 * 占用率的语义色：**只有真的高才变色**。
 *
 * 阈值放在 80%/90% 而不是 50%：摄入是 CPU 密集型任务，跑到 60~70% 完全正常，
 * 一过半就变黄会让人天天看到黄条，然后就再也不看它了。
 */
function loadTone(
  percent: number | null,
  warning = 80,
  danger = 90,
): 'accent' | 'warning' | 'danger' {
  if (percent === null) return 'accent'
  if (percent >= danger) return 'danger'
  if (percent >= warning) return 'warning'
  return 'accent'
}

const cpuTone = computed(() => loadTone(hardware.value?.cpu_percent ?? null))
const memoryTone = computed(() => loadTone(hardware.value?.memory_percent ?? null, 85, 93))

/** 云端额度用尽用 warn 而不是 danger：**它不是故障**，是"变慢"的原因。 */
const quotaTone = computed(() => (quota.value?.exhausted ? 'warning' : 'accent'))

/** 槽位占用：跑满了才提示——这正是"该抬并发"的信号。 */
const slotsTone = computed(() => {
  const current = queue.value
  if (!current || current.slots === 0) return 'accent' as const
  if (current.running >= current.slots && current.pending > 0) return 'warning' as const
  return 'accent' as const
})

/**
 * 在跑数**超过**上限。这不是算错了，而是真会出现的一种瞬时状态：
 * 进程被 kill（或崩了）时它手上的任务还写着 running，而租约要到到期才被回收——
 * 在到期之前，库里确实有"比消费者还多"的运行中任务（实机杀进程重启后看到了 2/1）。
 *
 * 要说明白，否则"上限 1 却有 2 个在跑"读起来像面板算错了；
 * 而它其实是个好消息：**那条任务会在租约到期后自动回到队列**。
 */
const oversubscribed = computed(() => {
  const current = queue.value
  return current !== null && current.slots > 0 && current.running > current.slots
})

/** 排队任务按类型分布，按条数降序——"积压全是出题"这个结论要一眼看得出来。 */
const pendingKinds = computed(() => {
  const entries = Object.entries(queue.value?.pending_by_kind ?? {})
  return entries
    .map(([kind, count]) => ({ kind, count, label: taskKindLabel(kind) }))
    .sort((left, right) => right.count - left.count)
})

const oldestWait = computed(() => {
  const seconds = queue.value?.oldest_pending_seconds
  return seconds === null || seconds === undefined ? null : formatDuration(seconds)
})

/** 有没有需要解释的异常状态（停滞 / 逾期）。没有就把那一行整个省掉。 */
const problems = computed(() => {
  const current = queue.value
  if (!current) return ''
  const parts: string[] = []
  if (current.stalled > 0) parts.push(`${current.stalled} 个任务可能卡住（没有 worker 在续约）`)
  if (current.overdue > 0) parts.push(`${current.overdue} 个任务长时间未被领取`)
  return parts.join('；')
})

/** 槽位格子：一个格子一个并发槽，在跑的几个填实。 */
const slotSquares = computed(() => {
  const current = queue.value
  if (!current || current.slots <= 0) return []
  return Array.from({ length: current.slots }, (_, index) => index < current.running)
})

/**
 * 中心文字用的百分比。**CPU 的 `null` 单独处理**：后端按两次采样之差算，
 * 第一次问就是没有差值。这时环是空的、中心写"—"——不写 0%，
 * 那会被读成"机器很空闲"（后端注释里点过这个坑）。
 */
function percentText(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value)}%`
}

const cpuPercent = computed(() => hardware.value?.cpu_percent ?? null)
const memoryPercent = computed(() => hardware.value?.memory_percent ?? null)
const quotaPercent = computed(() => {
  const current = quota.value
  if (!current?.configured || current.daily_quota <= 0) return null
  return (current.pages_used / current.daily_quota) * 100
})
const quotaRatio = computed(() => {
  const value = quotaPercent.value
  return value === null ? 0 : Math.min(value / 100, 1)
})

/**
 * 本进程常驻内存占机器内存的比例（`"0.4%"`）。
 *
 * **为什么给这个数**：这一格原本配一句"切词与向量化都在这里"，
 * 它与旁边的 ⓘ 说的是同一件事。改成一个真数字之后，这一格回答的问题
 * 从"这个数是什么"变成"它算不算大"——0.4% 一眼就知道不是瓶颈。
 *
 * 与那句被删掉的话不冲突：那句话说错在拿**趋势**（进程涨得快不快）
 * 和**水位**（机器内存剩多少）比大小；这里比的是两个同类的量（占用 / 总量）。
 */
const processShare = computed(() => {
  const current = hardware.value
  if (!current || !current.memory_total_bytes || current.process_rss_bytes === null) return null
  return `${((current.process_rss_bytes / current.memory_total_bytes) * 100).toFixed(1)}%`
})
</script>

<template>
  <section class="load" :class="{ live }" aria-label="运行负载">
    <header class="load-head">
      <h2 class="load-title">运行负载</h2>
      <span v-if="live" class="load-live">实时刷新中</span>
    </header>

    <!--
      **一排仪表，不是一个条阵**（v0.25 第二次重做）。

      走过的两版：先是 2×2 四格，每格一根进度条；再改成三列读数表，还是每格一根条。
      两次都没解决同一件事——**四份形态不同的数据被画成了同一种控件**，
      而且条在这种地方本来就不合适：

      一根 400px 的条填 1.7% 只有 7px，和"没有数据"长得一模一样；
      而这里的读数恰恰经常是极小的值（CPU 常年个位数、额度常常 0%）。
      环形是一个**占位固定**的封闭图形，缺的那一块在哪儿一眼就看得到，
      中心还能直接把百分比写出来。

      于是四种形态各归各位：

      | 读数 | 形态 | 画法 |
      | --- | --- | --- |
      | CPU / 内存 / 云端额度 | **占比**（离满还有多远） | 环，中心写百分比 |
      | 并发槽位 | **离散个数**（1 个槽就是 1 个槽） | 一个槽一个方块，在跑的填实 |
      | 本进程常驻内存 | **单值**，没有分母 | 就写一个数，不画图 |

      槽位那一格最说明问题：上限 1 个时，进度条永远只有"空"和"满"两种样子，
      0% 的条读起来像"没数据"；换成一个小方块，"一个槽，闲着"一眼就明白。
      本进程内存不画图的理由不同：**它涨不涨要看时间序列，而这里只有瞬时值**，
      画一根没有对照的条等于假装它有个"满"。
    -->
    <div class="gauges">
      <div class="gauge">
        <span class="gauge-glyph">
          <RingGauge
            :ratio="(cpuPercent ?? 0) / 100"
            :label="percentText(cpuPercent)"
            :tone="cpuTone"
            aria-label="CPU 使用率"
          />
        </span>
        <span class="gauge-name">CPU</span>
        <span class="gauge-detail tabular">
          <template v-if="hardware">
            {{ hardware.cpu_count }} 核<template v-if="cpuPercent === null"> · 采样中</template>
          </template>
          <template v-else>—</template>
        </span>
      </div>

      <div class="gauge">
        <span class="gauge-glyph">
          <RingGauge
            :ratio="(memoryPercent ?? 0) / 100"
            :label="percentText(memoryPercent)"
            :tone="memoryTone"
            aria-label="内存使用量"
          />
        </span>
        <span class="gauge-name">内存</span>
        <span class="gauge-detail tabular">
          <template v-if="hardware">
            {{ formatBytes(hardware.memory_used_bytes) }} /
            {{ formatBytes(hardware.memory_total_bytes) }}
          </template>
          <template v-else>—</template>
        </span>
      </div>

      <div class="gauge">
        <span class="gauge-glyph">
          <span
            v-if="slotSquares.length"
            class="slots"
            role="img"
            :aria-label="`${queue?.running} / ${queue?.slots} 个并发槽位在使用`"
          >
            <span
              v-for="(busy, index) in slotSquares"
              :key="index"
              class="slot"
              :class="[`slot-${slotsTone}`, { 'slot-busy': busy }]"
            />
          </span>
          <span v-else class="gauge-blank">—</span>
        </span>
        <span class="gauge-name">并发槽位</span>
        <span class="gauge-detail">
          <template v-if="queue">
            <span class="tabular">{{ queue.running }} / {{ queue.slots }} 在跑</span>
            · 排队 <strong class="tabular">{{ queue.pending }}</strong> 条
          </template>
          <template v-else>—</template>
        </span>
      </div>

      <div class="gauge">
        <span class="gauge-glyph">
          <RingGauge
            :ratio="quotaRatio"
            :label="pendingData ? '…' : percentText(quotaPercent)"
            :tone="quotaTone"
            aria-label="云端解析今日页数"
          />
        </span>
        <span class="gauge-name">云端解析额度</span>
        <span class="gauge-detail tabular">
          <template v-if="pendingData">读取中…</template>
          <template v-else-if="quota?.configured">
            {{ quota.pages_used }} / {{ quota.daily_quota }} 页
          </template>
          <template v-else>未配置</template>
        </span>
      </div>

      <div class="gauge">
        <span class="gauge-glyph">
          <span class="gauge-figure tabular">
            {{ hardware ? formatBytes(hardware.process_rss_bytes) : '—' }}
          </span>
        </span>
        <span class="gauge-name">
          本进程常驻内存
          <InfoTip
            text="切词与向量化都在这个进程里跑，所以它随摄入进度变大是正常的。只涨不落时重启服务即可——那是内存没被释放，不是任务出错了。"
          />
        </span>
        <span class="gauge-detail tabular">
          <template v-if="processShare">占机器内存 {{ processShare }}</template>
          <template v-else>—</template>
        </span>
      </div>
    </div>

    <!--
      下面这几行**只在需要解释的时候出现**，而且是这一格里唯一"读完了要做什么"的部分。
      它们不常驻：正常运行时这一格应该只有读数，没有一句要多读一遍的话。

      留哪句、删哪句，尺子是同一个：**它是否改变用户接下来做的事**。
      - 「上限由 `KYLAB_WORKER_CONCURRENCY` 决定」留：这是那把要拧的螺丝，不写就得去翻文档；
      - 「额度已用尽……不是失败」留：不说清楚，"解析忽然变慢"会被当成故障去查；
      - 「切词与向量化都跑在这个进程里，它涨得比机器内存快就该重启」曾经也留在这儿，
        但它把**水位**（机器内存）和**趋势**（进程内存）拿来比大小，本来就不成立，
        读起来像一句说不通的因果——挪进 ⓘ 并改写。
    -->
    <!--
      排队**构成**与最久的等待：只在真有积压时出现。
      它是"积压全是出题"这类结论的唯一出处（见 `pendingKinds` 的注释），
      但平时排队是 0，常驻就是噪音——所以不塞进仪表那一行，而是需要时才铺开。
    -->
    <p v-if="queue && queue.pending > 0 && (pendingKinds.length || oldestWait)" class="load-note">
      <template v-if="pendingKinds.length">
        排队的构成：{{ pendingKinds.map((item) => `${item.label} ${item.count}`).join('、') }}
      </template>
      <template v-if="oldestWait"
        ><template v-if="pendingKinds.length">，</template>最久的已等
        <strong>{{ oldestWait }}</strong></template
      >
    </p>

    <p v-if="oversubscribed" class="load-hint">
      在跑数超过了上限：多半是有一个刚被中断的任务还没到租约到期时间，
      回收后它会自己回到队列（约一分钟内）。
    </p>
    <p v-else-if="queue && queue.pending > 0 && queue.running >= queue.slots" class="load-hint">
      槽位已占满，后面的要等前一个跑完。上限由 <code>KYLAB_WORKER_CONCURRENCY</code> 决定。
    </p>
    <p v-if="quota?.configured && quota.exhausted" class="load-hint">
      额度已用尽：云端不再优先处理，解析会明显变慢（<strong>不是失败</strong>）。
    </p>
    <p v-else-if="!pendingData && quota && !quota.configured" class="load-hint">
      未配置云端解析令牌：所有文件都走本地解析，不消耗额度。
    </p>

    <p v-if="problems" class="load-problem">{{ problems }}</p>
  </section>
</template>

<style scoped>
.load {
  margin-bottom: var(--space-3);
  padding: var(--space-3) var(--space-4) var(--space-4);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.load-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.load-title {
  margin: 0;
  font-size: var(--text-micro-size);
  font-weight: 600;
  color: var(--text-secondary);
}

.load-live {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 五格等宽。**居中对齐**，与上面那版读数表的左对齐相反——
   仪表盘里每个格子是"一个读数"，不是一个字段，居中才成列；
   左对齐会让宽窄不一的细节文字参差不齐，反而更乱。 */
.gauges {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--space-3);
}

.gauge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  text-align: center;
}

/* 仪表那一行高度固定：环是 48px、方块是 16px、大字是 16px，
   三种高度不一样，不锁一行高就会看到下面三行标签上下错开 */
.gauge-glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 48px;
  width: 100%;
}

.gauge-name {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

.gauge-detail {
  min-width: 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.gauge-detail strong {
  font-weight: 600;
  color: var(--text-secondary);
}

/* 没有环的那一格：值当图形用。字号比细节大一档，才撑得起那一行的高度 */
.gauge-figure {
  font-size: var(--text-section-size);
  font-weight: 600;
  color: var(--text-primary);
}

.gauge-blank {
  font-size: var(--text-section-size);
  color: var(--text-quaternary);
}

/* 并发槽位：**一格一个槽**，不是一根条。
   上限 1 时进度条永远只有空与满两种样子，0% 读起来像"没有数据"；
   一个小方块明明白白地说"这里有一个槽，它闲着"。 */
.slots {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  justify-content: center;
  max-width: 100%;
}

/* 24px：与 48px 的环放在同一行里，再小就成了一颗"多余的点"而不是一个仪表。
   槽位多的时候这些方块会自动换行（`flex-wrap`），所以不设上限。 */
.slot {
  width: 24px;
  height: 24px;
  border: 1px solid var(--border-hairline);
  border-radius: 6px;
}

.slot-busy.slot-accent {
  background: var(--accent);
  border-color: transparent;
}

.slot-busy.slot-warning {
  background: var(--status-warning);
  border-color: transparent;
}

.slot-busy.slot-danger {
  background: var(--status-danger);
  border-color: transparent;
}

.load-hint,
.load-problem {
  margin: var(--space-3) 0 0;
  font-size: var(--text-micro-size);
  line-height: var(--line-prose);
}

.load-hint {
  color: var(--status-warning);
}

/* 排队构成那一行：是事实不是告警，所以用三级灰而不是语义色 */
.load-note {
  margin: var(--space-3) 0 0;
  font-size: var(--text-micro-size);
  line-height: var(--line-prose);
  color: var(--text-tertiary);
}

.load-note strong {
  font-weight: 600;
  color: var(--text-secondary);
}

.load-problem {
  color: var(--status-danger);
}
</style>
