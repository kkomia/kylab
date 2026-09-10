<script setup lang="ts">
/**
 * 状态徽标（《前端设计规范》§7）。
 *
 * 统一"图标 + 文字 + 语义色"三件套：颜色只是辅助，文字永远在——
 * 色弱用户与黑白截图都能读懂状态（§8 必须项）。
 */
import { computed, type Component } from 'vue'

import IconAlert from '@/components/icons/IconAlert.vue'
import IconCheck from '@/components/icons/IconCheck.vue'
import IconClock from '@/components/icons/IconClock.vue'
import IconDot from '@/components/icons/IconDot.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const ICONS: Record<StatusTone, Component> = {
  neutral: IconClock,
  info: IconRefresh,
  success: IconCheck,
  warning: IconAlert,
  danger: IconAlert,
}

/** 圆点用于"在动"的状态：它比旋转箭头安静，也更容易扫视。 */
const RUNNING_ICON = IconDot

const props = withDefaults(
  defineProps<{ label: string; tone?: StatusTone; running?: boolean; title?: string }>(),
  { tone: 'neutral', running: false, title: undefined },
)

const icon = computed(() => (props.running ? RUNNING_ICON : ICONS[props.tone]))
</script>

<template>
  <span class="status" :class="[`status-${tone}`, { 'status-running': running }]" :title="title">
    <component :is="icon" class="status-icon" />
    <span class="status-label">{{ label }}</span>
  </span>
</template>

<style scoped>
.status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  white-space: nowrap;
  color: var(--text-secondary);
}

.status-icon {
  flex: 0 0 auto;
}

.status-success .status-icon {
  color: var(--status-success);
}

.status-warning .status-icon {
  color: var(--status-warning);
}

.status-danger .status-icon {
  color: var(--status-danger);
}

.status-info .status-icon {
  color: var(--status-info);
}

/* 进行中：呼吸提示"它在动"，而不是静止的图标 */
.status-running .status-icon {
  color: var(--status-info);
  animation: pulse 1.6s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .status-running .status-icon {
    animation: none;
  }
}
</style>
