<script setup lang="ts">
/**
 * IconChevronLeft 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `arrow-left-s-line`（Apache-2.0），与 IconChevronRight 是同一枚的镜像。
 * 全仓图标统一取同一集合、同一 24×24 网格、同一视觉重量；颜色一律由 `currentColor` 决定。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M10.8284 12.0007L15.7782 16.9504L14.364 18.3646L8 12.0007L14.364 5.63672L15.7782 7.05093L10.8284 12.0007Z"
  /></IconBase>
</template>
