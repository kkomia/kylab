<script setup lang="ts">
/**
 * 概览页：知识库清单（《前端设计规范 v0.3》§6）。
 *
 * 形态按 §5.1 选：知识库是"容器型"对象，条目 ≤12 时用卡片网格（一屏内做"进哪一个"的
 * 决策），超过 12 个自动切列表——不把卡片挤成越来越窄的格子。
 */
import { computed, ref } from 'vue'

import IconLibrary from '@/components/icons/IconLibrary.vue'
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

/** 清单由 App 外壳统一加载（侧栏也要用），这里只加一个手动重试入口。 */
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
</script>

<template>
  <article class="page">
    <PageHeader
      title="概览"
      description="本服务只返回检索结果原文，不做任何 LLM 预处理；注入防护由调用方负责。"
    >
      <template #actions>
        <AppButton variant="primary" @click="createOpen = true">
          <template #icon><IconPlus /></template>
          新建知识库
        </AppButton>
      </template>
    </PageHeader>

    <section class="page-body">
      <p v-if="store.error" class="error-line">{{ store.error }}</p>

      <SkeletonBlock v-if="store.loading && !hasItems" variant="card" :rows="3" />

      <EmptyState
        v-else-if="!hasItems"
        title="还没有知识库"
        hint="知识库是最外层的容器：一个知识库对应一套 embedding 模型与一组切分参数。"
      >
        <AppButton variant="primary" @click="createOpen = true">
          <template #icon><IconPlus /></template>
          新建知识库
        </AppButton>
      </EmptyState>

      <div v-else-if="store.useCardGrid" class="card-grid">
        <RouterLink v-for="kb in store.items" :key="kb.id" class="card" :to="`/kb/${kb.id}`">
          <span class="card-title">{{ kb.name }}</span>
          <span class="card-meta"> {{ kb.embedding_model_id }} · {{ kb.embedding_dim }} 维 </span>
          <span class="card-meta">
            切分 {{ kb.chunk_size }} / 重叠 {{ kb.chunk_overlap }} ·
            {{ formatRelativeTime(kb.created_at) }}
          </span>
        </RouterLink>
      </div>

      <ul v-else class="kb-rows">
        <li v-for="kb in store.items" :key="kb.id" class="kb-row">
          <IconLibrary class="row-icon" />
          <RouterLink class="row-name" :to="`/kb/${kb.id}`">{{ kb.name }}</RouterLink>
          <span class="row-meta">{{ kb.embedding_model_id }} · {{ kb.embedding_dim }} 维</span>
          <span class="row-time">{{ formatRelativeTime(kb.created_at) }}</span>
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
        embedding 模型与切分参数用服务端默认值；库内已有向量后再改模型会被拒绝（架构 §6.4）。
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
  max-width: 960px;
  margin: 0 auto;
  padding: 32px 24px 64px;
}

.page-body {
  margin-top: 20px;
}

.error-line {
  margin: 0 0 12px;
  color: var(--status-danger);
}

/* 卡片：1px 边框 + 8px 圆角、无阴影；hover 只把边框转强（§7） */
.card-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
}

.card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 88px;
  padding: 14px;
  color: inherit;
  text-decoration: none;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
}

.card:hover {
  border-color: var(--border-strong);
  text-decoration: none;
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-meta {
  font-size: 12px;
  color: var(--text-secondary);
}

/* 列表形态：行高 40px、行底 1px 细线、无竖线（§7） */
.kb-rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.kb-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--row-height);
  border-bottom: 1px solid var(--border);
}

.row-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-meta,
.row-time {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.field-label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}

.field-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-tertiary);
}
</style>
