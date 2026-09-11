<script setup lang="ts">
/**
 * IconTasks 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `task-line`（Apache-2.0）。全仓图标统一取同一集合、
 * 同一 24×24 网格、同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M19 4H5v16h14zM3 2.992C3 2.444 3.447 2 3.999 2h16a1 1 0 0 1 1 1L21 20.993A1 1 0 0 1 20.007 22H3.993A1 1 0 0 1 3 21.008zm8.293 10.13l4.243-4.243l1.414 1.414l-5.657 5.657l-3.89-3.89l1.415-1.414z"
  /></IconBase>
</template>
