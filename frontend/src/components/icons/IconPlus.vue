<script setup lang="ts">
/**
 * IconPlus 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `add-line`（Apache-2.0）。全仓图标统一取同一集合、
 * 同一 24×24 网格、同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"><path d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z" /></IconBase>
</template>
