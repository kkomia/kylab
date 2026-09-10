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
import PageShell from '@/components/ui/PageShell.vue'
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

/**
 * 尝试次数：**成功也照实显示"1 / 5"**，不再换成"一次通过"。
 *
 * 原来成功行写"一次通过"、其余写"第 N / M 次尝试"，同一列出现两种句式，
 * 列头叫「尝试」却读不出它到底是次数还是结论（评审点了这条）。
 * 统一成次数之后，这一列只有一个含义：这条任务被跑了几次、上限几次——
 * "一次就过"从 1 / 5 本身就能看出来，不必再翻译一遍。
 */
function attemptText(task: TaskSummary): string {
  return `${task.attempts} / ${task.max_attempts}`
}
</script>

<template>
  <PageShell title="任务中心">
    <template #actions>
      <StatusTag v-if="running" tone="info" label="有任务在跑，自动刷新中" />
      <AppButton @click="refresh">
        <template #icon><IconRefresh /></template>
        刷新
      </AppButton>
    </template>

    <p v-if="error" class="error-line">{{ error }}</p>
    <SkeletonBlock v-if="loading" variant="list" :rows="5" />

    <EmptyState
      v-else-if="tasks.length === 0"
      title="还没有任务"
      hint="上传文档后会在这里看到探测、解析、切分、向量化各步骤的进展。"
    />

    <template v-else>
      <div class="panel">
        <div class="panel-head list-head" aria-hidden="true">
          <span class="head-task">任务</span>
          <span class="head-status">状态</span>
          <span class="head-attempts">尝试次数</span>
          <span class="head-time">更新时间</span>
        </div>

        <ul class="task-rows">
          <li v-for="task in tasks" :key="task.id" class="task-row panel-row">
            <IconFile class="row-icon" />
            <span class="row-kind">{{ taskKindLabel(task.kind) }}</span>
            <RouterLink
              v-if="task.document_id"
              class="row-name"
              :to="`/documents/${task.document_id}`"
            >
              {{ documentName(task) }}
            </RouterLink>
            <span v-else class="row-name row-name-plain">{{ documentName(task) }}</span>

            <StatusTag
              class="row-status"
              :label="taskStateView(task.state).label"
              :tone="taskStateView(task.state).tone"
              :running="task.state === 'running'"
            />
            <span class="row-attempts">{{ attemptText(task) }}</span>
            <span class="row-time">{{ formatDate(task.updated_at) }}</span>
          </li>
        </ul>
      </div>
    </template>
  </PageShell>
</template>

<style scoped>
.error-line {
  margin: 0 0 var(--space-4);
  color: var(--status-danger);
}

/* 列头与行共用同一套列宽，数字才会真的排在一条竖轴上 */
.list-head,
.task-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

/* 表头区：底色来自 .panel-head，这里只管列宽与对齐 */
.list-head {
  padding: 0 var(--space-4);
}

/* 与任务名起点对齐：行内是图标 16px + gap，列头自己让出来 */
.head-task {
  flex: 1;
  padding-left: calc(16px + var(--space-3));
}

.head-status,
.row-status {
  flex: 0 0 96px;
}

.head-attempts {
  flex: 0 0 108px;
  text-align: right;
}

.head-time {
  flex: 0 0 120px;
  text-align: right;
}

.task-rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.task-row {
  padding: 0 var(--space-4);
}

.row-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.row-kind {
  flex: 0 0 56px;
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

/* 同样要压住 `.task-row { align-items }`，否则 align-self 不生效 */
.task-row .row-name {
  display: inline-flex;
  align-items: center;
  align-self: stretch;
  min-height: var(--hit-target);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-name-plain {
  color: var(--text-secondary);
}

.row-attempts,
.row-time {
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.row-attempts {
  flex: 0 0 108px;
  text-align: right;
}

.row-time {
  flex: 0 0 124px;
  text-align: right;
}
</style>
