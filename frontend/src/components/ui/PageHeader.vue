<script setup lang="ts">
import { computed, useSlots } from 'vue'

/**
 * 页头（《前端设计规范》§5）：页标题 + 次要操作，下方 1px hairline。
 *
 * **没有副标题**（v0.22，用户要求"所有类似这种的全部删除"）：那句灰色小字
 * 解释"这一页是什么"，而标题、侧栏那一条与页面内容本身已经说清了——
 * 它是每页最显眼的一行字，也是最像模板的一行字。
 */
/**
 * ``title`` 可空（v0.22）：能力页要从标签开始、不要标题——它的名字左侧菜单里已经写着，
 * 页内再写一遍是重复。**没有标题也没有动作时整块不渲染**，
 * 否则会留下一条空页头加一条 hairline。
 */
const props = defineProps<{ title?: string }>()
const hasHead = computed(() => Boolean(props.title) || Boolean(useSlots().actions))
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
</style>
