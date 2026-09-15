<script setup lang="ts">
/**
 * 处理明细：共几个环节 / 现在第几个 / 各环节各花了多久（§12.115）。
 *
 * **放在抽屉里而不是独立页面**（调研对照 WeKnora 的做法）："这份文档卡在哪了"
 * 是**看着列表点开看一眼**的动作，看完就回去继续扫列表。抽屉让列表一直可见，
 * 关掉就回到原位。
 *
 * 三块内容，对应三个问题：
 *
 * | 块 | 回答的问题 |
 * |----|-----------|
 * | 顶部一行结论 | 共几步、现在第几步、一共花了多久、是死是活 |
 * | 分段进度条 | 一眼看形状（走到哪、在哪停的） |
 * | 环节清单 | 每一步各花多久、重试过几次、失败的原因是什么 |
 *
 * **不给百分比**：环节耗时不均（解析几分钟、切分几秒），百分比只能编出一个
 * 对不上的数字；"第 3/6 步 + 每步实际耗时"每一项都能和事实对上。
 */
import { computed, onMounted, ref, watch } from 'vue'

import { getDocumentTimeline, type DocumentTimeline } from '@/api/documents'
import MeterBar from '@/components/ui/MeterBar.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import type { StatusTone } from '@/components/ui/StatusTag.vue'
import { formatMillis } from '@/composables/useFormat'
import { usePolling } from '@/composables/usePolling'
import { progressSegments, progressTone } from '@/composables/useProgress'

const props = defineProps<{
  documentId: string
  /** 这个页签是否正被看着。**没被看着就别轮询**——抽屉里还有阅读/切块两个页签。 */
  active: boolean
}>()

/** 与列表同一个节拍：两处数字对得上比"更实时"重要。 */
const POLL_INTERVAL_MS = 2000

const timeline = ref<DocumentTimeline | null>(null)
const error = ref('')
const loading = ref(true)

/** 还有活干：只有这时才需要轮询，静止时停表。 */
const running = computed(() => timeline.value?.status === 'running')

const tone = computed(() => progressTone(progressLike.value))

/** 把时间线映射成进度条吃的形状（同一个 composable，与列表口径一致）。 */
const progressLike = computed(() =>
  timeline.value
    ? {
        status: timeline.value.status,
        step_index: timeline.value.current_index,
        step_total: timeline.value.step_total,
        step_label:
          timeline.value.steps.find((_, index) => index === timeline.value!.current_index - 1)
            ?.label ?? '',
        elapsed_ms: 0,
        total_ms: timeline.value.total_ms,
        retries: 0,
        stalled: timeline.value.stalled,
      }
    : null,
)

const segments = computed(() => progressSegments(progressLike.value, { pulsing: running.value }))

const statusTone: Record<string, StatusTone> = {
  done: 'success',
  running: 'info',
  failed: 'danger',
  canceled: 'neutral',
  pending: 'neutral',
}

/** 状态胶囊的文案。**停滞优先**：它比"进行中"更能解释用户看到的现象。 */
const statusLabel = computed(() => {
  const current = timeline.value
  if (!current) return ''
  if (current.stalled) return '疑似卡住'
  return { done: '已完成', running: '进行中', failed: '失败', canceled: '已取消' }[current.status]
})

const headline = computed(() => {
  const current = timeline.value
  if (!current) return ''
  const head = `共 ${current.step_total} 个环节 · 当前第 ${current.current_index} 个`
  return `${head} · 总耗时 ${formatMillis(current.total_ms)}`
})

/** 失败/取消的原因单独成块：它是这一页唯一需要**读**的东西。 */
const failure = computed(() => {
  const current = timeline.value
  if (!current || (current.status !== 'failed' && current.status !== 'canceled')) return ''
  return current.steps.find((step) => step.error)?.error ?? ''
})

async function load(): Promise<void> {
  try {
    timeline.value = await getDocumentTimeline(props.documentId)
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '处理进度加载失败'
  } finally {
    loading.value = false
  }
}

// 正在跑**而且**这一页签被看着时才轮询（另外两个页签的读者不关心这些数）。
// 节奏 / 隐藏暂停 / 防叠加都由 `usePolling` 统一负责（§12.116）。
const polling = computed(() => props.active && running.value)
usePolling(load, { active: polling, intervalMs: POLL_INTERVAL_MS, immediate: false })

/** 切到这个页签时才第一次加载：另外两个页签的读者不关心这些数。 */
watch(
  () => props.active,
  (value) => {
    if (value) void load()
  },
)

/** 抽屉里换文档（组件被复用）要重新加载，否则会显示上一份的进度。 */
watch(
  () => props.documentId,
  () => {
    timeline.value = null
    loading.value = true
    if (props.active) void load()
  },
)

onMounted(() => {
  // 首屏由这里加载；轮询由 `usePolling` 的 watch 接管（`immediate: false` 是为了
  // 不让它在挂载时又打一次——这个页签第一次打开只需要一次请求）
  if (props.active) void load()
  else loading.value = false
})
</script>

<template>
  <div class="progress-panel">
    <p v-if="error" class="progress-error">{{ error }}</p>
    <SkeletonBlock v-else-if="loading" variant="list" :rows="4" />

    <template v-else-if="timeline">
      <div class="progress-summary">
        <p class="progress-headline">{{ headline }}</p>
        <StatusTag
          :label="statusLabel"
          :tone="running ? 'info' : statusTone[timeline.status]"
          :running="running"
        />
      </div>

      <MeterBar
        :segments="segments"
        :tone="tone"
        :value-label="`${timeline.current_index} / ${timeline.step_total}`"
        aria-label="处理进度"
      />

      <!-- 停滞要说清"该做什么"：只说"卡住"等于把问题丢回给用户 -->
      <p v-if="timeline.stalled" class="progress-stall">
        这一步已经超过一个心跳周期没有进展，而且没有 worker 在为它续约——
        进程可能重启过。它会被自动回收重跑，也可以在列表里对这篇文档点「重新摄入」。
      </p>

      <h3 class="progress-heading">各环节耗时</h3>
      <ol class="step-list">
        <li
          v-for="(step, index) in timeline.steps"
          :key="step.key"
          class="step"
          :class="`step-${step.status}`"
        >
          <span class="step-order tabular">{{ index + 1 }}</span>
          <div class="step-main">
            <span class="step-label">{{ step.label }}</span>
            <!-- 重试要露头：反复重试的文档与卡住的文档处置不同 -->
            <span v-if="step.visits > 1" class="step-retries">进入 {{ step.visits }} 次</span>
          </div>
          <span class="step-duration tabular">
            {{ step.status === 'pending' ? '—' : formatMillis(step.duration_ms) }}
          </span>
          <StatusTag
            v-if="step.status !== 'pending'"
            class="step-status"
            :label="
              {
                done: '已完成',
                running: '进行中',
                failed: '失败',
                canceled: '已取消',
                pending: '未开始',
              }[step.status]
            "
            :tone="statusTone[step.status]"
            :running="step.status === 'running'"
          />
          <span v-else class="step-status step-status-pending">未开始</span>
        </li>
      </ol>

      <template v-if="failure">
        <h3 class="progress-heading">
          {{ timeline.status === 'failed' ? '失败原因' : '取消说明' }}
        </h3>
        <!-- 可选中的原文：用户选它就是想去搜、去贴给别人看 -->
        <pre class="progress-failure">{{ failure }}</pre>
      </template>

      <p class="progress-note">
        耗时按"进入某一步到进入下一步"之间的间隔累加，所以重试与重新摄入的时间都算在里面。
        跑着的那一步显示的是<strong>到此刻为止</strong>，每次刷新都会涨——那是"还在动"的证据。
      </p>
    </template>

    <p v-else class="progress-note">这份文档还没有处理记录。</p>
  </div>
</template>

<style scoped>
.progress-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.progress-error {
  margin: 0;
  font-size: var(--text-meta-size);
  color: var(--status-danger);
}

.progress-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

/* 结论行用正文色：它是这一页的主信息，其余都是支撑它的细节 */
.progress-headline {
  margin: 0;
  font-size: var(--text-meta-size);
  color: var(--text-primary);
}

.progress-stall {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-micro-size);
  line-height: 1.7;
  color: var(--text-secondary);
  background: var(--status-warning-soft);
  border-radius: var(--radius-control);
}

.progress-heading {
  margin: var(--space-2) 0 0;
  font-size: var(--text-micro-size);
  font-weight: 600;
  color: var(--text-secondary);
}

.step-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 每一步一行：序号 + 名字（+ 重试）+ 耗时 + 状态。
   用固定列宽让多行的耗时与状态沿竖轴对齐（§4） */
.step {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 30px;
  border-bottom: 1px solid var(--border-hairline);
}

.step:last-child {
  border-bottom: none;
}

/* 还没走到的环节压暗一档：它们是"以后再说"，不该和已发生的争注意力 */
.step-pending {
  opacity: 0.6;
}

.step-order {
  flex: 0 0 20px;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  text-align: right;
}

.step-main {
  display: flex;
  flex: 1;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.step-label {
  min-width: 0;
  overflow: hidden;
  font-size: var(--text-meta-size);
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step-retries {
  flex: 0 0 auto;
  font-size: var(--text-micro-size);
  color: var(--status-warning);
}

.step-duration {
  flex: 0 0 76px;
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
  text-align: right;
}

.step-status {
  flex: 0 0 84px;
  justify-content: center;
}

.step-status-pending {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  text-align: center;
}

.progress-failure {
  margin: 0;
  padding: var(--space-3);
  max-height: 200px;
  overflow: auto;
  font-size: var(--text-micro-size);
  line-height: 1.7;
  color: var(--text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--bg-subtle);
  border-radius: var(--radius-panel);
}

.progress-note {
  margin: 0;
  font-size: var(--text-micro-size);
  line-height: 1.7;
  color: var(--text-tertiary);
}
</style>
