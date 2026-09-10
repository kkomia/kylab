<script setup lang="ts">
/**
 * 文档详情页（《前端设计规范》§6）：面包屑 + 标题 + 状态 + 元信息行 + 切块预览。
 *
 * 预览的是**后端真实的切块文本**（`GET /documents/{id}/chunks`），按等宽排版呈现：
 * 它本来就是给检索用的原料，不是渲染好的文档。让人看见真实产物，
 * 比做一层漂亮的假渲染诚实——用户要判断"这个文件解析得对不对"，就得看到切出来的东西。
 *
 * 原文下载仍走签名 URL（架构 §6.5、开发计划 T4.5，排在 M7），所以那对按钮现在不做。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  getDocument,
  listDocumentChunks,
  type DocumentChunk,
  type DocumentSummary,
} from '@/api/documents'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import AppButton from '@/components/ui/AppButton.vue'
import PageShell from '@/components/ui/PageShell.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { documentStageView } from '@/components/ui/status'
import { formatBytes, formatDate } from '@/composables/useFormat'

/** 预览最多拉几块：再多就该去库内检索面板，而不是在这一页翻。 */
const PREVIEW_LIMIT = 5

const route = useRoute()

const documentId = computed(() => String(route.params.documentId ?? ''))
const document = ref<DocumentSummary | null>(null)
const chunks = ref<DocumentChunk[]>([])
const chunkTotal = ref(0)
const previewError = ref('')
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
  await loadPreview()
})

/** 预览是补充信息：拿不到不影响状态与元信息。 */
async function loadPreview(): Promise<void> {
  try {
    const body = await listDocumentChunks(documentId.value, PREVIEW_LIMIT)
    chunks.value = body.items
    chunkTotal.value = body.total
  } catch (cause) {
    previewError.value = cause instanceof Error ? cause.message : '切块预览加载失败'
  }
}

/** "这是前 5 块，共 137 块"——不说清的话，用户会把预览当成全文。 */
const previewNote = computed(() =>
  chunkTotal.value > chunks.value.length
    ? `该文档共 ${chunkTotal.value} 块，这里只显示前 ${chunks.value.length} 块。`
    : `该文档共 ${chunkTotal.value} 块，已全部显示。`,
)

const stage = computed(() =>
  document.value
    ? documentStageView(document.value.stage)
    : { label: '', tone: 'neutral' as const },
)
</script>

<template>
  <PageShell :title="document?.name ?? '文档详情'" narrow>
    <template #breadcrumb>
      <RouterLink
        class="breadcrumb-link"
        :to="document ? `/kb/${document.knowledge_base_id}` : '/'"
      >
        {{ document ? '文档列表' : '知识库' }}
      </RouterLink>
      <IconChevronRight class="breadcrumb-sep" :size="14" />
      <span class="breadcrumb-current">{{ document?.name ?? '文档详情' }}</span>
    </template>

    <template #actions>
      <RouterLink v-if="document" :to="`/kb/${document.knowledge_base_id}`">
        <AppButton>回列表重跑</AppButton>
      </RouterLink>
    </template>

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
      <p v-else class="muted">
        原文下载走签名 URL 接口，排在 M7；在那之前，这一页用真实切块验证解析结果，
        检索效果请回到本文档所属知识库，用「在此库检索」复核。
      </p>

      <template v-if="document.chunk_count > 0">
        <h2 class="preview-title">切块预览</h2>
        <p v-if="previewError" class="muted">{{ previewError }}</p>
        <template v-else-if="chunks.length">
          <p class="preview-note">{{ previewNote }}</p>
          <ol class="preview">
            <li v-for="chunk in chunks" :key="chunk.chunk_id" class="preview-block">
              <p class="preview-head">
                <span class="tabular">第 {{ chunk.ordinal + 1 }} 块</span>
                <template v-if="chunk.heading_path"
                  ><span class="sep">·</span>{{ chunk.heading_path }}</template
                >
                <template v-if="chunk.page !== null"
                  ><span class="sep">·</span>第 {{ chunk.page }} 页</template
                >
              </p>
              <pre class="preview-text">{{ chunk.text }}</pre>
            </li>
          </ol>
        </template>
      </template>
    </template>
  </PageShell>
</template>

<style scoped>
.breadcrumb-link {
  display: inline-flex;
  align-items: center;
  min-height: var(--hit-target);
  color: var(--text-secondary);
}

.breadcrumb-link:hover {
  color: var(--text-primary);
}

.breadcrumb-sep {
  color: var(--text-tertiary);
}

.breadcrumb-current {
  overflow: hidden;
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 元信息用一块圆角面板装起来：它是"这张纸的页眉"，不是散落的标签 */
.meta {
  display: grid;
  gap: var(--space-3) var(--space-6);
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  margin: 0;
}

/* 元信息与切块预览各装进一个圆角面板：整页不再是散落的文字 */
.meta {
  display: grid;
  gap: var(--space-4) var(--space-6);
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  margin: 0;
  padding: var(--space-4) var(--space-5);
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.meta-item dt {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.meta-item dd {
  margin: var(--space-1) 0 0;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.error-line {
  margin: var(--space-3) 0 0;
  color: var(--status-danger);
}

.muted {
  margin: var(--space-4) 0 0;
  max-width: var(--measure);
  color: var(--text-secondary);
}

/* 预览区：用大留白与元信息分开，它是"产物"，不是正文本身 */
.preview-title {
  margin: var(--space-8) 0 var(--space-3);
}

.preview-note {
  margin: 0 0 var(--space-4);
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

.preview {
  margin: 0;
  padding: 0;
  list-style: none;
}

.preview-block {
  padding: var(--space-4) var(--space-5);
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.preview-block + .preview-block {
  margin-top: var(--space-3);
}

/* 块抬头标的是"这段从哪来"，属于元信息，不该盖过正文 */
.preview-head {
  margin: 0 0 var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.preview-text {
  margin: 0;
  font-size: var(--text-meta-size);
  line-height: 1.7;
  color: var(--text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
