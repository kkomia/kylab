<script setup lang="ts">
/**
 * IconArrowUp 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `arrow-up-line`（Apache-2.0）。全仓图标统一取同一集合、
 * 同一 24×24 网格、同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 *
 * 用途：输入卡片右下角的「发送」——文字按钮在这样一条工具行里太占位置，
 * 而"往上发出去"这个箭头已经是对话类产品的通用符号。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M13 7.82843V20H11V7.82843L5.63574 13.1927L4.22153 11.7785L11.9999 4.00009L19.7783 11.7785L18.3641 13.1927L13 7.82843Z"
  /></IconBase>
</template>
