<script setup lang="ts">
/**
 * 通用按钮（《前端设计规范 v0.3》§7）：
 * 主按钮灰黑实心、次按钮透明 + 1px 边框、危险按钮语义红文字 + hover 浅红底。
 * 不使用 >8px 圆角，不加阴影。
 */
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
    size?: 'sm' | 'md'
    disabled?: boolean
    type?: 'button' | 'submit'
  }>(),
  { variant: 'secondary', size: 'md', disabled: false, type: 'button' },
)
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    class="button"
    :class="[`button-${variant}`, `button-${size}`]"
  >
    <slot name="icon" />
    <span v-if="$slots.default" class="button-label"><slot /></span>
  </button>
</template>

<style scoped>
.button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius-control);
  white-space: nowrap;
  transition:
    background-color 120ms ease,
    border-color 120ms ease;
}

.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.button-sm {
  height: 28px;
  padding: 0 10px;
  font-size: 13px;
}

.button-md {
  height: 32px;
  padding: 0 12px;
}

/* 主按钮：灰黑实心；深色主题下由变量自动变成近白（§2.2） */
.button-primary {
  background: var(--button-primary-bg);
  color: var(--button-primary-text);
}

.button-primary:hover:not(:disabled) {
  background: var(--button-primary-bg-hover);
}

.button-secondary {
  border: 1px solid var(--border-strong);
  color: var(--text-primary);
}

.button-secondary:hover:not(:disabled) {
  background: var(--bg-hover);
}

.button-ghost {
  color: var(--text-secondary);
}

.button-ghost:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.button-danger {
  color: var(--status-danger);
}

.button-danger:hover:not(:disabled) {
  background: var(--danger-soft);
}
</style>
