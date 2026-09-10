<script setup lang="ts">
/**
 * 骨架屏（《前端设计规范》§7）：`--bg-hover` 色块呼吸，不用 spinner 转圈。
 *
 * 尺寸必须与真实内容一致（行高、列宽都照抄列表），否则加载完成时会跳版。
 */
withDefaults(defineProps<{ variant?: 'card' | 'list' | 'text'; rows?: number }>(), {
  variant: 'text',
  rows: 3,
})
</script>

<template>
  <div v-if="variant === 'card'" class="skeleton-grid">
    <div v-for="index in rows" :key="index" class="skeleton-card">
      <div class="block block-title" />
      <div class="block block-meta" />
    </div>
  </div>

  <div v-else-if="variant === 'list'" class="skeleton-list">
    <div v-for="index in rows" :key="index" class="skeleton-row">
      <div class="block block-icon" />
      <div class="block block-line" />
      <div class="block block-time" />
    </div>
  </div>

  <div v-else class="skeleton-text">
    <div v-for="index in rows" :key="index" class="block block-text" />
  </div>
</template>

<style scoped>
.block {
  background: var(--bg-hover);
  border-radius: var(--radius-control);
  animation: breathe 1.4s ease-in-out infinite;
}

@keyframes breathe {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.5;
  }
}

.skeleton-grid {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
}

.skeleton-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  height: 88px;
  padding: var(--space-4);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.block-title {
  width: 60%;
  height: 15px;
}

.block-meta {
  width: 40%;
  height: 12px;
}

.skeleton-list {
  display: flex;
  flex-direction: column;
}

.skeleton-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  height: var(--row-height);
  border-bottom: 1px solid var(--border-hairline);
}

.block-icon {
  width: 36px;
  height: 36px;
}

.block-line {
  flex: 1;
  height: 13px;
}

.block-time {
  width: 88px;
  height: 12px;
}

.skeleton-text {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.block-text {
  height: 12px;
}

.block-text:last-child {
  width: 60%;
}

/* 呼吸动画对前庭敏感用户不友好，尊重系统开关 */
@media (prefers-reduced-motion: reduce) {
  .block {
    animation: none;
  }
}
</style>
