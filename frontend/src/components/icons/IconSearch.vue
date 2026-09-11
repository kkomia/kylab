<script setup lang="ts">
/**
 * IconSearch 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `search-line`（Apache-2.0）。全仓图标统一取同一集合、
 * 同一 24×24 网格、同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="m18.031 16.617l4.283 4.282l-1.415 1.415l-4.282-4.283A8.96 8.96 0 0 1 11 20c-4.968 0-9-4.032-9-9s4.032-9 9-9s9 4.032 9 9a8.96 8.96 0 0 1-1.969 5.617m-2.006-.742A6.98 6.98 0 0 0 18 11c0-3.867-3.133-7-7-7s-7 3.133-7 7s3.133 7 7 7a6.98 6.98 0 0 0 4.875-1.975z"
  /></IconBase>
</template>
