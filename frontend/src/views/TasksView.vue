<script setup lang="ts">
/**
 * 任务中心（《前端设计规范》§6）：文档流式列表，不是仪表盘。
 *
 * 每行一个任务：图标 + 类型 + 关联文档 + 状态 + **健康判据** + 重试次数 + 时间。
 * 有任务在跑时自动刷新——否则用户只能不停手动点刷新。
 *
 * **健康列（M7 / T7.4）不是装饰**：`running` 这个状态本身说明不了任何事——
 * 一个跑了 5 秒的和一个卡了两小时的看起来完全一样。后端按租约是否续上算出
 * "可能卡住 / 长时间未执行"，这里负责把它显示出来（§12.17 记了为什么之前漏了）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { cancelTasks, type TaskSummary } from '@/api/tasks'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconFile from '@/components/icons/IconFile.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import AppButton from '@/components/ui/AppButton.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { useToast } from '@/composables/useToast'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageShell from '@/components/ui/PageShell.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { isTaskProblem, taskHealthTone, taskKindLabel, taskStateView } from '@/components/ui/status'
import { formatDate } from '@/composables/useFormat'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'
import { useTaskStore } from '@/stores/tasks'

const POLL_INTERVAL_MS = 2000

const store = useKnowledgeBaseStore()
const taskStore = useTaskStore()
const router = useRouter()

/** 列表来自 store（可能已被预取）：有缓存时首屏直接出内容，不再闪骨架屏。 */
const tasks = computed(() => taskStore.items)
const error = computed(() => taskStore.error)
const loading = computed(() => !taskStore.loaded && taskStore.loading)
let timer: ReturnType<typeof setInterval> | null = null

/** 详情弹窗的目标。**失败原因常常是一整段**（含 URL 与 JSON 片段），
 *  塞进 `title` 属性的话鼠标一移开就没了，也没法选中复制去查。 */
const detail = ref<TaskSummary | null>(null)

// ------------------------------------------------------------------ 筛选

const kbFilter = ref('')
const stateFilter = ref('')
const healthFilter = ref('')

const KB_OPTIONS = computed(() => [
  { value: '', label: '全部知识库' },
  ...store.items.map((item) => ({ value: item.id, label: item.name })),
])

const STATE_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '排队中' },
  { value: 'running', label: '执行中' },
  { value: 'succeeded', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'canceled', label: '已取消' },
]

const HEALTH_OPTIONS = [
  { value: '', label: '全部健康' },
  { value: 'running', label: '执行中' },
  { value: 'idle', label: '排队中' },
  { value: 'stalled', label: '可能卡住' },
  { value: 'overdue', label: '长时间未执行' },
]

const hasFilter = computed(
  () => kbFilter.value !== '' || stateFilter.value !== '' || healthFilter.value !== '',
)

/** 任务量级在几百以内，筛选在客户端做：不必为它再加一版后端查询参数。 */
const visibleTasks = computed(() =>
  tasks.value.filter(
    (task) =>
      (kbFilter.value === '' || task.knowledge_base_id === kbFilter.value) &&
      (stateFilter.value === '' || task.state === stateFilter.value) &&
      (healthFilter.value === '' || task.health === healthFilter.value),
  ),
)

function clearFilters(): void {
  kbFilter.value = ''
  stateFilter.value = ''
  healthFilter.value = ''
}

const running = computed(() => taskStore.hasActive)

/** 排队中的任务数：工具栏那个"一键撤下"按钮只在真有排队时才出现。 */
const pendingCount = computed(() => tasks.value.filter((task) => task.state === 'pending').length)

const { notifySuccess, notifyError } = useToast()
const cancelOpen = ref(false)
const canceling = ref(false)

/**
 * 撤下任务。
 *
 * **逐条结果**：批量里"30 条撤下 28 条"是正常结果（有的刚好跑完了），
 * 所以按成功/失败分别报，并把第一条失败原因带出来——只报总数等于让人自己找。
 */
async function runCancel(taskIds?: string[]): Promise<void> {
  if (canceling.value) return
  canceling.value = true
  cancelOpen.value = false
  try {
    const result = await cancelTasks(taskIds ? { taskIds } : {})
    detail.value = null
    await refresh()
    if (result.failed === 0) {
      notifySuccess(`已撤下 ${result.succeeded} 个任务`)
      return
    }
    const firstError = result.items.find((item) => !item.ok)?.error
    notifyError(
      `撤下：${result.succeeded} 个成功、${result.failed} 个未撤下` +
        (firstError ? `（${firstError}）` : ''),
    )
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '取消任务失败')
  } finally {
    canceling.value = false
  }
}

/** 单个任务能否取消：只有还没结束的两种状态可以（与后端口径一致）。 */
function canCancel(task: TaskSummary | null): boolean {
  return task !== null && (task.state === 'pending' || task.state === 'running')
}

async function refresh(): Promise<void> {
  await taskStore.load()
}

onMounted(async () => {
  // 知识库下拉的选项来自 store；侧栏通常已在加载，这里**不等它**——
  // 等的代价是把任务列表的首屏拖到列表请求之后
  if (store.items.length === 0) void store.load()
  // 文档名由任务响应直接带回（document_name），这一页不再为它拉任何文档列表。
  // 已有缓存时这一句只是后台刷新，内容立刻就在
  void refresh()
  syncPolling()
})

/** 只在有任务处于排队/执行中时轮询：全静止时停表，省掉每 2 秒一次的往返。 */
function syncPolling(): void {
  if (running.value && timer === null) {
    timer = setInterval(() => {
      void refresh()
    }, POLL_INTERVAL_MS)
  } else if (!running.value && timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

watch(running, syncPolling)

onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer)
})

function documentName(task: TaskSummary): string {
  if (!task.document_id) return '—'
  // 后端解析好的名字；理论上不会为空，为空时退回 id 而不是显示空白
  return task.document_name || task.document_id
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

/** 行上是否需要招人注意：**失败**与**卡住/逾期**都要，但原因不同，所以文案分开。 */
function needsAttention(task: TaskSummary): boolean {
  return task.state === 'failed' || isTaskProblem(task.health)
}

/**
 * 行尾那句提示。失败与卡住是两回事：
 * - 失败：得看原因（详情弹窗里有）；
 * - 卡住/逾期：得看运维（重启服务、检查 worker 有没有起）。
 * 合成一句"有问题"会让人不知道该找原因还是找运维。
 */
function attentionText(task: TaskSummary): string {
  if (task.state === 'failed') return '查看失败原因'
  if (task.health === 'stalled') return '可能卡住，查看详情'
  if (task.health === 'overdue') return '长时间未执行，查看详情'
  return ''
}

/** 从详情跳去文档：先把弹窗关掉，否则返回时它还盖在页面上。 */
function openDocument(documentId: string): void {
  detail.value = null
  void router.push(`/documents/${documentId}`)
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
      <!-- 筛选：库 / 状态 / 健康。任务量级在几百以内，客户端过滤即可 -->
      <div class="toolbar">
        <div class="filter-select">
          <AppSelect v-model="kbFilter" :options="KB_OPTIONS" aria-label="按知识库筛选" />
        </div>
        <div class="filter-select">
          <AppSelect v-model="stateFilter" :options="STATE_OPTIONS" aria-label="按状态筛选" />
        </div>
        <div class="filter-select">
          <AppSelect v-model="healthFilter" :options="HEALTH_OPTIONS" aria-label="按健康筛选" />
        </div>
        <AppButton v-if="hasFilter" size="sm" variant="subtle" @click="clearFilters">
          清除筛选
        </AppButton>
        <!-- 唯一能真正"给队列踩刹车"的地方：几十条 pending 堵着时，
             逐篇取消文档是做不到的（用户反馈） -->
        <AppButton
          v-if="pendingCount > 0"
          size="sm"
          variant="subtle"
          :disabled="canceling"
          @click="cancelOpen = true"
        >
          <template #icon><IconStop /></template>
          取消排队中的任务（{{ pendingCount }}）
        </AppButton>
        <span class="toolbar-count tabular">{{ visibleTasks.length }} / {{ tasks.length }} 项</span>
      </div>

      <div class="panel">
        <div class="panel-head list-head" aria-hidden="true">
          <span class="head-task">任务</span>
          <span class="head-status">状态</span>
          <span class="head-health">健康</span>
          <span class="head-attempts">尝试次数</span>
          <span class="head-time">更新时间</span>
        </div>

        <!-- 筛选后可能为空：这不是"没有任务"，要给出与全局空态不同的文案 -->
        <p v-if="visibleTasks.length === 0" class="muted filter-empty">
          没有符合筛选条件的任务。换个条件，或点右上角「清除筛选」。
        </p>

        <ul v-else class="task-rows">
          <li v-for="task in visibleTasks" :key="task.id" class="task-row-group">
            <div class="task-row panel-row">
              <IconFile class="row-icon" />
              <span class="row-kind">{{ taskKindLabel(task.kind) }}</span>

              <!--
                整行可点是这里最要紧的交互：任务名只有十几个字宽，
                而"看失败原因"是这一页唯一的深层动作，命中区不该只有一个词那么大。
                里面是个真 button，所以 Tab 能到、回车能开（§8 键盘可达）。
              -->
              <button
                class="row-main"
                type="button"
                :aria-label="`查看任务详情：${taskKindLabel(task.kind)} ${documentName(task)}`"
                @click="detail = task"
              >
                <span class="row-name">{{ documentName(task) }}</span>
                <!--
                  招人注意的那一格：失败与卡住/逾期都要露头，而平时它完全不占视觉重量。
                  用文字而不是只靠状态色——"红点"在黑白截图里就不见了。
                -->
                <span v-if="needsAttention(task)" class="row-attention">
                  {{ attentionText(task) }}
                  <IconChevronRight :size="12" />
                </span>
              </button>

              <StatusTag
                class="row-status"
                :label="taskStateView(task.state).label"
                :tone="taskStateView(task.state).tone"
                :running="task.state === 'running'"
              />
              <!-- 健康列的文字用后端给的 label：它是判定结论，前端再翻译一遍就有两套说法。
                   终态（done）与状态列语义重复，退成弱文字；只有"需要看"的判据才配胶囊 -->
              <StatusTag
                v-if="task.health !== 'done'"
                class="row-health"
                :label="task.health_label"
                :tone="taskHealthTone(task.health)"
              />
              <span v-else class="row-health-done">{{ task.health_label }}</span>
              <span class="row-attempts">{{ attemptText(task) }}</span>
              <span class="row-time">{{ formatDate(task.updated_at) }}</span>
            </div>
          </li>
        </ul>
      </div>
    </template>

    <!--
      任务详情（M6 收集阶段收口）。
      **为什么必须有个弹窗而不是 title 属性**：失败原因常常是一整段
      （含上游 URL、错误码、JSON 片段），`title` 一移开鼠标就没了，
      也没法选中复制去查——而"拿这段去搜"正是用户下一步要做的事。
    -->
    <AppModal
      :open="detail !== null"
      title="任务详情"
      @update:open="(value: boolean) => !value && (detail = null)"
    >
      <template v-if="detail">
        <dl class="detail">
          <div>
            <dt>任务</dt>
            <dd>{{ taskKindLabel(detail.kind) }} · {{ documentName(detail) }}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{{ taskStateView(detail.state).label }}</dd>
          </div>
          <div>
            <dt>健康</dt>
            <dd>{{ detail.health_label }}</dd>
          </div>
          <div>
            <dt>尝试次数</dt>
            <dd class="tabular">{{ attemptText(detail) }}</dd>
          </div>
          <div>
            <dt>创建</dt>
            <dd>{{ formatDate(detail.created_at) }}</dd>
          </div>
          <div>
            <dt>更新</dt>
            <dd>{{ formatDate(detail.updated_at) }}</dd>
          </div>
          <div v-if="detail.lease_expires_at">
            <dt>租约到期</dt>
            <dd>{{ formatDate(detail.lease_expires_at) }}</dd>
          </div>
        </dl>

        <!-- 原因单独成块：它是这个弹窗里唯一需要**读**的东西，其余都是核对用的元数据 -->
        <template v-if="detail.error || detail.health_detail">
          <h3 class="detail-heading">
            {{ detail.state === 'failed' ? '失败原因' : '健康判据说明' }}
          </h3>
          <!-- 用户选它就是想去搜、去贴给别人看，所以这里必须是可选中的文本 -->
          <pre class="detail-error">{{ detail.error || detail.health_detail }}</pre>
        </template>

        <p class="detail-id">
          任务 ID <code>{{ detail.id }}</code
          >——排查日志时用它去搜。
        </p>
      </template>

      <template #footer>
        <AppButton @click="detail = null">关闭</AppButton>
        <AppButton
          v-if="canCancel(detail)"
          variant="danger"
          :disabled="canceling"
          @click="detail && runCancel([detail.id])"
        >
          取消这个任务
        </AppButton>
        <AppButton
          v-if="detail?.document_id"
          variant="primary"
          @click="openDocument(detail.document_id)"
        >
          打开文档
        </AppButton>
      </template>
    </AppModal>

    <!-- 批量撤下要二次确认：这是"把几十篇的处理全叫停"，点错了代价不小。
         文案里说清"文档不会被删/不会变状态"，因为那正是用户担心的 -->
    <ConfirmDialog
      v-model:open="cancelOpen"
      title="取消排队中的任务"
      :lead="`撤下 ${pendingCount} 个还在排队的任务？`"
      note="只是不再处理：文档与已入库的内容都保留。之后可以重新上传，或对文档点「重新摄入」。正在执行的任务不在范围内。"
      confirm-label="撤下"
      :busy="canceling"
      @confirm="runCancel()"
    />
  </PageShell>
</template>

<style scoped>
.error-line {
  margin: 0 0 var(--space-4);
  color: var(--status-danger);
}

/* ---- 筛选工具栏（与知识库详情页同一套形态）---- */

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.filter-select {
  flex: 0 0 148px;
}

/* 右侧计数弱一档：它是"筛出来多少"，不是动作 */
.toolbar-count {
  margin-left: auto;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.filter-empty {
  margin: var(--space-4) 0;
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
}

/* 终态健康用弱文字：与状态列重复的胶囊会让人以为它们是两个不同的结论。
   宽度与胶囊列（92px）一致，行与列头才不会错位 */
.row-health-done {
  flex: 0 0 92px;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
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
  flex: 0 0 84px;
}

/* 健康列的标签最长是"长时间未执行"（6 字 × micro 字号 ≈ 72px）+ 胶囊内边距，
   给 92px 刚好一行放下；窄了会折行，而折行会让这一列忽高忽低 */
.head-health,
.row-health {
  flex: 0 0 92px;
}

.head-attempts {
  flex: 0 0 100px;
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

.task-row-group + .task-row-group {
  border-top: 1px solid var(--border-hairline);
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

/*
 * 整行可点的那块。做成按钮而不是把 `@click` 挂在 div 上：
 * 原生 button 自带 Tab 焦点、回车/空格激活与焦点圈，而 div 三样都要自己补，
 * 补漏了键盘用户就完全够不到（§8 必须项）。
 *
 * 它必须自己撑满行高（`align-self: stretch` + `min-height`），
 * 否则命中区只有那十几个字的文字高度。
 */
.row-main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  align-self: stretch;
  flex: 1;
  min-width: 0;
  min-height: var(--hit-target);
  padding: 0 var(--space-2);
  margin: 0 calc(-1 * var(--space-2));
  text-align: left;
  border-radius: var(--radius-control);
}

.row-main:hover {
  background: var(--bg-hover);
}

/* 悬停时文件名才变成强调色：默认就是强调色的话，整页文件名的权重会盖过状态 */
.row-main:hover .row-name {
  color: var(--accent);
}

.row-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * 需要处理的那一行：给它一个可见的出口。
 * 用**文字**而不是一个红点——红点在黑白截图和色弱用户那里就消失了，
 * 而"去点哪里看原因"恰恰是最不能丢的信息。
 */
.row-attention {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-pair);
  font-size: var(--text-micro-size);
  color: var(--status-danger);
}

.row-attempts,
.row-time {
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.row-attempts {
  flex: 0 0 100px;
  text-align: right;
}

.row-time {
  flex: 0 0 120px;
  text-align: right;
}

/* ---------------- 详情弹窗 ---------------- */

/* 元数据两列：这些是"核对用"的短字段，一列排下来会占掉半屏 */
.detail {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2) var(--space-4);
  margin: 0;
}

.detail dt {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.detail dd {
  margin: var(--space-pair) 0 0;
  font-size: var(--text-meta-size);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.detail-heading {
  margin: var(--space-4) 0 var(--space-2);
  font-size: var(--text-meta-size);
  font-weight: 600;
  color: var(--text-secondary);
}

/*
 * 失败原文用 `pre` 而不是 `p`：上游回的多半是 JSON 或带换行的长串，
 * 折叠空白会把结构揉成一坨，反而更难读。
 * **等宽 + 可选中的文本**：用户选它就是想去搜、去贴给别人看。
 * 等宽不用在这里写——`base.css` 已经给了 `code, pre` 一套字体。
 */
.detail-error {
  margin: 0;
  padding: var(--space-3);
  max-height: 240px;
  overflow: auto;
  font-size: var(--text-micro-size);
  line-height: 1.7;
  color: var(--text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--bg-subtle);
  border-radius: var(--radius-panel);
}

.detail-id {
  margin: var(--space-4) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.detail-id code {
  color: var(--text-secondary);
}
</style>
