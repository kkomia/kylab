<script setup lang="ts">
/**
 * 状态徽标（《前端设计规范 v0.3》§7）。
 *
 * 统一"图标 + 文字 + 语义色"三件套：颜色只是辅助，文字永远在——
 * 色弱用户与黑白截图都能读懂状态（§8 必须项）。
 */
import { computed, type Component } from 'vue'

import IconAlert from '@/components/icons/IconAlert.vue'
import IconCheck from '@/components/icons/IconCheck.vue'
import IconClock from '@/components/icons/IconClock.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const ICONS: Record<StatusTone, Component> = {
  neutral: IconClock,
  info: IconRefresh,
  success: IconCheck,
  warning: IconAlert,
  danger: IconAlert,
}

const props = withDefaults(defineProps<{ label: string; tone?: StatusTone; title?: string }>(), {
  tone: 'neutral',
  title: undefined,
})

const icon = computed(() => ICONS[props.tone])
</script>

<template>
  <span class="status" :class="`status-${tone}`" :title="title">
    <component :is="icon" class="status-icon" />
    <span class="status-label">{{ label }}</span>
  </span>
</template>

<style scoped>
.status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
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
</style>
