<script setup lang="ts">
/**
 * IconStop 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `stop-fill`（Apache-2.0）。全仓图标统一取同一集合、
 * 同一 24×24 网格、同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 *
 * 用途：流式回答进行中的「停止」。它是「发送」的同一个位置、同一个形状量级，
 * 所以两者切换时按钮不会跳动——那一下跳动正是用户最不想看到的。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M7 6H17C17.5523 6 18 6.44772 18 7V17C18 17.5523 17.5523 18 17 18H7C6.44772 18 6 17.5523 6 17V7C6 6.44772 6.44772 6 7 6Z"
  /></IconBase>
</template>
