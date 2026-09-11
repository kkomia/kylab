<script setup lang="ts">
/**
 * IconInbox 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `inbox-archive-line`（Apache-2.0）。全仓图标统一取同一集合、
 * 同一 24×24 网格、同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="m20 3l2 4v13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.004L4 3zm0 6H4v10h16zm-7 1v4h3l-4 4l-4-4h3v-4zm5.764-5H5.237l-1 2h15.527z"
  /></IconBase>
</template>
