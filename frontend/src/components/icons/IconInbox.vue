<script setup lang="ts">
/**
 * IconInbox 图标（内联 SVG，见《前端设计规范 v0.3》§3）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <path d="M4 13h4l1.5 2.5h5L16 13h4" /><path
      d="M5.5 5.5h13l1.5 7.5v3.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V13z"
    />
  </IconBase>
</template>
