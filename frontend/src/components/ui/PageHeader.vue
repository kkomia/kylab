<script setup lang="ts">
/**
 * 页头（《前端设计规范 v0.3》§5）：页标题 + 次要操作，下方 1px 分割线。
 * 内容区统一用它，避免每个页面各写一遍标题样式。
 */
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <header class="page-head">
    <div class="page-head-main">
      <h1 class="page-title">{{ title }}</h1>
      <p v-if="description" class="page-description">{{ description }}</p>
    </div>
    <div class="page-head-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.page-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
}

.page-description {
  margin: 4px 0 0;
  color: var(--text-secondary);
}

.page-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
</style>
