<script setup lang="ts">
/**
 * IconUpload 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `upload-line`（Apache-2.0）。全仓图标统一取同一集合、
 * 同一 24×24 网格、同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M3 19h18v2H3zM13 5.828V17h-2V5.828L4.929 11.9l-1.414-1.414L12 2l8.485 8.485l-1.414 1.415z"
  /></IconBase>
</template>
