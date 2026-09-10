<script setup lang="ts">
/**
 * IconClose 图标（内联 SVG，见《前端设计规范 v0.3》§3）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <path d="M6 6l12 12M18 6 6 18" />
  </IconBase>
</template>
