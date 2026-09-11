<script setup lang="ts">
/**
 * 下拉选择（《前端设计规范》§7）。
 *
 * 全仓**唯一**的下拉实现：此前各处直接用原生 `<select>` 再各写一遍样式
 * （侧栏使用者选择、数据源表单、模型注册器…），高度与边框各不相同。
 *
 * 两件事一起做对了才算"换过样式"：
 * 1. **原生 select 内核**——键盘、触屏、无障碍、移动端滚轮都由浏览器负责，
 *    自绘下拉要做对这四件事的成本远大于收益；
 * 2. **定制外观**——`appearance: none` 去掉系统箭头，右侧自绘 Remix 雪佛龙。
 *    只加边框不换外观，看起来仍像"没动过"（用户批注原话）。
 *
 * 高度取 `--control-height`，与输入框、按钮同高；宽度默认 100%，
 * 由父容器的 grid/flex 决定实际宽度。
 */
import IconChevronDown from '@/components/icons/IconChevronDown.vue'

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
  <span class="select-shell">
    <select :id="id" v-model="model" class="select" :disabled="disabled" :aria-label="ariaLabel">
      <option v-for="option in options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
    <IconChevronDown class="select-arrow" :size="14" />
  </span>
</template>

<style scoped>
/* 外壳只做定位：雪佛龙要压在原生箭头的原位，且不能抢点击 */
.select-shell {
  position: relative;
  display: block;
  width: 100%;
}

.select {
  width: 100%;
  height: var(--control-height);
  padding: 0 calc(var(--space-3) + 12px) 0 var(--space-3);
  font: inherit;
  color: var(--text-primary);
  /* 去掉系统箭头与系统内边距，外观完全由这里决定 */
  appearance: none;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  cursor: pointer;
}

.select:hover:not(:disabled) {
  border-color: var(--text-tertiary);
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

.select-arrow {
  position: absolute;
  top: 50%;
  right: var(--space-2);
  color: var(--text-tertiary);
  pointer-events: none;
  transform: translateY(-50%);
}

.select:disabled + .select-arrow {
  opacity: 0.7;
}
</style>
