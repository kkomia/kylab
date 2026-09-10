<script setup lang="ts">
/**
 * IconAlert 图标（内联 SVG，见《前端设计规范 v0.3》§3）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <path d="M12 8v5" /><path d="M12 16.5h.01" /><circle cx="12" cy="12" r="9" />
  </IconBase>
</template>
