<script setup lang="ts">
/**
 * 硅基流动 品牌图标（内联 SVG）。
 *
 * 源：LobeHub Icons（lobehub/lobe-icons，MIT，见同目录 README）。品牌标识归各自
 * 所有者，此处仅用于"这是哪家服务"的识别。24×24 单路径、currentColor，
 * 与全仓图标同一套基座（见 IconBase）。
 */
import IconBase from '../IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M22.956 6.521H12.522c-.577 0-1.044.468-1.044 1.044v3.13c0 .577-.466 1.044-1.043 1.044H1.044c-.577 0-1.044.467-1.044 1.044v4.174C0 17.533.467 18 1.044 18h10.434c.577 0 1.044-.467 1.044-1.043v-3.13c0-.578.466-1.044 1.043-1.044h9.391c.577 0 1.044-.467 1.044-1.044V7.565c0-.576-.467-1.044-1.044-1.044z"
  /></IconBase>
</template>
