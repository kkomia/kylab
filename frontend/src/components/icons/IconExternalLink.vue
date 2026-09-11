<script setup lang="ts">
/**
 * IconExternalLink 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `external-link-line`（Apache-2.0）。同一集合、同一 24×24 网格、
 * 同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M10 6v2H5v11h11v-5h2v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm11-3v8h-2V6.413l-7.793 7.794l-1.414-1.414L17.585 5H13V3z"
  /></IconBase>
</template>
