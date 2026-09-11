<script setup lang="ts">
/**
 * 图标基座（《前端设计规范》§3）。
 *
 * 统一 24×24 网格、`currentColor`、填充式线稿。所有图标都是内联 SVG，
 * 不用 iconfont、不用图片、不引外链图标库——深浅主题与禁用态的着色
 * 全部由 CSS `color` 决定，不会出现"图标颜色跟不上主题"。
 *
 * **填充而不是描边**：全仓图标取自 Remix 集合（Apache-2.0），它的 "line" 系列
 * 以填充路径绘制线稿（视觉仍是线性单色）。用填充有个实际好处——
 * 16px 下描边会因缩放变得忽粗忽细，填充路径不会。详见《界面评审与改进计划》§5。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 16 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <slot />
  </svg>
</template>
