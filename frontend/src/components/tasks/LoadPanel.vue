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
import MeterBar from '@/components/ui/MeterBar.vue'
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
</script>

<template>
  <section class="load" :class="{ live }" aria-label="运行负载">
    <header class="load-head">
      <h2 class="load-title">运行负载</h2>
      <span v-if="live" class="load-live">实时刷新中</span>
    </header>

    <div class="load-grid">
      <!-- 系统负载：CPU 与内存放同一格，因为它们是同一个问题的两面（机器够不够用） -->
      <div class="cell">
        <MeterBar
          label="CPU"
          :segments="[{ fill: (hardware?.cpu_percent ?? 0) / 100, tone: cpuTone, pulsing: live }]"
          :tone="cpuTone"
          :value-label="
            hardware
              ? hardware.cpu_percent === null
                ? `${hardware.cpu_count} 核 · 采样中`
                : `${hardware.cpu_percent}% · ${hardware.cpu_count} 核`
              : '—'
          "
          aria-label="CPU 使用率"
        />
        <MeterBar
          label="内存"
          :segments="[{ fill: (hardware?.memory_percent ?? 0) / 100, tone: memoryTone }]"
          :tone="memoryTone"
          :value-label="
            hardware
              ? `${formatBytes(hardware.memory_used_bytes)} / ${formatBytes(hardware.memory_total_bytes)}`
              : '—'
          "
          aria-label="内存使用量"
        />
      </div>

      <!-- 任务并发：槽位与队列深度。这是"文档一直排队"的直接答案 -->
      <div class="cell">
        <MeterBar
          label="并发槽位"
          :segments="[
            {
              fill: queue && queue.slots > 0 ? queue.running / queue.slots : 0,
              tone: slotsTone,
              pulsing: live,
            },
          ]"
          :tone="slotsTone"
          :value-label="queue ? `${queue.running} / ${queue.slots} 在跑` : '—'"
          aria-label="任务并发槽位"
        />
        <p class="cell-note">
          <template v-if="queue">
            排队 <strong class="tabular">{{ queue.pending }}</strong> 条
            <template v-if="pendingKinds.length">
              （{{ pendingKinds.map((item) => `${item.label} ${item.count}`).join('、') }}）
            </template>
            <template v-if="oldestWait"
              >，最久的已等 <strong>{{ oldestWait }}</strong></template
            >
          </template>
          <template v-else>—</template>
        </p>
        <p v-if="oversubscribed" class="cell-hint">
          在跑数超过了上限：多半是有一个刚被中断的任务还没到租约到期时间，
          回收后它会自己回到队列（约一分钟内）。
        </p>
        <p v-else-if="queue && queue.pending > 0 && queue.running >= queue.slots" class="cell-hint">
          槽位已占满，后面的要等前一个跑完。上限由 <code>KYLAB_WORKER_CONCURRENCY</code> 决定。
        </p>
      </div>

      <!-- 进程内存：机器内存正常但它自己在涨，那是另一类问题（漏/缓存） -->
      <div class="cell">
        <p class="cell-label">本进程常驻内存</p>
        <p class="cell-figure tabular">
          {{ hardware ? formatBytes(hardware.process_rss_bytes) : '—' }}
        </p>
        <p class="cell-note">切词与向量化都在这个进程里跑，它涨得比机器内存快就该重启了。</p>
      </div>

      <!-- 云端解析额度：额度用尽**不是报错**，是"解析忽然长时间不动"的原因 -->
      <div class="cell">
        <p class="cell-label">云端解析额度（今日）</p>
        <template v-if="pendingData">
          <p class="cell-note">读取中…</p>
        </template>
        <template v-else-if="quota?.configured">
          <MeterBar
            :segments="[
              {
                fill: quota.daily_quota > 0 ? Math.min(quota.pages_used / quota.daily_quota, 1) : 0,
                tone: quotaTone,
              },
            ]"
            :tone="quotaTone"
            :value-label="`${quota.pages_used} / ${quota.daily_quota} 页`"
            aria-label="云端解析今日页数"
          />
          <p class="cell-note">
            <template v-if="quota.exhausted">
              额度已用尽：云端不再优先处理，解析会明显变慢（<strong>不是失败</strong>）。
            </template>
            <template v-else>今日调用 {{ quota.calls }} 次。</template>
          </p>
        </template>
        <p v-else class="cell-note">未配置云端解析令牌：所有文件都走本地解析，不消耗额度。</p>
      </div>
    </div>

    <p v-if="problems" class="load-problem">{{ problems }}</p>
  </section>
</template>

<style scoped>
.load {
  margin-bottom: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.load-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.load-title {
  margin: 0;
  font-size: var(--text-meta-size);
  font-weight: 600;
  color: var(--text-primary);
}

/* 实时状态用文字而不是一个闪烁的点：这一整格的数每 2 秒就变一次，
   用户需要知道"我看到的是活的" */
.load-live {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 四格自适应：窄屏两列、宽屏四列。用 auto-fit 而不是写死断点——
   四格的内容长度差不多，让浏览器按可用宽度决定就行 */
.load-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--space-3) var(--space-5);
}

.cell {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.cell-label {
  margin: 0;
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

/* 大数字（本进程内存）：用 figure 档，它是这一格唯一的信息 */
.cell-figure {
  margin: 0;
  font-size: var(--text-figure-size);
  color: var(--text-primary);
}

.cell-note {
  margin: 0;
  font-size: var(--text-micro-size);
  line-height: 1.6;
  color: var(--text-tertiary);
}

.cell-note strong {
  font-weight: 600;
  color: var(--text-secondary);
}

.cell-hint {
  margin: 0;
  font-size: var(--text-micro-size);
  line-height: 1.6;
  color: var(--status-warning);
}

.cell-hint code {
  font-size: inherit;
}

.load-problem {
  margin: var(--space-3) 0 0;
  font-size: var(--text-micro-size);
  color: var(--status-danger);
}
</style>
