<script setup lang="ts">
/**
 * IconChat 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `chat-3-line`（Apache-2.0）。全仓图标统一取同一集合、
 * 同一 24×24 网格、同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M7.291 20.824L2 22l1.176-5.291A9.96 9.96 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10a9.96 9.96 0 0 1-4.709-1.176m.29-2.113l.653.35A7.96 7.96 0 0 0 12 20a8 8 0 1 0-8-8c0 1.335.325 2.617.94 3.766l.349.653l-.655 2.947z"
  /></IconBase>
</template>
