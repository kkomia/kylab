<script setup lang="ts">
/**
 * IconCopy 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `file-copy-line`（Apache-2.0）。全仓图标统一取同一集合、
 * 同一 24×24 网格、同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M7 6V3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm2 0h8a1 1 0 0 1 1 1v8h2V4H9zm-3 3v10h10V9z"
  /></IconBase>
</template>
