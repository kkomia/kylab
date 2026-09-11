<script setup lang="ts">
/**
 * 行内操作菜单（「⋯」）（《前端设计规范 v0.8》§7）。
 *
 * 用原生 `<details>` 而不是自己写开关：键盘 Tab/Enter 展开、Esc 收起，
 * 这些行为浏览器已经做对了；同时 `summary` 本身就是可点区域，
 * 触屏用户不需要"先悬停再点"（§8 禁止项：仅有 hover 才可见的关键操作）。
 *
 * 视觉上默认低对比、整行 hover 时才明显——但**始终可聚焦、始终可点**。
 *
 * v0.8 补上原生 `<details>` 没做的三件事：
 * 1. 点浮层外部收起（原生只在再点一次 summary 时才收）；
 * 2. Esc 收起，且**只收菜单不收外层弹窗**——设置弹窗是原生 `<dialog>`，
 *    Esc 会触发它的 `cancel`，菜单开着时按 Esc 连人带对话框一起关掉、用户丢了位置。
 *    所以在捕获阶段截住 Esc 并 `preventDefault`，让最内层先关；
 * 3. 下方空间不够时向上弹。设置弹窗的正文是个滚动容器，卡片贴着底边时
 *    向下弹的菜单会被裁掉——「删除」正好是最后一项，裁掉它就等于藏了破坏性操作。
 * 用 `toggle` 事件按需挂/摘监听，不给每个实例常驻 document 监听。
 */
import { onBeforeUnmount, ref } from 'vue'

import IconMore from '@/components/icons/IconMore.vue'

defineProps<{ label?: string }>()

const menu = ref<HTMLDetailsElement | null>(null)

/** 浮层向上弹出（下方放不下时）。 */
const dropUp = ref(false)

/** 点了菜单里的项就收起来；不依赖冒泡顺序，直接关。 */
function close(): void {
  if (menu.value) menu.value.open = false
}

/** 离最近的可滚动祖先：浮层的可见范围由它决定，不是由视口决定。 */
function clipParent(el: HTMLElement): HTMLElement {
  let node = el.parentElement
  while (node) {
    if (/(auto|scroll|hidden)/.test(getComputedStyle(node).overflowY)) return node
    node = node.parentElement
  }
  return document.documentElement
}

/** Esc 只关菜单：捕获阶段拦下，别让外层 `<dialog>` 的 cancel 跟着触发。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  close()
}

/** 浮层展开期间才挂监听，收起即摘掉。 */
function onToggle(): void {
  if (!menu.value) return
  if (menu.value.open) {
    const list = menu.value.querySelector('.menu-list') as HTMLElement | null
    const trigger = menu.value.getBoundingClientRect()
    const clip = clipParent(menu.value).getBoundingClientRect()
    const height = list?.offsetHeight ?? 0
    const below = clip.bottom - trigger.bottom
    const above = trigger.top - clip.top
    dropUp.value = height > below && above > below
    document.addEventListener('pointerdown', onOutsidePointer, true)
    document.addEventListener('keydown', onKeydown, true)
  } else {
    dropUp.value = false
    document.removeEventListener('pointerdown', onOutsidePointer, true)
    document.removeEventListener('keydown', onKeydown, true)
  }
}

function onOutsidePointer(event: PointerEvent): void {
  const target = event.target as Node | null
  if (target && !menu.value?.contains(target)) close()
}

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutsidePointer, true)
  document.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <details ref="menu" class="menu" @toggle="onToggle">
    <summary class="menu-trigger" :aria-label="label ?? '更多操作'">
      <IconMore />
    </summary>
    <div class="menu-list" :class="{ 'menu-list-up': dropUp }">
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
  width: var(--hit-target);
  height: var(--hit-target);
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
  top: calc(100% + var(--space-1));
  z-index: 10;
  min-width: 168px;
  padding: var(--space-1);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-overlay);
  box-shadow: var(--shadow-popover);
}

.menu-list-up {
  top: auto;
  bottom: calc(100% + var(--space-1));
}

/* 菜单项统一在这里定，调用方只写语义类（menu-item-danger / disabled）。
   纯文字、无图标——菜单里再塞图标会让一列方块看起来比它承载的操作更重。 */
.menu-list :deep(button) {
  display: block;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-primary);
  text-align: left;
  border-radius: var(--radius-control);
}

.menu-list :deep(button:hover:not(:disabled)) {
  background: var(--bg-hover);
}

.menu-list :deep(button:disabled) {
  color: var(--text-tertiary);
  cursor: not-allowed;
}

.menu-list :deep(.menu-item-danger) {
  color: var(--status-danger);
}

.menu-list :deep(.menu-item-danger:hover:not(:disabled)) {
  background: var(--danger-soft);
}
</style>
