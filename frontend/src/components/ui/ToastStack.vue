<script setup lang="ts">
/**
 * 顶部细条通知（《前端设计规范 v0.3》§7）：语义色图标 + 文字，3 秒自消。
 * 渲染在 `AppShell` 顶层，任何页面推一条都能看见。
 */
import { computed, type Component } from 'vue'

import IconAlert from '@/components/icons/IconAlert.vue'
import IconCheck from '@/components/icons/IconCheck.vue'
import IconClose from '@/components/icons/IconClose.vue'
import { useToast, type ToastTone } from '@/composables/useToast'

const { toasts, dismiss } = useToast()

const ICONS: Record<ToastTone, Component> = {
  info: IconAlert,
  success: IconCheck,
  warning: IconAlert,
  danger: IconAlert,
}

const items = computed(() => toasts.value.map((toast) => ({ ...toast, icon: ICONS[toast.tone] })))
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <div v-for="item in items" :key="item.id" class="toast" :class="`toast-${item.tone}`">
      <component :is="item.icon" class="toast-icon" />
      <span class="toast-text">{{ item.message }}</span>
      <button class="toast-close" type="button" aria-label="关闭通知" @click="dismiss(item.id)">
        <IconClose :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  top: 12px;
  left: 50%;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transform: translateX(-50%);
}

.toast {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 260px;
  max-width: 520px;
  padding: 8px 12px;
  font-size: 13px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  box-shadow: var(--shadow-popover);
}

.toast-success .toast-icon {
  color: var(--status-success);
}

.toast-warning .toast-icon {
  color: var(--status-warning);
}

.toast-danger .toast-icon {
  color: var(--status-danger);
}

.toast-info .toast-icon {
  color: var(--status-info);
}

.toast-icon {
  flex: 0 0 auto;
}

.toast-text {
  flex: 1;
}

.toast-close {
  display: inline-flex;
  padding: 2px;
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
}

.toast-close:hover {
  color: var(--text-primary);
}
</style>
