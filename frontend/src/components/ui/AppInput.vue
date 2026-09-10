<script setup lang="ts">
/**
 * 文本输入 / 文本域（《前端设计规范 v0.3》§7）：
 * 1px `--border-strong`，聚焦时边框加深 + 无外发光。
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
  }>(),
  // 可选属性显式给 undefined 默认值：Vue 语义上一样，但能让 lint 配置看清"这是刻意的可选"
  {
    placeholder: undefined,
    multiline: false,
    rows: 3,
    disabled: false,
    id: undefined,
    type: 'text',
  },
)
</script>

<template>
  <textarea
    v-if="multiline"
    :id="id"
    v-model="model"
    class="field"
    :rows="rows"
    :placeholder="placeholder"
    :disabled="disabled"
  />
  <input
    v-else
    :id="id"
    v-model="model"
    class="field"
    :type="type"
    :placeholder="placeholder"
    :disabled="disabled"
  />
</template>

<style scoped>
/* 单行 32px 高，与按钮、下拉框同高：一排控件不在一条基线上是最容易被看出来的破绽。
   内边距只用阶梯值（--space-2），高度靠 min-height 定，不再出现 6px 这种随手数。 */
.field {
  width: 100%;
  min-height: 32px;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  outline: none;
  resize: vertical;
}

.field::placeholder {
  color: var(--text-tertiary);
}

.field:focus {
  border-color: var(--text-secondary);
}

.field:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
