<script setup lang="ts">
/**
 * IconFormatTaskList 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `list-check`（Apache-2.0）。笔记编辑器工具栏用——
 * 工具栏按 ima 的做法改用图标而不是文字标签，比"B/I/S/列表"更好认。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"><path d="M8 4H21V6H8V4ZM3 3.5H6V6.5H3V3.5ZM3 10.5H6V13.5H3V10.5ZM3 17.5H6V20.5H3V17.5ZM8 11H21V13H8V11ZM8 18H21V20H8V18Z" /></IconBase>
</template>
