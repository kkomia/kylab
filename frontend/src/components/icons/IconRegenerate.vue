<script setup lang="ts">
/**
 * IconRegenerate 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `refresh-line`（Apache-2.0）。全仓图标统一取同一集合、
 * 同一 24×24 网格、同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 *
 * 与 IconRefresh（换一批示例问题）同形但不同名：图标表是"用途"的索引，
 * 两处共用同一个组件会让"改一个地方两处都变"变成缺陷。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M5.463 4.433A9.961 9.961 0 0 1 12 2c5.523 0 10 4.477 10 10c0 2.136-.67 4.116-1.81 5.74L17 12h3A8 8 0 0 0 6.46 6.228zm13.074 15.134A9.961 9.961 0 0 1 12 22C6.477 22 2 17.523 2 12c0-2.136.67-4.116 1.81-5.74L7 12H4a8 8 0 0 0 13.54 5.772z"
  /></IconBase>
</template>
