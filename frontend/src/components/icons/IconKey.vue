<script setup lang="ts">
/**
 * IconKey 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `key-line`（Apache-2.0）。同一集合、同一 24×24 网格、
 * 同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M12.917 13A6.002 6.002 0 0 1 1 12a6 6 0 0 1 11.917-1H23v2h-2v4h-2v-4h-2v4h-2v-4zM7 16a4 4 0 1 0 0-8a4 4 0 0 0 0 8"
  /></IconBase>
</template>
