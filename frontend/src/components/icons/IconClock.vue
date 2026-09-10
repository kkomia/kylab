<script setup lang="ts">
/**
 * IconClock 图标（内联 SVG，见《前端设计规范 v0.3》§3）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"> <circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" /> </IconBase>
</template>
