<script setup lang="ts">
/**
 * 页头（《前端设计规范》§5）：页标题 + 可选副标题 + 次要操作，下方 1px hairline。
 *
 * 副标题的取舍：**只在它真的提供信息时才写**（"3 个知识库 · 共 137 篇文档"这类
 * 从数据里算出来的话），不写"这里是全部知识库"这种把标题换个说法重复一遍的废话——
 * 那种每页一句的解释性灰字才是模板感的来源。
 */
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <header class="page-head">
    <div class="page-head-main">
      <h1 class="page-title">{{ title }}</h1>
      <!-- 外层 p 提供排版，插槽内容可以是纯文本，也可以带 .sep 这类行内标记 -->
      <p v-if="description || $slots.description" class="page-description">
        <slot name="description">{{ description }}</slot>
      </p>
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
  gap: var(--space-4);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border-hairline);
}

/* 操作按钮与标题的第一行基线对齐，而不是与整块垂直居中——
   副标题一长，居中会让按钮"浮"在半空 */
.page-head-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-1);
}

.page-title {
  margin: 0;
}

.page-description {
  margin: var(--space-2) 0 0;
  max-width: 76ch;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}
</style>
