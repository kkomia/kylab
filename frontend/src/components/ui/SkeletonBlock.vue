<script setup lang="ts">
/**
 * 骨架屏（《前端设计规范 v0.3》§7）：`--bg-hover` 色块呼吸，不用 spinner 转圈。
 *
 * 卡片网格必须用与卡片同尺寸的骨架，否则加载完会跳版。
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
    opacity: 0.55;
  }
}

.skeleton-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
}

.skeleton-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 88px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
}

.block-title {
  width: 60%;
  height: 16px;
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
  gap: 10px;
  height: var(--row-height);
  border-bottom: 1px solid var(--border);
}

.block-icon {
  width: 16px;
  height: 16px;
}

.block-line {
  flex: 1;
  height: 12px;
}

.block-time {
  width: 72px;
  height: 12px;
}

.skeleton-text {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
