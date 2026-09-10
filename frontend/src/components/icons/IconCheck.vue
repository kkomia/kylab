<script setup lang="ts">
/**
 * IconCheck 图标（内联 SVG，见《前端设计规范 v0.3》§3）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <path d="M5 12.5 9.5 17 19 7" />
  </IconBase>
</template>
