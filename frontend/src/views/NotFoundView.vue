<script setup lang="ts">
/** 404 页：地址拼错时给一个明确出口，而不是空白。 */
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
</script>

<template>
  <article class="page">
    <PageHeader title="页面不存在" />
    <section class="page-body">
      <EmptyState title="没有找到这个地址" hint="链接可能已失效，或者知识库/文档已经被删除。">
        <RouterLink to="/">
          <AppButton variant="primary">回到概览</AppButton>
        </RouterLink>
      </EmptyState>
    </section>
  </article>
</template>

<style scoped>
.page {
  max-width: var(--measure);
  margin: 0 auto;
  padding: var(--space-8) var(--page-gutter) var(--space-16);
}

.page-body {
  margin-top: var(--space-6);
}
</style>
