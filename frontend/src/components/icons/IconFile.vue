<script setup lang="ts">
/**
 * IconFile 图标（内联 SVG，见《前端设计规范 v0.3》§3）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" /><path d="M13 3v6h6" />
  </IconBase>
</template>
