<script setup lang="ts">
/**
 * IconGlobe 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * **这一枚是自己画的，不是 Remix 里抄的**——全仓其它图标都取自 Remix
 * （Apache-2.0，填充式线稿），而这个集合里没有合适的"联网/地球"。
 * 记在这里免得后来者以为它是从别处复制来的、去别处找它的出处。
 *
 * 画法是最经典的经纬球：一个圆 + 一条赤道 + 两条经线椭圆。**用描边而不是填充**：
 * 这种几何图形用填充路径画（外圆减内圆）要手算绕向，而描边一眼能看懂、
 * 改一行就能调粗细。`stroke-width` 取 2 是为了在 13px 下与邻居们的视觉重量对齐
 * （填充式线稿的笔画大约就是这个宽度）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs">
    <g fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3.6 9h16.8M3.6 15h16.8" />
    </g>
  </IconBase>
</template>
