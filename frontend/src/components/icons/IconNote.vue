<script setup lang="ts">
/**
 * IconNote 图标（内联 SVG，见《前端设计规范》§3）。
 *
 * 源：Remix 图标集合 `draft-line`（Apache-2.0，与本仓其余图标同一套）。
 * 为什么选它：用户要求「笔记」入口配一个与风格相近的图标（可参考腾讯 ima）。
 * 项目全仓图标统一走 Remix 这一套，混入别家图标会出现"只有它线条粗细不一样"的
 * 观感问题。`draft-line` 是"文稿 + 铅笔 + 文字行"的造型，语义正好是笔记/写作，
 * 又与 `IconLibrary`/`IconTasks` 的实心几何一致，因此不再另描一套线稿。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><path
      d="M20 2C20.5523 2 21 2.44772 21 3V6.757L19 8.757V4H5V20H19V17.242L21 15.242V21C21 21.5523 20.5523 22 20 22H4C3.44772 22 3 21.5523 3 21V3C3 2.44772 3.44772 2 4 2H20ZM21.7782 8.80761L23.1924 10.2218L15.4142 18L13.9979 17.9979L14 16.5858L21.7782 8.80761ZM13 12V14H8V12H13ZM16 8V10H8V8H16Z"
  /></IconBase>
</template>
