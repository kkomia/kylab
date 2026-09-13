<script setup lang="ts">
/**
 * IconFormatParagraph 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `text`（Apache-2.0）。笔记编辑器工具栏用——
 * 工具栏按 ima 的做法改用图标而不是文字标签，比"B/I/S/列表"更好认。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"><path d="M13 6V21H11V6H5V4H19V6H13Z" /></IconBase>
</template>
