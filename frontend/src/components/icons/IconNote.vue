<script setup lang="ts">
/**
 * IconNote 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `sticky-note-line`（Apache-2.0，与本仓其余图标同一套）。
 *
 * 换过一次：原来用 `draft-line`（文稿 + 铅笔），但 16px 下它与上面的「知识库」
 * （`book-2-line`，也是一块竖向矩形）轮廓太像，不看标签几乎分不出来。
 * `sticky-note-line` 是"便签 + 折角"，右下角的缺口让它在小尺寸下也有辨识度，
 * 语义上正好是"随手记的笔记"。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M21 15L15 20.996L4.00221 21C3.4487 21 3 20.5551 3 20.0066V3.9934C3 3.44476 3.44495 3 3.9934 3H20.0066C20.5552 3 21 3.45576 21 4.00247V15ZM19 5H5V19H13V14C13 13.4872 13.386 13.0645 13.8834 13.0067L14 13L19 12.999V5ZM18.171 14.999L15 15V18.169L18.171 14.999Z"
  /></IconBase>
</template>
