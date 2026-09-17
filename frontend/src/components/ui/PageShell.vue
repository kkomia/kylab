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

/**
 * **没有 `description` 这个 prop**（v0.22，用户要求）。
 *
 * 原先每个页面都挂一句灰色小字解释"这一页是什么"，用户的原话是
 * "所有类似这种的全部删除，一个不留"。理由站得住：页面标题、侧栏那一条、
 * 以及页面里的内容本身已经说清了这是什么，那句解释把标题换个说法重复一遍，
 * 而它是每页最显眼的一行字——**解释性文案是最像模板的东西**。
 *
 * 口子一并删掉而不是留着不用：留着就一定会有下一个页面把它写回来
 * （这条不是猜的——上一轮我删了页标题，转头就在小节里写了一个同样的标题）。
 */
withDefaults(defineProps<{ title?: string; narrow?: boolean }>(), {
  title: undefined,
  narrow: false,
})
</script>

<template>
  <article class="page-shell" :class="{ 'page-shell-narrow': narrow }">
    <nav v-if="$slots.breadcrumb" class="page-shell-breadcrumb" aria-label="面包屑">
      <slot name="breadcrumb" />
    </nav>

    <PageHeader :title="title">
      <template v-if="$slots['title-suffix']" #title-suffix>
        <slot name="title-suffix" />
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
