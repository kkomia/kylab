<script setup lang="ts">
/**
 * IconRobot 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `robot-line`（Apache-2.0）。同一集合、同一 24×24 网格、
 * 同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M13 4.055A9 9 0 0 1 21 13v9H3v-9a9 9 0 0 1 8-8.945V1h2zM19 20v-7a7 7 0 1 0-14 0v7zm-7-2a5 5 0 1 1 0-10a5 5 0 0 1 0 10m0-2a3 3 0 1 0 0-6a3 3 0 0 0 0 6m0-2a1 1 0 1 1 0-2a1 1 0 0 1 0 2"
  /></IconBase>
</template>
