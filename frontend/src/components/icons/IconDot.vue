<script setup lang="ts">
/**
 * IconDot 图标：实心圆点，用于"进行中"状态。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
  </IconBase>
</template>
