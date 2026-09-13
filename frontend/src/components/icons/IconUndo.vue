<script setup lang="ts">
/**
 * IconUndo 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `arrow-go-back-line`（Apache-2.0）。笔记编辑器工具栏用——
 * 工具栏按 ima 的做法改用图标而不是文字标签，比"B/I/S/列表"更好认。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M5.82843 6.99955L8.36396 9.53509L6.94975 10.9493L2 5.99955L6.94975 1.0498L8.36396 2.46402L5.82843 4.99955H13C17.4183 4.99955 21 8.58127 21 12.9996C21 17.4178 17.4183 20.9996 13 20.9996H4V18.9996H13C16.3137 18.9996 19 16.3133 19 12.9996C19 9.68584 16.3137 6.99955 13 6.99955H5.82843Z"
  /></IconBase>
</template>
