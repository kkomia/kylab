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
/**
 * 状态胶囊：底色 + 语义色文字 + 图标。
 *
 * 之前是"图标 + 灰字"，在整行都是灰字的列表里几乎扫不出来——状态是用户扫列表时
 * 第一个要找的东西，它必须有一个形状。底色用极低饱和的一层，只负责把这一小块
 * 从白底上托起来；颜色信息仍然由**文字**承担（§8：状态必须双编码，不靠颜色单独表意）。
 */
.status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 22px;
  padding: 0 var(--space-2);
  font-size: var(--text-micro-size);
  white-space: nowrap;
  border-radius: 999px;
}

.status-icon {
  flex: 0 0 auto;
}

.status-neutral {
  color: var(--text-secondary);
  background: var(--status-neutral-soft);
}

.status-success {
  color: var(--status-success);
  background: var(--status-success-soft);
}

.status-warning {
  color: var(--status-warning);
  background: var(--status-warning-soft);
}

.status-danger {
  color: var(--status-danger);
  background: var(--status-danger-soft);
}

.status-info {
  color: var(--status-info);
  background: var(--status-info-soft);
}

/* 进行中：不加底色，改用呼吸的圆点——它表示"还在动"，底色反而显得像已完成 */
.status-running {
  color: var(--text-secondary);
  background: transparent;
}

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
