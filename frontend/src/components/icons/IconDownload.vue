<script setup lang="ts">
/**
 * IconDownload 图标（内联 SVG，见《前端设计规范 v0.3》§3）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <path d="M12 4v12" /><path d="M7.5 11.5 12 16l4.5-4.5" /><path d="M4 18.5h16" />
  </IconBase>
</template>
