<script setup lang="ts">
/**
 * 说明提示：一个圆圈问号，鼠标移上去（或键盘聚焦）才显示解释。
 *
 * 为什么要有它：界面里的"解释性小字"曾经每处都摊在正文里，一屏好几段灰字，
 * 真正的设置项反而不突出。改成"需要时才出现"之后——
 * **默认什么都不显示，想知道的人自己去问**。
 *
 * 三条实现取舍：
 * 1. 用 `button` + `role="tooltip"` 而不是 `title` 属性：原生 title 延迟长、
 *    不能选样式、触屏完全看不到；
 * 2. 键盘可达：聚焦就显示、失焦就收起（`focus`/`blur`），不能只有 hover；
 * 3. 浮层 `position: fixed`（与 AppSelect 同一手法）：设置弹窗的内容区是
 *    `overflow: auto`，绝对定位的浮层会被裁掉。宽度固定 260px 并夹在视口内，
 *    所以不必先渲染再量——省掉一次回流。
 */
import { onBeforeUnmount, ref, useId } from 'vue'

import IconQuestion from '@/components/icons/IconQuestion.vue'

withDefaults(
  defineProps<{
    /** 说明正文。 */
    text: string
    /** 无障碍名，默认"说明"。 */
    label?: string
  }>(),
  { label: '说明' },
)

const uid = useId()
const bubbleId = `${uid}-tip`

const BUBBLE_WIDTH = 260
const GAP = 8

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const bubbleStyle = ref<Record<string, string>>({})

function show(): void {
  const element = root.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  // 横向夹在视口内，纵向默认贴在图标下方；下方不够就翻到上方
  const left = Math.max(GAP, Math.min(rect.left, window.innerWidth - BUBBLE_WIDTH - GAP))
  const below = window.innerHeight - rect.bottom
  const flip = below < 120 && rect.top > below
  bubbleStyle.value = {
    position: 'fixed',
    left: `${Math.round(left)}px`,
    width: `${BUBBLE_WIDTH}px`,
    ...(flip
      ? { bottom: `${Math.round(window.innerHeight - rect.top + GAP)}px` }
      : { top: `${Math.round(rect.bottom + GAP)}px` }),
  }
  open.value = true
}

function hide(): void {
  open.value = false
}

onBeforeUnmount(hide)
</script>

<template>
  <span ref="root" class="info-tip" @mouseenter="show" @mouseleave="hide">
    <button
      type="button"
      class="info-tip-button"
      :aria-label="label"
      :aria-describedby="open ? bubbleId : undefined"
      @focus="show"
      @blur="hide"
      @click.stop="open ? hide() : show()"
    >
      <IconQuestion :size="14" />
    </button>

    <span v-if="open" :id="bubbleId" class="info-tip-bubble" role="tooltip" :style="bubbleStyle">
      {{ text }}
    </span>
  </span>
</template>

<style scoped>
.info-tip {
  display: inline-flex;
  flex: 0 0 auto;
  vertical-align: middle;
}

/* 视觉上是 14px 图标，命中区给到 20px——太小在触屏上点不中 */
.info-tip-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--text-tertiary);
  border-radius: 999px;
}

.info-tip-button:hover,
.info-tip-button:focus-visible {
  color: var(--text-secondary);
  background: var(--bg-hover);
  outline: none;
}

.info-tip-bubble {
  z-index: 70;
  display: block;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-micro-size);
  line-height: 1.7;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  box-shadow: var(--shadow-popover);
}
</style>
