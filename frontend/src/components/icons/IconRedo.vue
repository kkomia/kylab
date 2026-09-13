<script setup lang="ts">
/**
 * IconRedo 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `arrow-go-forward-line`（Apache-2.0）。笔记编辑器工具栏用——
 * 工具栏按 ima 的做法改用图标而不是文字标签，比"B/I/S/列表"更好认。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M18.1716 6.99955H11C7.68629 6.99955 5 9.68584 5 12.9996C5 16.3133 7.68629 18.9996 11 18.9996H20V20.9996H11C6.58172 20.9996 3 17.4178 3 12.9996C3 8.58127 6.58172 4.99955 11 4.99955H18.1716L15.636 2.46402L17.0503 1.0498L22 5.99955L17.0503 10.9493L15.636 9.53509L18.1716 6.99955Z"
  /></IconBase>
</template>
