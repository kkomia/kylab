<script setup lang="ts">
/**
 * IconUpload 图标（内联 SVG，见《前端设计规范 v0.3》§3）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <path d="M12 16V4" /><path d="M7.5 8.5 12 4l4.5 4.5" /><path
      d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"
    />
  </IconBase>
</template>
