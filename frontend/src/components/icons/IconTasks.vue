<script setup lang="ts">
/**
 * IconTasks 图标（内联 SVG，见《前端设计规范 v0.3》§3）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <path d="M4 6h10M4 12h10M4 18h6" /><path d="M17 13.5 19 16l3-4" />
  </IconBase>
</template>
