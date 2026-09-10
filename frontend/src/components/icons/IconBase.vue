<script setup lang="ts">
/**
 * 图标基座：统一 24×24 线稿、1.5 描边、`currentColor`（《前端设计规范 v0.3》§3）。
 *
 * 所有图标都是内联 SVG，不用 iconfont、不用图片、不引外链图标库——
 * 这样深浅主题与禁用态的着色全部由 CSS `color` 决定，不会出现"图标颜色跟不上主题"。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 16 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <slot />
  </svg>
</template>
