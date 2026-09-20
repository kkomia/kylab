<script setup lang="ts">
/**
 * 产品标识（2026-09-20 用户重新设计的这一版：环行星 + 小写 "kylab"）。
 *
 * ## 为什么是重画的矢量，而不是用户给的那份 PNG
 *
 * 素材是 AI 生成的位图（带纸纹背景）。它进不了界面，三条理由每条都硬：
 *
 * 1. **要跟文字颜色**：侧栏与对话页的标都是 `currentColor`——浅色主题近黑、
 *    深色近白；固定颜色的位图在深色主题下就是一块脏东西；
 * 2. **尺寸跨度大**：侧栏 22px、对话页空态 34px，笔画只有几个像素——
 *    位图缩到那个尺寸只会糊成一团；
 * 3. **要能吃任意缩放**（系统 150% 缩放 + 站内字号档位）。
 *
 * 所以这份文件是把新标**逐像素量出来重画**的：环的椭圆参数、三处笔宽、
 * 字标的基线与字高、字距，全是拟合值（开发计划 §12.209 记了方法）。对得像不像：
 * 字标与原图重合度 **0.91**、星球标 **0.62**（后者笔画只有 2~5px，
 * 剩下的偏差都在 1px 以内，是原图自己的边缘抖动）。
 * 原图里那点不完美——外圆略呈椭圆、a 与 b 的碗半径差 4%——**没有照抄**：
 * 标该是干净的几何，把 AI 的抖动也复刻进来只会显得手抖。
 *
 * ## 两档变体
 *
 * - `wordmark`（默认）：完整的**锁定组合**（行星 + kylab）。比例取自合成图：
 *   行星与字标 1:1 并排，字标的上伸顶比行星顶低 29（原图像素）。
 * - `mark`：只有那颗环行星。用在空间小的地方（侧栏顶部那一格是 22px）。
 *
 * ## 小尺寸要光学校正：细线标等比缩到 22px 会整片发灰
 *
 * 原设计里笔画相对标高极细（外圆 5.5/299、环 2.2/299）。等比缩到 22px，
 * 外圆只剩 0.4px、环 0.16px——渲染出来是一片淡灰，看不出是个星球。
 * 所以这里给每根线一个**渲染像素下限**（外圆与环上小圆 1.15px、环 0.8px）：
 * 尺寸越小相对笔宽越粗，到 64px 以上自然回到原设计比例。
 *
 * 与 UI 图标分开的理由见旧版（沿用）：UI 图标统一取 Remix 集合（《前端设计规范》§3），
 * 但品牌标不是 UI 图标——它要能被认出来，混进通用图标集会失去标识性。
 */
const props = withDefaults(
  defineProps<{
    /** 高度（px）。宽度按该变体的真实比例自动算。 */
    size?: number
    /** `wordmark` 锁定组合 / `mark` 只有环行星。 */
    variant?: 'wordmark' | 'mark'
    /** 无障碍名。它是图形，屏幕阅读器要靠它知道这是什么。 */
    label?: string
  }>(),
  { size: 20, variant: 'wordmark', label: 'KYLAB 知识库' },
)

/**
 * 两档的画布。`viewBox` 的宽高就是原图里那一段的墨迹范围，所以下面的
 * 几何数值可以照着原图像素直接写，不必换算。
 */
const VARIANTS = {
  wordmark: { viewBox: '0 0 1128 303', ratio: 1128 / 303 },
  mark: { viewBox: '0 0 370 299', ratio: 370 / 299 },
} as const

/** 行星标自己的画布高度，光学校正用它把"渲染像素"换回"用户单位"。 */
const MARK_HEIGHT = 299

/** 组合里字标相对行星的落点（原图像素，量出来的）。 */
const WORDMARK_AT = { x: 437, y: 28 }
/** 组合里行星的落点：它在自己的画布里从 x=1 起笔，所以往左挪 1。 */
const MARK_AT = { x: -1, y: 0 }

/** 字标的笔宽（原图 21.5）。它最小的用法是 34px，等比下来 2.7px，够看，不加校正。 */
const WORD_STROKE = 21.5

const box = VARIANTS[props.variant]

/**
 * 光学校正：`base` 是设计笔宽（用户单位），`minPixels` 是希望的最小可见宽度。
 * 尺寸大时 `base` 本来就够，返回原值；尺寸小时返回按下限反推的宽度。
 */
function stroke(base: number, minPixels: number): number {
  return Math.max(base, (minPixels * MARK_HEIGHT) / props.size)
}
</script>

<template>
  <svg
    :width="Math.round(props.size * box.ratio)"
    :height="props.size"
    :viewBox="box.viewBox"
    fill="none"
    stroke="currentColor"
    role="img"
    :aria-label="props.label"
    focusable="false"
  >
    <!-- 环行星：外圆 + 环（斜 18.5°）+ 环上那颗小圆。三处都只是描边，没有填充 -->
    <g
      :transform="props.variant === 'wordmark' ? `translate(${MARK_AT.x} ${MARK_AT.y})` : undefined"
    >
      <circle cx="182.5" cy="148.5" r="145.75" :stroke-width="stroke(5.5, 1.15)" />
      <ellipse
        cx="185.5"
        cy="155.5"
        rx="192"
        ry="44"
        transform="rotate(-18.5 185.5 155.5)"
        :stroke-width="stroke(2.2, 0.8)"
      />
      <circle cx="318.5" cy="147" r="13.75" :stroke-width="stroke(5.5, 1.15)" />
    </g>

    <!-- 字标：小写 kylab，等线宽的几何无衬线。竖笔 + 斜笔用 path，两个碗用 circle -->
    <g
      v-if="props.variant === 'wordmark'"
      :transform="`translate(${WORDMARK_AT.x} ${WORDMARK_AT.y})`"
      :stroke-width="WORD_STROKE"
      stroke-linecap="butt"
    >
      <path d="M11.5 1V212" />
      <path d="M24 157L107 70" />
      <path d="M47 131L116 214" />
      <path d="M144.8 67L205 210.4" />
      <path d="M268.7 67L177.3 273" />
      <path d="M315.5 1V212" />
      <circle cx="430" cy="140.5" r="63.5" />
      <path d="M492 67V213" />
      <path d="M553 1V212" />
      <circle cx="615.5" cy="140.5" r="63.5" />
    </g>
  </svg>
</template>
