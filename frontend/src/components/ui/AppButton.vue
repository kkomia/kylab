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
  gap: var(--space-2);
  border-radius: var(--radius-control);
  white-space: nowrap;
  transition:
    background-color 120ms ease,
    border-color 120ms ease;
}

/* 禁用态用**实色**，不用 `opacity`。
   半透明会把白字一起洗淡：主按钮禁用态原本是 50% 透明的白字压 indigo，
   按 color/background 计算是 4.70 的"合格"，但按渲染后的真实像素只有 **2.02:1**
   ——禁用态最需要"读得清它写着什么"，恰恰最不该靠透明度表达。
   保留 1px 边框，"这是个暂时不能点的控件"这层意思仍然成立。 */
.button:disabled {
  color: var(--button-disabled-text);
  background: var(--button-disabled-bg);
  border: 1px solid var(--button-disabled-border);
  cursor: not-allowed;
}

/* 禁用态要压过各变体的底色，所以放在变体规则之后 */
.button-primary:disabled,
.button-danger:disabled {
  color: var(--button-disabled-text);
  background: var(--button-disabled-bg);
}

.button-sm {
  height: 28px;
  padding: 0 var(--space-3);
  font-size: var(--text-meta-size);
}

.button-md {
  height: 32px;
  padding: 0 var(--space-3);
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
