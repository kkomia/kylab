<script setup lang="ts">
/**
 * IconChatNew 图标——「新建对话」（内联 SVG，见《前端设计规范》§3）。
 *
 * **这是第三处"来源由用户指定"的例外**（前两处是 `IconSidebar`、`IconLogo`）：
 * 用户直接给了一张参考图——**圆角矩形对话气泡 + 左下角小尾巴 + 气泡里一支时钟指针**。
 *
 * 按两轮找过的事实记一笔，免得下次再找一遍：
 * - iconfont.cn 的下载要登录，取不到源文件；
 * - 开放集里没有这个造型。`remixicon chat-history-line` 与 `tdesign chat-bubble-history`
 *   都是**圆**气泡，`mdi message-text-clock-outline` 虽是圆角气泡但里面还塞了文字线，
 *   都对不上参考图。所以这组几何是**照参考图描的**，不是从某个库搬的。
 *
 * 三个口径与本仓一致：
 * 1. **直接按 24×24 网格布点**——没有第二条坐标系，也就不需要 `IconSidebar` 那样的
 *    `transform` 缩放；
 * 2. **颜色一律 `currentColor`**：`fill="none"` + `stroke="currentColor"`，
 *    深浅主题都由 `color` 决定；
 * 3. **线宽 1.8**：16px 下约 1.2px，与旁边 Remix 那套的观感相当（描边会随尺寸缩放，
 *    所以不能像填充路径那样随手写个大数）。
 */
import IconBase from './IconBase.vue'
</script>

<template>
  <IconBase v-bind="$attrs"
    ><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"
      ><path
        d="M4.3 4.1h15.4a1.6 1.6 0 0 1 1.6 1.6v10.2a1.6 1.6 0 0 1-1.6 1.6h-9.9l-4.9 4.3v-4.3h-.6a1.6 1.6 0 0 1-1.6-1.6V5.7a1.6 1.6 0 0 1 1.6-1.6z" /><path
        d="M12 7.8v4.1l2.7 2.7" /></g
  ></IconBase>
</template>
