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

/**
 * ``align``：浮层贴触发器的哪一边。
 *
 * 默认 ``right``（贴右缘），因为行内的「⋯」大多在右边。**输入框左下角那排工具按钮
 * 要用 ``left``**：它们贴着容器左边，按右缘对齐会让浮层往左伸出视口
 * （对话页的加号菜单实测就是这样被推出去的）。
 */
const props = defineProps<{ label?: string; align?: 'right' | 'left' }>()

const menu = ref<HTMLDetailsElement | null>(null)

/** 浮层向上弹出（下方放不下时）。 */
const dropUp = ref(false)

/**
 * 浮层的位置（写进内联样式）。**同时负责"没算好之前不显示"**。
 *
 * **用 `position: fixed` 相对视口定位，而不是相对最近的滚动祖先做 absolute**。
 * 原先的写法会被滚动容器裁掉：侧栏的会话列表、设置弹窗的正文都是
 * `overflow-y: auto`，而"溢出隐藏"在计算样式上等价于两个方向都裁，
 * 于是贴着右边缘的「⋯」菜单横向也会被切一块，看起来像和旁边的内容"叠在一起"。
 * 改成 fixed 之后可见范围就是视口，只有视口边缘才需要翻向——判断也更简单。
 *
 * **为什么坐标里还带着 `visibility`**：`<details>` 的 `toggle` 事件是**异步任务**
 * （规范里是"queue a details toggle event task"），所以点开的那一刻浏览器会先按
 * **静态位置**画一帧，等 toggle 跑完、`place()` 算好坐标再跳到正确位置——
 * 用户看到的就是"下拉框朝右边闪一下再回来"。把可见性一起写进这份内联样式，
 * 两个属性在同一次 DOM 更新里落地，中间那一帧就不存在了（`visibility: hidden`
 * 是可动画之外的"不绘制"，不会占位出错）。
 *
 * **调用方注意事项（踩过）**：浮层既然是 fixed，**任何祖先都不能有 `transform` /
 * `filter` / `contain: paint`**——它们会让那个祖先成为 fixed 后继的包含块，
 * 浮层就会被摆错位置。实测侧栏里一个 `transform: translateY(-50%)`（用来做垂直居中）
 * 把菜单摆到了 `left: -988px`，整个飘出视口。祖先要垂直居中请用负 margin 或
 * `inset-block: 0; margin-block: auto`。
 */
const listStyle = ref<Record<string, string>>({})

/** 点了菜单里的项就收起来；不依赖冒泡顺序，直接关。 */
function close(): void {
  if (menu.value) menu.value.open = false
}

const GAP = 4

/**
 * 按触发器的位置摆放浮层；放不下就翻到上方，顶端再兜个底。
 *
 * 每次打开与滚动/改变窗口大小时都重算：浮层如果滚走了会看起来"和按钮脱开了"，
 * 比直接关掉更让人困惑（用户会以为菜单坏了）。
 */
function place(): void {
  const element = menu.value
  const list = element?.querySelector('.menu-list') as HTMLElement | null
  if (!element || !list) return
  const trigger = element.getBoundingClientRect()
  const height = list.offsetHeight
  const below = window.innerHeight - trigger.bottom - GAP
  const above = trigger.top - GAP
  const flip = height > below && above > below
  dropUp.value = flip
  const top = flip ? Math.max(GAP, trigger.top - GAP - height) : trigger.bottom + GAP
  // 贴左缘时按触发器的左边定位，**并往回收一步**：贴左缘的按钮常在窄容器里，
  // 浮层比触发器宽，不夹一下就会伸出视口右侧（左对齐的典型失效方向与右对齐相反）。
  const left =
    props.align === 'left'
      ? Math.round(Math.min(trigger.left, window.innerWidth - list.offsetWidth - GAP))
      : null
  listStyle.value = {
    top: `${Math.round(top)}px`,
    ...(left === null
      ? { right: `${Math.round(Math.max(GAP, window.innerWidth - trigger.right))}px` }
      : { left: `${Math.round(Math.max(GAP, left))}px` }),
    // 与坐标同一次更新落地：见上面"为什么坐标里还带着 visibility"
    visibility: 'visible',
  }
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
    place()
    document.addEventListener('pointerdown', onOutsidePointer, true)
    document.addEventListener('keydown', onKeydown, true)
    // capture: 真正滚动的往往是内层容器，冒泡的 scroll 事件不会传到 document
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
  } else {
    dropUp.value = false
    // 收起时清掉坐标：下次打开必须重新走"先不可见、算好再显示"，
    // 否则会退回静态位置那一帧（也就是用户看到的"朝右边闪一下再回来"）
    listStyle.value = {}
    document.removeEventListener('pointerdown', onOutsidePointer, true)
    document.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('scroll', place, true)
    window.removeEventListener('resize', place)
  }
}

function onOutsidePointer(event: PointerEvent): void {
  const target = event.target as Node | null
  if (target && !menu.value?.contains(target)) close()
}

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutsidePointer, true)
  document.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('scroll', place, true)
  window.removeEventListener('resize', place)
})
</script>

<template>
  <details ref="menu" class="menu" @toggle="onToggle">
    <summary class="menu-trigger" :aria-label="label ?? '更多操作'">
      <!-- 触发器默认是「…」；需要别的入口（如笔记的 AI 星芒）时用 #trigger 覆盖 -->
      <slot name="trigger"><IconMore /></slot>
    </summary>
    <div class="menu-list" :class="{ 'menu-list-up': dropUp }" :style="listStyle">
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
  /* 触发器内容由插槽决定：图标时是 24px 的方块，带文字（如「AI」）时按内容撑开。
     用 min-width 而不是 width，两种形态都不用各自覆盖样式。 */
  min-width: var(--hit-target);
  width: auto;
  height: var(--hit-target);
  padding: 0 var(--space-1);
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
  /* 位置由 `place()` 算好写进内联样式（fixed + top/right + visibility），
     这里只负责外观。
     **不用 absolute**：那会被滚动容器裁掉，见 `listStyle` 上的说明。
     **默认不可见**：`place()` 把 `visibility: visible` 和坐标一起写进来，
     所以"没算好位置"的那一帧不会被画出来（否则会先闪到静态位置再跳回来）。 */
  position: fixed;
  visibility: hidden;
  z-index: 30;
  min-width: 168px;
  padding: var(--space-1);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-overlay);
  box-shadow: var(--shadow-popover);
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
