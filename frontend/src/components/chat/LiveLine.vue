<script setup lang="ts">
/**
 * 流式期间那一行实时状态（v0.27，照 DeepSeek 的 harness）。
 *
 * **只有一行**，最新吐出来的字从右边进来、旧的往左边滚出去（左边淡出，不是硬切）。
 * 它替掉的是"思考像一堵墙一样长高"那种观感：一轮里想了几千字，屏幕上始终是
 * 一行在滚——这是"它在飞快地做事"最直接的画面。
 *
 * 两处实现上的取舍：
 *
 * 1. **用 `scrollLeft` 而不是动画库**：文本每来一块就把它滚到最右端，
 *    `scroll-behavior: smooth` 负责把这一次滚动补成动画。零额外状态、
 *    零计时器，也不会在事件密集时堆一串队列。
 * 2. **左侧用 `mask-image` 淡出**：滚出去的是半句话，硬切会留下一排断口；
 *    淡出之后它读起来是"还在往前写"。
 *
 * 文本本身由 `liveLine()` 决定（工具 > 思考 > 摘要），这里只管怎么显示。
 */
import { nextTick, ref, watch } from 'vue'

const props = defineProps<{ text: string }>()

const line = ref<HTMLElement | null>(null)

watch(
  () => props.text,
  async () => {
    await nextTick()
    const element = line.value
    // 内容还在变宽时才要滚；`scrollLeft` 直接给到最右，mid-roll 的新内容不会跳
    if (element) element.scrollLeft = element.scrollWidth
  },
)
</script>

<template>
  <span ref="line" class="live">
    <span class="live-text">{{ props.text }}</span>
  </span>
</template>

<style scoped>
.live {
  display: block;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  /* 左边淡出：滚出去的那半句不该被硬切成一排断口 */
  mask-image: linear-gradient(to right, transparent, #000 28px);
  scroll-behavior: smooth;
}

.live-text {
  display: inline-block;
}

/* 用户关掉了动画（`prefers-reduced-motion`）时不滚：直接给最新的那一截，
   位置仍然对（`scrollLeft` 由脚本设置，只是没有平滑过渡） */
@media (prefers-reduced-motion: reduce) {
  .live {
    scroll-behavior: auto;
  }
}
</style>
