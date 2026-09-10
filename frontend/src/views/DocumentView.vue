<script setup lang="ts">
/**
 * 文档详情页（《前端设计规范 v0.3》§6）：标题 + 元信息行 + Markdown 预览。
 *
 * 目前预览的是"后端切分后的前若干块拼起来"的内容——原文下载接口（签名 URL）
 * 排在 M7，所以先不做假按钮。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import { getDocument, type DocumentSummary } from '@/api/documents'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import AppButton from '@/components/ui/AppButton.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { documentStageView } from '@/components/ui/status'
import { formatBytes, formatDate } from '@/composables/useFormat'

const route = useRoute()

const documentId = computed(() => String(route.params.documentId ?? ''))
const document = ref<DocumentSummary | null>(null)
const loading = ref(true)
const error = ref('')

onMounted(async () => {
  try {
    document.value = await getDocument(documentId.value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '文档加载失败'
  } finally {
    loading.value = false
  }
})

const stage = computed(() =>
  document.value
    ? documentStageView(document.value.stage)
    : { label: '', tone: 'neutral' as const },
)
</script>

<template>
  <article class="page">
    <nav class="breadcrumb" aria-label="面包屑">
      <RouterLink v-if="document" :to="`/kb/${document.knowledge_base_id}`">
        返回文档列表
      </RouterLink>
      <IconChevronRight v-if="document" :size="14" />
      <span>{{ document?.name ?? '文档详情' }}</span>
    </nav>

    <PageHeader :title="document?.name ?? '文档详情'">
      <template #actions>
        <RouterLink v-if="document" :to="`/kb/${document.knowledge_base_id}`">
          <AppButton>
            <template #icon><IconRefresh /></template>
            回列表重跑
          </AppButton>
        </RouterLink>
      </template>
    </PageHeader>

    <section class="page-body">
      <p v-if="error" class="error-line">{{ error }}</p>
      <SkeletonBlock v-if="loading" variant="text" :rows="5" />

      <template v-else-if="document">
        <dl class="meta">
          <div class="meta-item">
            <dt>状态</dt>
            <dd>
              <StatusTag :label="stage.label" :tone="stage.tone" />
            </dd>
          </div>
          <div class="meta-item">
            <dt>大小</dt>
            <dd>{{ formatBytes(document.size_bytes) }}</dd>
          </div>
          <div class="meta-item">
            <dt>切块数</dt>
            <dd>{{ document.chunk_count }}</dd>
          </div>
          <div class="meta-item">
            <dt>页数</dt>
            <dd>{{ document.page_count ?? '—' }}</dd>
          </div>
          <div class="meta-item">
            <dt>来源</dt>
            <dd>{{ document.source_kind }}</dd>
          </div>
          <div class="meta-item">
            <dt>更新时间</dt>
            <dd>{{ formatDate(document.updated_at) }}</dd>
          </div>
        </dl>

        <p v-if="document.error" class="error-line">{{ document.error }}</p>

        <p v-if="document.chunk_count === 0" class="muted">
          还没有切块产物：文档尚未处理完成，或处理失败。回到列表页可以重新摄入。
        </p>
      </template>
    </section>
  </article>
</template>

<style scoped>
.page {
  max-width: var(--measure);
  margin: 0 auto;
  padding: var(--space-8) var(--page-gutter) var(--space-16);
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.page-body {
  margin-top: var(--space-6);
}

.meta {
  display: grid;
  gap: 12px 24px;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  margin: 0;
}

.meta-item dt {
  font-size: 12px;
  color: var(--text-tertiary);
}

.meta-item dd {
  margin: 2px 0 0;
  font-variant-numeric: tabular-nums;
}

.error-line {
  margin: 12px 0 0;
  color: var(--status-danger);
}

.muted {
  color: var(--text-secondary);
}
</style>
