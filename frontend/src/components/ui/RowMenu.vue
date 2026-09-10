<script setup lang="ts">
/**
 * 行内操作菜单（"⋯"）（《前端设计规范 v0.3》§7）。
 *
 * 用原生 `<details>` 而不是自己写开关：键盘 Tab/Enter 展开、Esc 前先收起，
 * 这些行为浏览器已经做对了；同时 `summary` 本身就是可点区域，
 * 触屏用户不需要"先悬停再点"（§8 禁止项：仅有 hover 才可见的关键操作）。
 *
 * 视觉上默认低对比、整行 hover 时才明显——但**始终可聚焦、始终可点**。
 */
import { ref } from 'vue'

import IconMore from '@/components/icons/IconMore.vue'

defineProps<{ label?: string }>()

const menu = ref<HTMLDetailsElement | null>(null)

/** 点了菜单里的项就收起来；不依赖冒泡顺序，直接关。 */
function close(): void {
  if (menu.value) menu.value.open = false
}
</script>

<template>
  <details ref="menu" class="menu">
    <summary class="menu-trigger" :aria-label="label ?? '更多操作'">
      <IconMore />
    </summary>
    <div class="menu-list">
      <slot :close="close" />
    </div>
  </details>
</template>

<style scoped>
.menu {
  position: relative;
}

.menu-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
  cursor: pointer;
  list-style: none;
}

.menu-trigger::-webkit-details-marker {
  display: none;
}

.menu-trigger:hover,
.menu[open] .menu-trigger {
  background: var(--bg-active);
  color: var(--text-primary);
}

.menu-list {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 10;
  min-width: 160px;
  padding: var(--space-1);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  box-shadow: var(--shadow-popover);
}

.menu-list :deep(button) {
  display: block;
  width: 100%;
  padding: 6px var(--space-3);
  text-align: left;
  border-radius: var(--radius-control);
}

.menu-list :deep(button:hover) {
  background: var(--bg-hover);
}
</style>
