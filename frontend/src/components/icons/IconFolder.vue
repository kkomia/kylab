<script setup lang="ts">
/**
 * IconFolder 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `folder-line`（Apache-2.0）。同一集合、同一 24×24 网格、
 * 同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M4 5v14h16V7h-8.414l-2-2zm8.414 0H21a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h7.414z"
  /></IconBase>
</template>
