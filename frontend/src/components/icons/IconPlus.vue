<script setup lang="ts">
/**
 * IconPlus 图标（内联 SVG，见《前端设计规范 v0.3》§3）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <path d="M12 5v14M5 12h14" />
  </IconBase>
</template>
