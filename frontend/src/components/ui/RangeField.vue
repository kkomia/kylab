<script setup lang="ts">
/**
 * 数值滑杆（《前端设计规范》§7.4）。
 *
 * 用在"有推荐值、但精确到个位没意义"的参数上（块长 / 块重叠）：填数字要求用户先知道
 * 该填多少，滑杆把**范围**和**常用值落在哪**直接画出来——轨道上每个刻度点都是
 * 一个常用值，点下面是它的数值。
 *
 * 五个刻意的约定：
 * 1. **刻度点 = 常用值**：`marks` 传进来，越界的自动丢掉（重叠的上限跟着块长变，
 *    传进来的 256 在块长 128 时必须消失，否则点会画到轨道外面去）。
 * 2. **默认值那个点画成强调色**（`primary`）：用户一眼看到"常态在哪、我现在离它多远"。
 *    点用 `pointer-events: none`——它只是路标，**绝不能挡住拖动**（挡住比没有点更糟）。
 *    "跳到某个点"不需要额外逻辑：范围线性，拖到点上就是那个值。
 * 3. **右侧常驻读数**：滑杆藏了精度，没有读数就只能靠猜。刻度点标的是常用值，
 *    读数标的是当前值——两件事，缺一不可。
 * 4. **轨道自己画**（`::before`），不去改原生 `::-webkit-slider-runnable-track`：
 *    原生 track 的盒模型各浏览器不一样，改出来的线与滑块中心常差一两个像素。
 *    自己画就能用同一个 `--range-thumb` 把线、点、滑块三者对齐。
 * 5. **值到位置的换算是"滑块中心"**：滑块中心走的是 `[半滑块, 宽度 − 半滑块]`，
 *    直接按百分比铺点会在两端差半个滑块（约 7px）。
 */
import { computed } from 'vue'

const model = defineModel<number>({ required: true })

const props = withDefaults(
  defineProps<{
    min: number
    max: number
    step?: number
    id?: string
    /**
     * 轨道上的刻度点（常用值）。`primary` 的那个是默认值，画成强调色。
     * 落在 `[min, max]` 之外的点会被丢掉。
     */
    marks?: { value: number; primary?: boolean }[]
    /** 外层没有 `<label for>` 时，给读屏器的名字。 */
    ariaLabel?: string
  }>(),
  { step: 1, id: undefined, marks: () => [], ariaLabel: undefined },
)

/** 刻度点 + 它的落点。位置与 `--range-thumb` 同一个口径，改滑块尺寸时不会错位。 */
const items = computed(() =>
  props.marks
    .filter((mark) => mark.value >= props.min && mark.value <= props.max)
    .map((mark) => {
      const span = props.max - props.min
      const ratio = span <= 0 ? 0 : (mark.value - props.min) / span
      return {
        ...mark,
        left: `calc((100% - var(--range-thumb)) * ${ratio} + var(--range-thumb) / 2)`,
      }
    }),
)

function onInput(event: Event): void {
  model.value = Number((event.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="range-field">
    <div class="range-row">
      <div class="range-col" :class="{ 'range-col-marked': items.length > 0 }">
        <div class="range-rail">
          <input
            :id="id"
            class="range-input"
            type="range"
            :min="min"
            :max="max"
            :step="step"
            :value="model"
            :aria-label="ariaLabel"
            @input="onInput"
          />
          <!-- 刻度点与数值都只铺不点：见顶部注释第 2 条，绝不能挡住拖动 -->
          <span
            v-for="mark in items"
            :key="mark.value"
            class="range-mark"
            :class="{ 'range-mark-primary': mark.primary }"
            :style="{ left: mark.left }"
            aria-hidden="true"
          />
        </div>
        <span
          v-for="mark in items"
          :key="`label-${mark.value}`"
          class="range-mark-label"
          :class="{ 'range-mark-label-primary': mark.primary }"
          :style="{ left: mark.left }"
          aria-hidden="true"
          >{{ mark.value }}</span
        >
      </div>
      <output class="range-value tabular">{{ model }}</output>
    </div>
  </div>
</template>

<style scoped>
.range-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

/* 滑块尺寸只有这一个来源：轨道线、刻度点、数值标签、滑块都按它对齐。
   **必须定义在这一层**——`--range-thumb` 是自定义属性，只向下继承；
   挂在 `.range-rail` 上时，轨道的兄弟节点（下面那行数值标签）读不到它，
   `calc()` 整条失效、`left` 退回 `auto`，标签就全叠到轨道最左端了（真机上量到差 145px）。 */
.range-field {
  --range-thumb: 14px;
}

.range-col {
  position: relative;
  flex: 1;
  min-width: 0;
}

/* 给刻度数值留一行高度：它们是绝对定位的，不留就会压到下面的说明文字上 */
.range-col-marked {
  padding-bottom: 17px;
}

.range-rail {
  position: relative;
  height: var(--range-thumb);
  cursor: pointer;
}

.range-rail::before {
  content: '';
  position: absolute;
  top: 50%;
  left: calc(var(--range-thumb) / 2);
  right: calc(var(--range-thumb) / 2);
  height: 3px;
  margin-top: -1.5px;
  background: var(--border-strong);
  border-radius: 999px;
}

.range-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  appearance: none;
  background: transparent;
  cursor: pointer;
}

/* 滑块：实心圆 + 一圈背景色描边。压在轨道线与刻度点上都还看得清 */
.range-input::-webkit-slider-thumb {
  appearance: none;
  width: var(--range-thumb);
  height: var(--range-thumb);
  border: 2px solid var(--bg-surface);
  border-radius: 50%;
  background: var(--accent);
}

.range-input::-moz-range-thumb {
  width: var(--range-thumb);
  height: var(--range-thumb);
  border: 2px solid var(--bg-surface);
  border-radius: 50%;
  background: var(--accent);
}

/* 原生轨道让位给上面画的 ::before，否则会出现两条线 */
.range-input::-webkit-slider-runnable-track,
.range-input::-moz-range-track {
  background: transparent;
}

/* 刻度点：空心圈，与实心的滑块在形状上分得开——不会让人以为这是第二个把手 */
.range-mark {
  position: absolute;
  top: 50%;
  width: 9px;
  height: 9px;
  border: 2px solid var(--text-tertiary);
  border-radius: 50%;
  background: var(--bg-surface);
  transform: translate(-50%, -50%);
  pointer-events: none;
}

/* 默认值那一个：换成强调色，是轨道上唯一"值得记住的位置" */
.range-mark-primary {
  border-color: var(--accent-text);
}

/* 刻度数值：跟着刻度点走，两端会略微伸出轨道——左右各有容器内边距接着，不裁也不挤 */
.range-mark-label {
  position: absolute;
  bottom: 0;
  font-size: var(--text-micro-size);
  line-height: 1.2;
  color: var(--text-tertiary);
  white-space: nowrap;
  transform: translateX(-50%);
  pointer-events: none;
}

.range-mark-label-primary {
  color: var(--accent-text);
}

.range-value {
  flex: 0 0 auto;
  /* 按 4 位字预留：数值从 3 位变 4 位时不能推着轨道左右跳 */
  min-width: 4ch;
  font-size: var(--text-meta-size);
  text-align: right;
  color: var(--text-primary);
}
</style>
