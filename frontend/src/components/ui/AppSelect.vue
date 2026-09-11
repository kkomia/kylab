<script setup lang="ts">
/**
 * 下拉选择（《前端设计规范》§7）。
 *
 * 存在的理由：此前各处直接用原生 `<select>` 再各写一遍样式（侧栏使用者选择、
 * 模型注册器…），高度与边框各不相同。控件外观只有一处维护，才不会每个新下拉
 * 都长出一点自己的样子。
 *
 * 用**原生 select**而不是自绘：键盘、触屏、无障碍与移动端滚轮都由浏览器负责，
 * 自绘下拉要做对这几件事的成本远大于收益（自绘只在需要富内容时才值得）。
 */
const model = defineModel<string>({ required: true })

withDefaults(
  defineProps<{
    /** 选项值 → 显示文案。空值选项用于"不指定"这类语义。 */
    options: { value: string; label: string }[]
    id?: string
    disabled?: boolean
    /** 无障碍名：没有可见 <label> 时必填。 */
    ariaLabel?: string
  }>(),
  { id: undefined, disabled: false, ariaLabel: undefined },
)
</script>

<template>
  <select :id="id" v-model="model" class="select" :disabled="disabled" :aria-label="ariaLabel">
    <option v-for="option in options" :key="option.value" :value="option.value">
      {{ option.label }}
    </option>
  </select>
</template>

<style scoped>
/* 与 AppInput 的 .field 同高同边框：一排控件不在一条基线上最容易被看出来 */
.select {
  min-height: 32px;
  padding: 0 var(--space-2);
  font: inherit;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  cursor: pointer;
}

.select:focus {
  border-color: var(--text-secondary);
  outline: none;
}

.select:disabled {
  color: var(--text-tertiary);
  cursor: not-allowed;
  opacity: 0.7;
}
</style>
