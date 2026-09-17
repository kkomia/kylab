<script setup lang="ts">
import { computed, useSlots } from 'vue'

/**
 * 页头（《前端设计规范》§5）：页标题 + 可选副标题 + 次要操作，下方 1px hairline。
 *
 * 副标题的取舍：**只在它真的提供信息时才写**（"3 个知识库 · 共 137 篇文档"这类
 * 从数据里算出来的话），不写"这里是全部知识库"这种把标题换个说法重复一遍的废话——
 * 那种每页一句的解释性灰字才是模板感的来源。
 */
/**
 * ``title`` 可空（v0.22）：能力页要从标签开始、不要标题——它的名字左侧菜单里已经写着，
 * 页内再写一遍是重复。**没有标题、没有副标题、也没有动作时整块不渲染**，
 * 否则会留下一条空页头加一条 hairline。
 */
const props = defineProps<{ title?: string; description?: string }>()
const hasHead = computed(
  () => Boolean(props.title || props.description) || Boolean(useSlots().actions),
)
</script>

<template>
  <header v-if="hasHead" class="page-head">
    <div class="page-head-main">
      <div v-if="title || $slots['title-suffix']" class="page-title-row">
        <h1 v-if="title" class="page-title">{{ title }}</h1>
        <!-- 紧贴标题的行内控件（如知识库的设置齿轮）。这类控件属于"这个对象本身"，
             放在右侧动作区会读成"页面的动作"，语义不同 -->
        <slot name="title-suffix" />
      </div>
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

/* 标题与它右侧的行内控件同处一行，基线对齐 */
.page-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
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
