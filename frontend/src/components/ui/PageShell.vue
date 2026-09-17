<script setup lang="ts">
/**
 * 页面外壳（《前端设计规范》§5）。
 *
 * 存在的理由：上一轮每个页面各写一套 `.page { max-width: Npx; margin: 0 auto }`，
 * 结果六个页面全是"居中一条"，宽屏下两侧大片空白，还各写一个不一样的宽度。
 * 这里统一成**左对齐铺满**——控制台是工具，宽度该用在信息上。
 *
 * `narrow` 只给真正的阅读型页面（文档详情）：正文超过 66ch 就该限宽，
 * 但那是内容的事，不是整页的事。
 */
import PageHeader from '@/components/ui/PageHeader.vue'

withDefaults(defineProps<{ title?: string; description?: string; narrow?: boolean }>(), {
  title: undefined,
  description: undefined,
  narrow: false,
})
</script>

<template>
  <article class="page-shell" :class="{ 'page-shell-narrow': narrow }">
    <nav v-if="$slots.breadcrumb" class="page-shell-breadcrumb" aria-label="面包屑">
      <slot name="breadcrumb" />
    </nav>

    <PageHeader :title="title" :description="description">
      <template v-if="$slots['title-suffix']" #title-suffix>
        <slot name="title-suffix" />
      </template>
      <template v-if="$slots.description" #description>
        <slot name="description" />
      </template>
      <template v-if="$slots.actions" #actions>
        <slot name="actions" />
      </template>
    </PageHeader>

    <section class="page-shell-body">
      <slot />
    </section>
  </article>
</template>

<style scoped>
.page-shell-breadcrumb {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}
</style>
