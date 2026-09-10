<script setup lang="ts">
/**
 * IconRefresh 图标（内联 SVG，见《前端设计规范 v0.3》§3）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20 4v4h-4" />
  </IconBase>
</template>
