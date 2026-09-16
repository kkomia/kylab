<script setup lang="ts">
/**
 * 文本输入 / 文本域（《前端设计规范》§7）。
 *
 * 单行输入的高度取 `--control-height`，与下拉、按钮同一个口径——
 * 之前用 `min-height:32px` + 上下 padding 撑，实际渲染成 43px（字体 15px × 行高 1.65
 * 再加 16px padding），和 32px 的下拉在同一行里差 11px。
 * **规范说的是 32px，就把高度写成 32px**，不要用 padding 去凑一个"大概"。
 *
 * 文本域不受此约束：它天然多行，高度由 `rows` 决定。
 */
const model = defineModel<string>({ required: true })

withDefaults(
  defineProps<{
    placeholder?: string
    multiline?: boolean
    rows?: number
    disabled?: boolean
    id?: string
    /** 数字输入用原生 number：浏览器的步进与移动端数字键盘都归它管。 */
    type?: 'text' | 'number' | 'password'
    /** 交给浏览器的自动填充提示（username / current-password / new-password）。 */
    autocomplete?: string
  }>(),
  // 可选属性显式给 undefined 默认值：Vue 语义上一样，但能让 lint 配置看清"这是刻意的可选"
  {
    placeholder: undefined,
    multiline: false,
    rows: 3,
    disabled: false,
    id: undefined,
    type: 'text',
    autocomplete: undefined,
  },
)
</script>

<template>
  <textarea
    v-if="multiline"
    :id="id"
    v-model="model"
    class="field field-multiline"
    :rows="rows"
    :placeholder="placeholder"
    :disabled="disabled"
  />
  <input
    v-else
    :id="id"
    v-model="model"
    class="field field-single"
    :type="type"
    :placeholder="placeholder"
    :autocomplete="autocomplete"
    :disabled="disabled"
  />
</template>

<style scoped>
.field {
  width: 100%;
  font: inherit;
  color: var(--text-primary);
  background: var(--bg-surface);
  /* 静止态用 hairline（= Kimi 的 Separators-S1）而不是 border-strong：
     控件的边界由底色差与一层浅线共同表达，线一重就成了"表格框"。 */
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  outline: none;
  transition: var(--transition-ui);
}

/* 单行：高度就是控件口径，文本靠 height 自然垂直居中 */
.field-single {
  height: var(--control-height);
  padding: 0 var(--space-3);
}

.field-multiline {
  min-height: var(--control-height);
  padding: var(--space-2) var(--space-3);
  resize: vertical;
}

/* 占位符用四级灰。这是规范 v0.13 §2 的用途约定：
   Quaternary 只给禁用态与占位符——它不属于"要被读到的信息"。 */
.field::placeholder {
  color: var(--text-quaternary);
}

.field:hover:not(:disabled) {
  border-color: var(--text-quaternary);
}

/* 聚焦：描边转品牌色 + 一圈柔光。只换描边颜色在浅色下几乎看不出来，
   而"我现在在哪个框里"是打字时最需要一眼确认的事。 */
.field:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* 禁用态用**实色**而不是 opacity：半透明会把文字与底色一起推向对方，
   实测禁用文字常常掉到 3:1 以下——而"这里写的是什么"恰恰是禁用态最需要读清的。
   与主题里 --button-disabled-* 同一口径。 */
.field:disabled {
  color: var(--button-disabled-text);
  background: var(--button-disabled-bg);
  border-color: var(--button-disabled-border);
  cursor: not-allowed;
}
</style>
