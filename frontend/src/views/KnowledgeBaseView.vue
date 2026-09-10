<script setup lang="ts">
/**
 * 知识库详情页：文档列表（《前端设计规范 v0.3》§6）。
 *
 * 形态：文档是"条目型"对象且会很多，用**列表**而不是卡片。
 * 每行 = 类型图标 + 名称 + 状态（文字 + 语义色）+ 时间；大文件可展开子文件树。
 *
 * 上传走"提交后轮询"：后端是异步流水线（架构 §4），界面必须能看见任务在动，
 * 否则用户会以为"点了没反应"。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import {
  listDocumentParts,
  listDocuments,
  reprocessDocument,
  uploadDocument,
  type DocumentPart,
  type DocumentSummary,
} from '@/api/documents'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconFile from '@/components/icons/IconFile.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconUpload from '@/components/icons/IconUpload.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { documentStageView } from '@/components/ui/status'
import { formatBytes, formatRelativeTime } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const POLL_INTERVAL_MS = 2000
/** 处于这些阶段的文档还在动，需要轮询刷新。 */
const ACTIVE_STAGES = new Set([
  'uploaded',
  'probing',
  'parsing',
  'parsed',
  'chunking',
  'chunked',
  'embedding',
  'enriching',
])

const route = useRoute()
const store = useKnowledgeBaseStore()
const { notifyError, notifySuccess, notifyWarning } = useToast()

const kbId = computed(() => String(route.params.kbId ?? ''))
const knowledgeBase = computed(() => store.byId(kbId.value))

const documents = ref<DocumentSummary[]>([])
const loading = ref(false)
const error = ref('')
const uploading = ref(false)
const expanded = ref<Record<string, DocumentPart[] | undefined>>({})
const fileInput = ref<HTMLInputElement | null>(null)

let timer: ReturnType<typeof setInterval> | null = null

const hasActive = computed(() =>
  documents.value.some((document) => ACTIVE_STAGES.has(document.stage)),
)

async function refresh(): Promise<void> {
  if (!kbId.value) return
  try {
    documents.value = (await listDocuments(kbId.value)).items
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '文档列表加载失败'
  }
}

async function loadFirst(): Promise<void> {
  loading.value = true
  await refresh()
  loading.value = false
}

/** 只在有活儿在跑时轮询：全绿之后停表，避免无意义的持续请求。 */
function syncPolling(): void {
  if (hasActive.value && timer === null) {
    timer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
  } else if (!hasActive.value && timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

watch(hasActive, syncPolling)
watch(kbId, () => {
  expanded.value = {}
  void loadFirst()
})

onMounted(async () => {
  if (store.items.length === 0) await store.load()
  await loadFirst()
})

onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer)
})

async function onFilesPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = '' // 允许连续上传同一个文件
  if (files.length === 0) return

  uploading.value = true
  try {
    for (const file of files) {
      const accepted = await uploadDocument(kbId.value, file)
      if (accepted.is_duplicate) {
        notifyWarning(`「${accepted.document.name}」内容与已有文档相同，已跳过重复摄入`)
      } else {
        notifySuccess(`已提交「${accepted.document.name}」，正在后台处理`)
      }
    }
    await refresh()
    syncPolling()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '上传失败')
  } finally {
    uploading.value = false
  }
}

async function toggleParts(document: DocumentSummary): Promise<void> {
  if (expanded.value[document.id]) {
    expanded.value = { ...expanded.value, [document.id]: undefined }
    return
  }
  try {
    const parts = (await listDocumentParts(document.id)).items
    expanded.value = { ...expanded.value, [document.id]: parts }
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '子文件加载失败')
  }
}

async function reprocess(document: DocumentSummary): Promise<void> {
  try {
    await reprocessDocument(document.id)
    notifySuccess(`已重新提交「${document.name}」`)
    await refresh()
    syncPolling()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '重跑失败')
  }
}

function stageOf(document: DocumentSummary) {
  return documentStageView(document.stage)
}

/** 先在模板里摊平：`@click` 里写多语句会被模板编译器拒绝（分号/换行解析不了）。 */
function onReprocessClick(close: () => void, document: DocumentSummary): void {
  close()
  void reprocess(document)
}
</script>

<template>
  <article class="page">
    <PageHeader
      :title="knowledgeBase?.name ?? '知识库'"
      :description="
        knowledgeBase
          ? `${knowledgeBase.embedding_model_id} / ${knowledgeBase.embedding_dim} 维 / 切分 ${knowledgeBase.chunk_size}、重叠 ${knowledgeBase.chunk_overlap}`
          : undefined
      "
    >
      <template #actions>
        <input
          ref="fileInput"
          class="visually-hidden"
          type="file"
          multiple
          @change="onFilesPicked"
        />
        <AppButton variant="primary" :disabled="uploading" @click="fileInput?.click()">
          <template #icon><IconUpload /></template>
          {{ uploading ? '上传中…' : '上传文档' }}
        </AppButton>
      </template>
    </PageHeader>

    <section class="page-body">
      <p v-if="error" class="error-line">{{ error }}</p>

      <SkeletonBlock v-if="loading && documents.length === 0" variant="list" :rows="4" />

      <EmptyState
        v-else-if="documents.length === 0"
        title="这个知识库里还没有文档"
        hint="支持 PDF、Office、Markdown、纯文本与图片，扫描件走 OCR 渠道；单文件上限 200MB。"
      >
        <AppButton variant="primary" @click="fileInput?.click()">
          <template #icon><IconUpload /></template>
          上传文档
        </AppButton>
      </EmptyState>

      <template v-else>
        <!-- 列头：让右侧那串数字有名字，不必靠猜 -->
        <div class="list-head" aria-hidden="true">
          <span class="head-file">文件</span>
          <span class="head-number">切块</span>
          <span class="head-size">大小</span>
          <span class="head-time">更新时间</span>
          <span class="head-menu" />
        </div>

        <ul class="doc-rows">
          <li v-for="document in documents" :key="document.id" class="doc-row-group">
            <div class="doc-row">
              <button
                v-if="document.is_split"
                class="expander"
                type="button"
                :aria-label="expanded[document.id] ? '收起子文件' : '展开子文件'"
                :aria-expanded="Boolean(expanded[document.id])"
                @click="toggleParts(document)"
              >
                <IconChevronDown v-if="expanded[document.id]" />
                <IconChevronRight v-else />
              </button>
              <span v-else class="expander-placeholder" />

              <IconFile class="row-icon" />

              <span class="row-main">
                <RouterLink class="row-name" :to="`/documents/${document.id}`">
                  {{ document.name }}
                </RouterLink>
                <StatusTag
                  :label="stageOf(document).label"
                  :tone="stageOf(document).tone"
                  :running="ACTIVE_STAGES.has(document.stage)"
                  :title="document.error ?? undefined"
                />
              </span>

              <span class="row-number">{{ document.chunk_count }}</span>
              <span class="row-size">{{ formatBytes(document.size_bytes) }}</span>
              <span class="row-time">{{ formatRelativeTime(document.updated_at) }}</span>

              <RowMenu v-slot="{ close }" class="row-menu">
                <button type="button" @click="onReprocessClick(close, document)">
                  <IconRefresh :size="14" /> 重新摄入
                </button>
              </RowMenu>
            </div>

            <p v-if="document.error" class="row-error">{{ document.error }}</p>

            <ul v-if="expanded[document.id]?.length" class="part-rows">
              <li v-for="part in expanded[document.id]" :key="part.id" class="part-row">
                <span class="part-name">分片 P{{ part.part_index + 1 }}</span>
                <span class="part-pages">第 {{ part.page_start }}–{{ part.page_end }} 页</span>
                <StatusTag
                  :label="documentStageView(part.stage).label"
                  :tone="documentStageView(part.stage).tone"
                />
              </li>
            </ul>
          </li>
        </ul>
      </template>
    </section>
  </article>
</template>

<style scoped>
.page {
  max-width: 1040px;
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

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* 列头与行共用同一套列宽，数字才会真的排在一条竖轴上 */
.list-head,
.doc-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.list-head {
  height: var(--row-height-compact);
  padding-right: var(--space-8);
  font-size: 12px;
  color: var(--text-tertiary);
  border-bottom: 1px solid var(--border);
}

.head-file {
  flex: 1;
}

.head-number {
  flex: 0 0 56px;
  text-align: right;
}

.head-size {
  flex: 0 0 72px;
  text-align: right;
}

.head-time {
  flex: 0 0 96px;
  text-align: right;
}

.head-menu {
  flex: 0 0 24px;
}

.doc-rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.doc-row {
  min-height: var(--row-height);
  padding-right: var(--space-2);
  border-bottom: 1px solid var(--border-hairline);
}

.doc-row:hover {
  background: var(--bg-hover);
}

.expander,
.expander-placeholder {
  display: inline-flex;
  flex: 0 0 20px;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
}

.expander:hover {
  background: var(--bg-active);
  color: var(--text-primary);
}

.row-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

/* 文件名与状态同处一列：状态跟着文件走，而不是飘在右边的孤立列 */
.row-main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
}

.row-name {
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 数字列：等宽 + 右对齐，沿一条竖轴排下来 */
.row-number {
  flex: 0 0 56px;
  text-align: right;
  font-size: 13px;
  color: var(--text-secondary);
}

.row-size {
  flex: 0 0 72px;
  text-align: right;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.row-time {
  flex: 0 0 96px;
  text-align: right;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.row-menu {
  flex: 0 0 24px;
}

.row-error {
  margin: 0;
  padding: 0 0 var(--space-2) 52px;
  font-size: 12.5px;
  color: var(--status-danger);
}

/* 子文件树：缩进一级（§6） */
.part-rows {
  margin: 0;
  padding: 0 0 var(--space-2) 52px;
  list-style: none;
}

.part-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: var(--row-height-compact);
  font-size: 13px;
  color: var(--text-secondary);
}

.part-name {
  color: var(--text-primary);
}

.part-pages {
  color: var(--text-tertiary);
}
</style>
