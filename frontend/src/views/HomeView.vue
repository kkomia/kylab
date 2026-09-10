<script setup lang="ts">
/**
 * 概览页：知识库清单（《前端设计规范》§6）。
 *
 * 形态是**排版行**，不是卡片：卡片靠容器切分信息，行靠留白与字号分级切分。
 * 左端的姓名牌给每行一个扫视锚点，不必逐字读；
 * 右侧把"最近更新"排成一条竖轴——对齐的数字本身比任何装饰都更像在说"这是一份清单"。
 */
import { computed, ref } from 'vue'

import IconPlus from '@/components/icons/IconPlus.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import { formatRelativeTime } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const store = useKnowledgeBaseStore()
const { notifyError, notifySuccess } = useToast()

const createOpen = ref(false)
const draftName = ref('')
const creating = ref(false)

const hasItems = computed(() => store.items.length > 0)

async function submitCreate(): Promise<void> {
  const name = draftName.value.trim()
  if (!name) {
    notifyError('知识库名称不能为空')
    return
  }
  creating.value = true
  try {
    const created = await store.create({ name })
    notifySuccess(`已创建知识库「${created.name}」`)
    createOpen.value = false
    draftName.value = ''
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '创建失败')
  } finally {
    creating.value = false
  }
}

/** 姓名牌取名称首字：中文取第一个字，英文取首字母大写。 */
function initial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase()
}
</script>

<template>
  <article class="page">
    <PageHeader title="知识库">
      <template #actions>
        <AppButton variant="primary" @click="createOpen = true">
          <template #icon><IconPlus /></template>
          新建知识库
        </AppButton>
      </template>
    </PageHeader>

    <section class="page-body">
      <p v-if="store.error" class="error-line">{{ store.error }}</p>

      <SkeletonBlock v-if="store.loading && !hasItems" variant="list" :rows="3" />

      <EmptyState
        v-else-if="!hasItems"
        title="还没有知识库"
        hint="知识库是最外层的容器，每个库对应一套 embedding 模型与一组切分参数。"
      >
        <AppButton variant="primary" @click="createOpen = true">
          <template #icon><IconPlus /></template>
          新建知识库
        </AppButton>
      </EmptyState>

      <ul v-else class="kb-list">
        <li v-for="kb in store.items" :key="kb.id" class="kb-item">
          <RouterLink class="kb-link" :to="`/kb/${kb.id}`">
            <span class="kb-mark" aria-hidden="true">{{ initial(kb.name) }}</span>
            <span class="kb-main">
              <span class="kb-name">{{ kb.name }}</span>
              <span class="kb-meta">
                {{ kb.embedding_model_id }}
                <span class="kb-sep">/</span>
                {{ kb.embedding_dim }} 维
              </span>
            </span>
            <span class="kb-time tabular">{{ formatRelativeTime(kb.created_at) }}</span>
          </RouterLink>
        </li>
      </ul>
    </section>

    <AppModal v-model:open="createOpen" title="新建知识库">
      <label class="field-label" for="kb-name">名称</label>
      <AppInput
        id="kb-name"
        v-model="draftName"
        placeholder="例如：产品手册"
        @keyup.enter="submitCreate"
      />
      <p class="field-hint">
        模型与切分参数用服务端默认值。库内已有向量后再改模型会被拒绝，详见架构 §6.4。
      </p>
      <template #footer>
        <AppButton @click="createOpen = false">取消</AppButton>
        <AppButton variant="primary" :disabled="creating" @click="submitCreate">
          {{ creating ? '创建中…' : '创建' }}
        </AppButton>
      </template>
    </AppModal>
  </article>
</template>

<style scoped>
.page {
  max-width: 880px;
  margin: 0 auto;
  padding: var(--space-8) var(--page-gutter) var(--space-16);
}

.page-body {
  margin-top: var(--space-6);
}

.error-line {
  margin: 0 0 var(--space-4);
  color: var(--status-danger);
}

.kb-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 行：靠留白分级，不靠容器包围 */
.kb-item + .kb-item {
  border-top: 1px solid var(--border-hairline);
}

.kb-link {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-3);
  margin: 0 calc(-1 * var(--space-3));
  color: inherit;
  text-decoration: none;
  border-radius: var(--radius-control);
}

.kb-link:hover {
  background: var(--bg-hover);
  text-decoration: none;
}

/* 姓名牌：给每行一个扫视锚点 */
.kb-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
}

.kb-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.kb-name {
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.005em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-meta {
  overflow: hidden;
  font-size: 12.5px;
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-sep {
  padding: 0 2px;
  color: var(--border-strong);
}

.kb-time {
  flex: 0 0 auto;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.field-label {
  display: block;
  margin-bottom: var(--space-2);
  font-size: 13px;
  color: var(--text-secondary);
}

.field-hint {
  margin: var(--space-3) 0 0;
  font-size: 12.5px;
  color: var(--text-tertiary);
}
</style>
