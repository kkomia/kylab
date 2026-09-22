<script setup lang="ts">
/**
 * 数值滑杆（《前端设计规范》§7.4）。
 *
 * 用在"有推荐值、但精确到个位没意义"的参数上（块长 / 块重叠）：填数字要求用户先知道
 * 该填多少，滑杆把**范围**和**常用值落在哪**直接画出来——轨道上每个刻度点都是
 * 一个常用值，点下面是它的数值。
 *
 * 六个刻意的约定：
 * 1. **刻度点 = 常用值**：`marks` 传进来，越界的自动丢掉（重叠的上限跟着块长变，
 *    传进来的 256 在块长 128 时必须消失，否则点会画到轨道外面去）。
 * 2. **默认值那个点画成强调色**（`primary`）：用户一眼看到"常态在哪、我现在离它多远"。
 *    点用 `pointer-events: none`——它只是路标，**绝不能挡住拖动**（挡住比没有点更糟）。
 *    "跳到某个点"不需要额外逻辑：范围线性，拖到点上就是那个值。
 * 3. **右侧常驻读数**：滑杆藏了精度，没有读数就只能靠猜。刻度点标的是常用值，
 *    读数标的是当前值——两件事，缺一不可。传 `editable-value` 时读数变成数字框：
 *    滑杆负责"大概在哪"，要用精确值时不必再跟指针手感较劲（见第 6 条）。
 * 4. **轨道自己画**（`::before`），不去改原生 `::-webkit-slider-runnable-track`：
 *    原生 track 的盒模型各浏览器不一样，改出来的线与滑块中心常差一两个像素。
 *    自己画就能用同一个 `--range-thumb` 把线、点、滑块三者对齐。
 * 5. **值到位置的换算是"滑块中心"**：滑块中心走的是 `[半滑块, 宽度 − 半滑块]`，
 *    直接按百分比铺点会在两端差半个滑块（约 7px）。
 * 6. **吸附只认指针拖动**（`snap-to-marks`）：指针滑到刻度附近就吸过去，键盘**不吸**。
 *    键盘的每一步本来就是精确的 1，一吸就出事——站在 1024 上按方向键得到 1025，
 *    又被吸回 1024，用户再也走不出这个刻度。同理，数字框也**不吸附**：
 *    手打 1000 是明确的意图，替用户改成 1024 是自作主张。
 */
import { computed, ref, watch } from 'vue'

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
    /** 拖动时靠近 `marks` 就吸附过去。键盘与数字框不受影响（见顶部注释第 6 条）。 */
    snapToMarks?: boolean
    /** 右侧读数改成可输入的数字框（默认只读展示）。 */
    editableValue?: boolean
    /** 数字框的名字：外层 `<label for>` 指的是滑杆，管不到这个框。 */
    valueLabel?: string
  }>(),
  // 可选属性显式给 undefined 默认值：Vue 语义上一样，但能让 lint 配置看清"这是刻意的可选"
  {
    step: 1,
    id: undefined,
    marks: () => [],
    ariaLabel: undefined,
    snapToMarks: false,
    editableValue: false,
    valueLabel: undefined,
  },
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

/**
 * 吸附的"磁力半径"：量程的 3%。摊到约 400px 宽的轨道上就是 ±12px——手能感觉到，
 * 又不至于把刻度之间的值整段吃掉（块长吸到 1024 之后，900 这种中间值照样拖得到）。
 */
const SNAP_RATIO = 0.03

/**
 * 指针正按在滑杆上。**只有指针拖动才吸附**——见顶部注释第 6 条：键盘一吸就锁死在刻度上。
 *
 * 复位挂 `pointerup / pointercancel / blur` 三个事件：原生 range 拖动时浏览器会
 * 隐式捕获指针，在轨道外面松手也能收到 `pointerup`；万一某个环境漏了，退化的结果
 * 也只是"键盘跟着吸附"，不会卡住不能动。
 */
const dragging = ref(false)

/** 靠近某个刻度就返回那个刻度，否则原样返回。 */
function snapped(value: number): number {
  if (!props.snapToMarks || !dragging.value) return value
  const radius = (props.max - props.min) * SNAP_RATIO
  let nearest = value
  let distance = Number.POSITIVE_INFINITY
  for (const item of items.value) {
    const gap = Math.abs(item.value - value)
    if (gap < distance) {
      distance = gap
      nearest = item.value
    }
  }
  return distance <= radius ? nearest : value
}

function onInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value)
  model.value = snapped(raw)
}

/**
 * 数字框里的**原始文本**。必须有一份自己的草稿：输入过程中允许暂时非法
 * （打「1024」时先出现的是「1」），直接写回 `model` 等于把中间态当真值抛给父组件——
 * 分块那两处会顺手把重叠压回上限，"1" 这一下就把设置改掉了。
 */
const numberDraft = ref(String(model.value))
/** 正在这个框里打字：此时从外面（拖滑杆）来的变化不回写草稿，否则会把正在打的字冲掉。 */
const editing = ref(false)

watch(model, (value) => {
  if (!editing.value) numberDraft.value = String(value)
})

/**
 * 失焦 / 回车才提交。**能解析就按 `[min, max]` 夹一下**，与滑杆的原生夹取同一套边界
 * （`max` 传进来的就是这道参数的上限，比如块重叠的上限跟着块长走）——用户看到的
 * 永远是落在范围内的数，不把非法值留在框里，也不为它发明一条新的报错；
 * 解析不出来（清空、乱敲）就回显当前值，等于这次输入没发生。
 */
function commitNumber(): void {
  editing.value = false
  const text = numberDraft.value.trim()
  const parsed = text === '' ? Number.NaN : Number(text)
  if (!Number.isFinite(parsed)) {
    numberDraft.value = String(model.value)
    return
  }
  const value = Math.min(props.max, Math.max(props.min, Math.round(parsed)))
  model.value = value
  numberDraft.value = String(value)
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
            @pointerdown="dragging = true"
            @pointerup="dragging = false"
            @pointercancel="dragging = false"
            @blur="dragging = false"
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
      <input
        v-if="editableValue"
        :id="id ? `${id}-value` : undefined"
        class="range-value range-number tabular"
        type="number"
        :min="min"
        :max="max"
        :step="step"
        :value="numberDraft"
        :aria-label="valueLabel"
        @input="numberDraft = ($event.target as HTMLInputElement).value"
        @focus="editing = true"
        @change="commitNumber"
        @blur="commitNumber"
        @keydown.enter.prevent="commitNumber"
      />
      <output v-else class="range-value tabular">{{ model }}</output>
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
  border-radius: var(--radius-pill);
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

/* 可编辑的读数：**给它一个框**。一行纯文本右对齐时没人知道那里能改，
   用户报的正是"右侧数字不能直接编辑"。边框与聚焦口径与 AppInput 一致，
   免得同一个弹窗里两种输入框长得不一样。 */
.range-number {
  box-sizing: border-box;
  /* 8ch：4 位数 + 原生步进按钮的宽度。写死宽度是为了拖动滑杆时读数变化
     不会推着轨道左右跳（与上面 `min-width` 同一个理由） */
  width: 8ch;
  height: var(--control-height);
  padding: 0 var(--space-2);
  font: inherit;
  font-size: var(--text-meta-size);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  outline: none;
  transition: var(--transition-ui);
}

.range-number:hover {
  border-color: var(--text-quaternary);
}

.range-number:focus {
  border-color: var(--text-primary);
  box-shadow: inset 0 0 0 1px var(--text-primary);
}
</style>
