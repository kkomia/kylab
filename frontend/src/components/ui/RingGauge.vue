<script setup lang="ts">
/**
 * 环形计量（`MeterBar` 的环形兄弟，v0.25）。
 *
 * ## 什么时候用环、什么时候用条
 *
 * 两者表达的是同一件事（"占了多少"），差别在**读的人需要什么**：
 *
 * - **条**用在需要**互相比较多个读数**的地方（文档的分段进度、一列并列的占比）：
 *   同一条基线上的长度差一眼看得出来，而环与环之间的角度差要靠猜。
 * - **环**用在**读数各自独立、只关心"离满还有多远"**的地方（负载面板的四个读数）：
 *   它是一个封闭的、占位固定的图形，所以 1.7% 这种极小的值也读得出来
 *   ——一根 400px 的条填 1.7% 只有 7px，和"没有数据"长得一样；
 *   而一个环无论多少都占同样的地方，缺口在哪一眼就看得到。
 *
 * 两个组件的 `tone` 取值一致，颜色语义（accent / warning / danger）也一致，
 * 所以同一页里混用不会有两套语言。
 *
 * ## 实现
 *
 * 纯 SVG：一个满圈的轨道 + 一段用 `stroke-dasharray` 截出来的弧。
 * **不用 `stroke-dashoffset` 做动画**：这个面板每秒刷新一次，
 * 每帧补间只会让数字一直在抖；状态变化由颜色承担（见 `tone`）。
 *
 * 中心的文字用**绝对定位的 HTML**而不是 `<text>`：字号要跟 `--font-scale`
 * （用户在设置里可调），SVG 文本吃不到 CSS 变量里的字号档。
 */
import { computed } from 'vue'

export type RingTone = 'accent' | 'warning' | 'danger' | 'neutral'

const props = withDefaults(
  defineProps<{
    /** 完成度 0–1。超出范围会被夹住，不会画出超过一圈的弧。 */
    ratio: number
    /** 圆心里的文字，通常是已经格式化好的百分比（`"62%"`）。 */
    label?: string
    tone?: RingTone
    /** 外径（px）。中心文字的可用宽度是它减去两倍描边再留一点余量。 */
    size?: number
    /** 无障碍名称。环形图对屏幕阅读器是不可见的，必须给。 */
    ariaLabel?: string
  }>(),
  { label: '', tone: 'accent', size: 48, ariaLabel: '' },
)

/** viewBox 固定 48；描边 4 是"看得出来、又不吃掉中心文字"的那一档 */
const STROKE = 4
const R = 20
const CIRCUMFERENCE = 2 * Math.PI * R

const clamped = computed(() => Math.min(Math.max(props.ratio, 0), 1))

/** 弧长：留一点最小值，让 0% 也能看出"这里有一个环、它是空的"而不是消失 */
const dash = computed(() => `${CIRCUMFERENCE * clamped.value} ${CIRCUMFERENCE}`)
</script>

<template>
  <span class="ring" :style="{ width: `${props.size}px`, height: `${props.size}px` }">
    <svg viewBox="0 0 48 48" :aria-label="props.ariaLabel" role="img" focusable="false">
      <!-- 轨道：整圈。**必须画**——只有弧的话，0% 的时候什么都没有，
           读起来像"这一格还没加载" -->
      <circle class="ring-track" cx="24" cy="24" :r="R" :stroke-width="STROKE" />
      <circle
        class="ring-arc"
        :class="`ring-${props.tone}`"
        cx="24"
        cy="24"
        :r="R"
        :stroke-width="STROKE"
        :stroke-dasharray="dash"
        stroke-linecap="round"
        transform="rotate(-90 24 24)"
      />
    </svg>
    <span v-if="props.label" class="ring-label tabular">{{ props.label }}</span>
  </span>
</template>

<style scoped>
.ring {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
}

.ring svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.ring-track,
.ring-arc {
  fill: none;
}

.ring-track {
  stroke: var(--meter-track);
}

/* 起点是 12 点方向（`transform="rotate(-90 …)"`），顺时针长出来——
   与人对"进度"的直觉一致 */
.ring-arc {
  stroke: var(--accent);
}

.ring-warning {
  stroke: var(--status-warning);
}

.ring-danger {
  stroke: var(--status-danger);
}

.ring-neutral {
  stroke: var(--text-tertiary);
}

.ring-label {
  font-size: var(--text-micro-size);
  font-weight: 600;
  color: var(--text-primary);
  /* 让文字压在环上而不是被 SVG 盖住 */
  position: relative;
}
</style>
