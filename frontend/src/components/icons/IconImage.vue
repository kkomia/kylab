<script setup lang="ts">
/**
 * IconImage 图标（内联 SVG，见《前端设计规范 v0.3》§3）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.5" /><path
      d="M5 17l4.5-4.5L13 16l2.5-2.5L20 18"
    />
  </IconBase>
</template>
