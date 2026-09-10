<script setup lang="ts">
/**
 * IconChat 图标（内联 SVG，见《前端设计规范 v0.3》§3）：一个带两行文字的对话气泡。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <path
      d="M20 12.5c0 3.6-3.6 6.5-8 6.5a9.6 9.6 0 0 1-2.7-.4L5 21l1-3.3A6.3 6.3 0 0 1 4 12.5C4 8.9 7.6 6 12 6s8 2.9 8 6.5Z"
    />
    <path d="M9 11.5h6M9 14.5h4" />
  </IconBase>
</template>
