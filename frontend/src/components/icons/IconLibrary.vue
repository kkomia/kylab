<script setup lang="ts">
/**
 * IconLibrary 图标（内联 SVG，见《前端设计规范 v0.3》§3）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <path d="M4 19.5V5.5A1.5 1.5 0 0 1 5.5 4H17a3 3 0 0 1 3 3v12.5" /><path
      d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20"
    /><path d="M8 8h8M8 12h5" />
  </IconBase>
</template>
