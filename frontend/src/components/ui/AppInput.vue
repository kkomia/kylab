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
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  outline: none;
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

.field::placeholder {
  color: var(--text-tertiary);
}

.field:hover:not(:disabled) {
  border-color: var(--text-tertiary);
}

.field:focus {
  border-color: var(--text-secondary);
}

.field:disabled {
  color: var(--text-tertiary);
  cursor: not-allowed;
  opacity: 0.7;
}
</style>
