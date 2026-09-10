<script setup lang="ts">
/**
 * 页头（《前端设计规范》§5）：页标题 + 次要操作，下方 1px hairline。
 *
 * 标题之外**默认不加描述句**：每个页面都挂一句解释性灰字，是"模板感"最常见的来源之一。
 * 确实需要交代上下文时，把话放到内容区第一段，或做成可展开的帮助入口。
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
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border-hairline);
}

.page-title {
  margin: 0;
}

.page-description {
  margin: var(--space-1) 0 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.page-head-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2);
}
</style>
