<script setup lang="ts">
/**
 * IconTrash 图标（内联 SVG，见《前端设计规范 v0.3》§3）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path
      d="M6 7l1 12a2 2 0 0 0 2 1.8h6A2 2 0 0 0 17 19l1-12"
    /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </IconBase>
</template>
