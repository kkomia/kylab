<script setup lang="ts">
/**
 * 计量条（负载面板与分段进度共用，《前端设计规范》§6/§7）。
 *
 * **为什么不叫"进度条"**：它的用途有两种，而两种都**不该显示百分比**——
 *
 * 1. **资源占用**（CPU / 内存 / 云端额度）：要的是"离满还有多远"，
 *    条本身表达得比数字快，但数字仍然要给（`value-label`）。
 * 2. **流程进度**（文档入库的分段）：用户明确要的是"第几步"，
 *    百分比会把 8 个阶段折算成一个对不上的小数（见 §12.114 的取舍）。
 *
 * 所以这里的接口是"**若干段 + 当前在哪一段 + 每段自己的状态**"：
 * 单段连续填充是 `segments = 1` 的特例。一个组件两种用法，
 * 免得界面里出现"两种看起来差不多但行为不同"的条。
 *
 * **颜色只是加速**：每一段的语义（已完成/进行中/失败）都有文字或位置表达，
 * 色弱与黑白截图都读得懂（§8）。
 */
import { computed } from 'vue'

export type MeterTone = 'accent' | 'info' | 'success' | 'warning' | 'danger' | 'neutral'

/** 一段：``0`` 空、``1`` 满；``tone`` 覆盖整体色调（失败的那一段单独变红）。 */
export interface MeterSegment {
  /** 该段的完成度 0–1。分段进度里通常是 0 或 1，当前段可以是 0.5 这样的"跑到一半"。 */
  fill: number
  tone?: MeterTone
  /** 悬浮提示，解释这一段是什么（例如"解析内容 · 2 分 14 秒"）。 */
  title?: string
  /** 这一段正在跑：缓慢呼吸，表明"还在动"而不是停住了。 */
  pulsing?: boolean
}

const props = withDefaults(
  defineProps<{
    segments: MeterSegment[]
    /** 条高。`sm` 用在列表行里（4px），`md` 用在负载面板里（6px）。 */
    size?: 'sm' | 'md'
    tone?: MeterTone
    /** 右侧数值文字，如 "62%" / "3 / 6"。数字由调用方格式化——这里不做单位推断。 */
    valueLabel?: string
    /** 条上方或左侧的标签；不传就只画条。 */
    label?: string
    /** 无障碍名称。带 `label` 时可以省略。 */
    ariaLabel?: string
  }>(),
  { size: 'md', tone: 'accent', valueLabel: '', label: '', ariaLabel: '' },
)

const visible = computed(() => props.segments.filter((segment) => segment.fill > 0 || segment.tone))

/** 整体完成度，给屏幕阅读器用（视觉上不给百分比）。 */
const ratio = computed(() => {
  if (props.segments.length === 0) return 0
  const total = props.segments.reduce(
    (sum, segment) => sum + Math.min(Math.max(segment.fill, 0), 1),
    0,
  )
  return total / props.segments.length
})
</script>

<template>
  <div class="meter-block">
    <div v-if="label || valueLabel" class="meter-head">
      <span v-if="label" class="meter-label">{{ label }}</span>
      <span v-if="valueLabel" class="meter-value tabular">{{ valueLabel }}</span>
    </div>
    <div
      class="meter"
      :class="`meter-${size}`"
      role="progressbar"
      :aria-label="ariaLabel || label || undefined"
      :aria-valuenow="Math.round(ratio * 100)"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <span
        v-for="(segment, index) in visible"
        :key="index"
        class="segment"
        :class="[`segment-${segment.tone || tone}`, { pulsing: segment.pulsing }]"
        :title="segment.title"
      >
        <span
          class="segment-fill"
          :style="{ width: `${Math.min(Math.max(segment.fill, 0), 1) * 100}%` }"
        />
      </span>
    </div>
  </div>
</template>

<style scoped>
.meter-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.meter-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.meter-label {
  min-width: 0;
  overflow: hidden;
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 数值用正文色而不是弱色：它是这一格的主信息，标签才是辅助 */
.meter-value {
  flex: 0 0 auto;
  font-size: var(--text-micro-size);
  color: var(--text-primary);
}

.meter {
  display: flex;
  gap: var(--space-pair);
  width: 100%;
  /* 容器本身不画底：底由每一段自己画。段与段之间留 2px，读者才数得出"第几段" */
  overflow: hidden;
}

.meter-sm {
  height: 4px;
}

.meter-md {
  height: 6px;
}

.segment {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--radius-pill);
  /* 空槽：未走到的那几段。没有它，"共 6 段、走到第 3 段"就只剩文字在撑 */
  background: var(--meter-track);
}

.segment-fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-pill);
  transition: width 240ms ease;
}

.segment-accent .segment-fill {
  background: var(--accent);
}

.segment-info .segment-fill {
  background: var(--status-info);
}

.segment-success .segment-fill {
  background: var(--status-success);
}

.segment-warning .segment-fill {
  background: var(--status-warning);
}

.segment-danger .segment-fill {
  background: var(--status-danger);
}

.segment-neutral .segment-fill {
  background: var(--text-tertiary);
}

/* 进行中的那一段：缓慢呼吸。**它是"还在动"的唯一证据**——
   耗时数字在涨固然也是证据，但条本身静止会让人以为卡住了。
   关掉动画偏好时只是不呼吸，颜色与位置照旧。 */
.segment-info.pulsing .segment-fill,
.segment-accent.pulsing .segment-fill {
  animation: meter-pulse 1.8s ease-in-out infinite;
}

@keyframes meter-pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.55;
  }
}

@media (prefers-reduced-motion: reduce) {
  .segment-fill {
    transition: none;
  }

  .segment.pulsing .segment-fill {
    animation: none;
  }
}
</style>
