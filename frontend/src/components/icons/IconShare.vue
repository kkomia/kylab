<script setup lang="ts">
/**
 * IconShare 图标（内联 SVG，见《前端设计规范》§3）。
 * 三个节点两条边：分享的通用语义（把一份内容连给另一个人）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle
      cx="18"
      cy="19"
      r="2.5"
    /><path d="M8.2 10.8 15.8 6.2" /><path d="M8.2 13.2 15.8 17.8" />
  </IconBase>
</template>
