<script setup lang="ts">
/**
 * IconArchive 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `archive-line`（Apache-2.0）。同一集合、同一 24×24 网格、
 * 同一视觉重量；填充式线稿，颜色一律由 `currentColor` 决定。
 *
 * **与 IconTrash 必须一眼分得开**：它们同在一个菜单里，而误点的代价不对称
 * （归档可撤销、删除不可恢复），所以外形上不能有任何相近之处——
 * 这只是带盖的收纳箱，没有叉号、没有倾倒的桶。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M4 3h16a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v1h14V5zM3 9h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zm2 2v8h14v-8zm5 2h4v2h-4z"
  /></IconBase>
</template>
