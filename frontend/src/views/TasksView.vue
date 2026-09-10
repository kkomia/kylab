<script setup lang="ts">
/**
 * 任务中心（《前端设计规范 v0.3》§6）：文档流式列表，不是仪表盘。
 *
 * 每行一个任务：图标 + 类型 + 关联文档 + 状态 + 重试次数 + 时间。
 * 有任务在跑时自动刷新——否则用户只能不停手动点刷新。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { listDocuments, type DocumentSummary } from '@/api/documents'
import { listTasks, type TaskSummary } from '@/api/tasks'
import IconFile from '@/components/icons/IconFile.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { taskKindLabel, taskStateView } from '@/components/ui/status'
import { formatDate } from '@/composables/useFormat'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const POLL_INTERVAL_MS = 2000

const store = useKnowledgeBaseStore()
const tasks = ref<TaskSummary[]>([])
const documents = ref<Record<string, string>>({})
const loading = ref(true)
const error = ref('')
let timer: ReturnType<typeof setInterval> | null = null

const running = computed(() =>
  tasks.value.some((task) => task.state === 'pending' || task.state === 'running'),
)

/** 任务只带 document_id，标题得从文档侧补；每个库一次请求，不发逐文档的 N+1 请求。 */
async function loadDocumentNames(): Promise<void> {
  try {
    if (store.items.length === 0) await store.load()
    const rows: DocumentSummary[] = []
    for (const kb of store.items) {
      rows.push(...(await listDocuments(kb.id)).items)
    }
    documents.value = Object.fromEntries(rows.map((row) => [row.id, row.name]))
  } catch {
    // 文档名只是锦上添花：拿不到就退化成显示 ID，不影响任务本身的可见性
  }
}

async function refresh(): Promise<void> {
  try {
    tasks.value = (await listTasks()).items
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '任务列表加载失败'
  }
}

onMounted(async () => {
  await Promise.all([refresh(), loadDocumentNames()])
  loading.value = false
  timer = setInterval(() => {
    void refresh()
  }, POLL_INTERVAL_MS)
})

onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer)
})

function documentName(task: TaskSummary): string {
  if (!task.document_id) return '—'
  return documents.value[task.document_id] ?? task.document_id
}

/** 进度：用"第几次尝试 / 上限"表达，比假进度条诚实（架构 §12）。 */
function attemptText(task: TaskSummary): string {
  if (task.state === 'succeeded') return '一次通过'
  return `第 ${task.attempts} / ${task.max_attempts} 次尝试`
}
</script>

<template>
  <article class="page">
    <PageHeader
      title="任务中心"
      description="摄入流水线的每一步都会在这里留下记录；失败任务按指数退避自动重试。"
    >
      <template #actions>
        <StatusTag v-if="running" tone="info" label="有任务在跑，自动刷新中" />
        <AppButton @click="refresh">
          <template #icon><IconRefresh /></template>
          刷新
        </AppButton>
      </template>
    </PageHeader>

    <section class="page-body">
      <p v-if="error" class="error-line">{{ error }}</p>
      <SkeletonBlock v-if="loading" variant="list" :rows="5" />

      <EmptyState
        v-else-if="tasks.length === 0"
        title="还没有任务"
        hint="上传文档后会在这里看到探测、解析、切分、向量化各步骤的进展。"
      />

      <ul v-else class="task-rows">
        <li v-for="task in tasks" :key="task.id" class="task-row">
          <IconFile class="row-icon" />
          <span class="row-kind">{{ taskKindLabel(task.kind) }}</span>
          <RouterLink
            v-if="task.document_id"
            class="row-name"
            :to="`/documents/${task.document_id}`"
          >
            {{ documentName(task) }}
          </RouterLink>
          <span v-else class="row-name">{{ documentName(task) }}</span>

          <StatusTag
            class="row-status"
            :label="taskStateView(task.state).label"
            :tone="taskStateView(task.state).tone"
          />
          <span class="row-attempts">{{ attemptText(task) }}</span>
          <span class="row-time">{{ formatDate(task.updated_at) }}</span>
        </li>
      </ul>
    </section>
  </article>
</template>

<style scoped>
.page {
  max-width: 1100px;
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

.task-rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.task-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--row-height);
  border-bottom: 1px solid var(--border);
}

.task-row:hover {
  background: var(--bg-hover);
}

.row-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.row-kind {
  flex: 0 0 64px;
  font-size: 13px;
  color: var(--text-secondary);
}

.row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-status {
  flex: 0 0 auto;
  width: 84px;
}

.row-attempts,
.row-time {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.row-attempts {
  width: 112px;
}

.row-time {
  width: 128px;
  text-align: right;
}
</style>
