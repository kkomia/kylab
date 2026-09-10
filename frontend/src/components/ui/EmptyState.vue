<script setup lang="ts">
/**
 * 空状态（《前端设计规范 v0.3》§7）：
 * 线稿 SVG（48px）+ 一句灰字 + 一个主操作按钮；不用彩色插画、不用 emoji。
 *
 * 线条直接画在这里而不是复用 16px 图标：图标放大到 48px 会显得笔画过细、比例失衡。
 */
withDefaults(defineProps<{ title: string; hint?: string }>(), { hint: '' })
</script>

<template>
  <div class="empty">
    <svg
      class="empty-art"
      width="48"
      height="48"
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M10 16.5 24 8l14 8.5v15L24 40l-14-8.5z" />
      <path d="M10 16.5 24 25l14-8.5M24 25v15" />
    </svg>
    <p class="empty-title">{{ title }}</p>
    <p v-if="hint" class="empty-hint">{{ hint }}</p>
    <div v-if="$slots.default" class="empty-action">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 24px;
  text-align: center;
  color: var(--text-tertiary);
}

.empty-art {
  color: var(--border-strong);
}

.empty-title {
  margin: 0;
  font-size: 15px;
  color: var(--text-secondary);
}

.empty-hint {
  margin: 0;
  font-size: 13px;
  max-width: 420px;
}

.empty-action {
  margin-top: 8px;
}
</style>
