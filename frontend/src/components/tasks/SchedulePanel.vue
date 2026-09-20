<script setup lang="ts">
/**
 * 定时任务这一块（v0.33）：挂在任务中心里的一个分段。
 *
 * **为什么和"正在跑的任务"同一页**：它们是同一件事的两个时间态——
 * "到点要跑的事"与"正在跑的事"。分成两页会让"我那个定时任务跑了吗"
 * 变成要跳页找的问题；而每次运行的结果本来就是一条会话记录（点进去看）。
 *
 * 三条刻意的设计：
 *
 * 1. **时区必须显示**：cron 按服务器时区解释（后端回 `timezone`），
 *    不写出来"每天 9 点"是哪个 9 点就只能靠猜——而猜错的代价是它在你睡觉时跑；
 * 2. **上一轮的结果要能一眼看出**：`ok` / `degraded`（跑完了但没跑完）/
 *    `failed` 三种状态分开显示，第三种带原因；
 * 3. **「立即跑一次」是主要的确认手段**：挂完一条"每天 9 点"的任务，
 *    最想确认的是"它会跑成什么样"，等到明天早上才知道太晚了。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import {
  deleteScheduledTask,
  listScheduledTasks,
  runScheduledTaskNow,
  updateScheduledTask,
  type ScheduledTask,
} from '@/api/schedules'
import IconClock from '@/components/icons/IconClock.vue'
import IconEdit from '@/components/icons/IconEdit.vue'
import IconPlus from '@/components/icons/IconPlus.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import ScheduleDialog from '@/components/tasks/ScheduleDialog.vue'
import AppButton from '@/components/ui/AppButton.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag, { type StatusTone } from '@/components/ui/StatusTag.vue'
import { useToast } from '@/composables/useToast'
import { formatDate } from '@/composables/useFormat'

const router = useRouter()
const { notifyError, notifySuccess } = useToast()

const items = ref<ScheduledTask[]>([])
const timezone = ref('')
const loading = ref(true)
const error = ref('')
const busyId = ref('')

const dialogOpen = ref(false)
const editing = ref<ScheduledTask | null>(null)
const removing = ref<ScheduledTask | null>(null)
const removing_busy = ref(false)

/** 确认框的开合：跟着 `removing` 走（删完或取消就归空）。 */
const removeOpen = computed({
  get: () => removing.value !== null,
  set: (value: boolean) => {
    if (!value) removing.value = null
  },
})

const empty = computed(() => !loading.value && items.value.length === 0)

async function refresh(): Promise<void> {
  loading.value = items.value.length === 0
  try {
    const payload = await listScheduledTasks()
    items.value = payload.items
    timezone.value = payload.timezone
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读不到定时任务'
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

function openCreate(): void {
  editing.value = null
  dialogOpen.value = true
}

function openEdit(item: ScheduledTask): void {
  editing.value = item
  dialogOpen.value = true
}

/** 跑一次只是入队：立刻返回，真正的问答在 worker 里跑（结果落进那条会话）。 */
async function runNow(item: ScheduledTask): Promise<void> {
  if (busyId.value) return
  busyId.value = item.id
  try {
    await runScheduledTaskNow(item.id)
    notifySuccess('已经排上队，跑完的结果会落在这条任务的会话里')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '没能排上队')
  } finally {
    busyId.value = ''
  }
}

async function toggle(item: ScheduledTask): Promise<void> {
  if (busyId.value) return
  busyId.value = item.id
  try {
    await updateScheduledTask(item.id, { enabled: !item.enabled })
    await refresh()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '没能改')
  } finally {
    busyId.value = ''
  }
}

async function remove(): Promise<void> {
  const target = removing.value
  if (!target || removing_busy.value) return
  removing_busy.value = true
  try {
    await deleteScheduledTask(target.id)
    removing.value = null
    await refresh()
    notifySuccess('已删除（它跑出来的会话还在）')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '删不掉')
  } finally {
    removing_busy.value = false
  }
}

function openConversation(item: ScheduledTask): void {
  if (!item.conversation_id) return
  void router.push(`/chat/${item.conversation_id}`)
}

/** 上一次运行的结论：三种状态分开说（"跑完了但没跑完"既不是成功也不是失败）。 */
function lastRunTone(item: ScheduledTask): StatusTone {
  if (item.last_status === 'ok') return 'success'
  if (item.last_status === 'degraded') return 'warning'
  if (item.last_status === 'failed') return 'danger'
  return 'neutral'
}

function lastRunText(item: ScheduledTask): string {
  if (!item.last_run_at) return '还没跑过'
  const when = formatDate(item.last_run_at)
  if (item.last_status === 'ok') return `上次跑成了（${when}）`
  if (item.last_status === 'degraded') return `上次没跑完（${when}）`
  if (item.last_status === 'failed') return `上次失败（${when}）`
  return `上次运行：${when}`
}

function nextRunText(item: ScheduledTask): string {
  if (!item.enabled) return '已停用'
  if (!item.next_run_at) return '不会再跑'
  return `下次 ${formatDate(item.next_run_at)}`
}
</script>

<template>
  <div class="panel">
    <div class="head">
      <p class="intro">
        到点自动跑一句话，结果落在一条同名会话里。
        <span v-if="timezone" class="tz">时间按服务器时区（{{ timezone }}）计算</span>
      </p>
      <div class="head-actions">
        <AppButton size="sm" @click="refresh">
          <template #icon><IconRefresh /></template>
          刷新
        </AppButton>
        <AppButton size="sm" variant="primary" @click="openCreate">
          <template #icon><IconPlus /></template>
          新建
        </AppButton>
      </div>
    </div>

    <p v-if="error" class="error-line">{{ error }}</p>
    <SkeletonBlock v-if="loading" variant="list" :rows="3" />

    <EmptyState
      v-else-if="empty"
      title="还没有定时任务"
      hint="比如「每天 9 点把昨天的构建日志汇总成三条结论」——挂上之后到点它自己跑，结果留在会话里。"
    />

    <ul v-else class="list">
      <li v-for="item in items" :key="item.id" class="row" :class="{ off: !item.enabled }">
        <span class="icon"><IconClock :size="15" /></span>
        <div class="body">
          <div class="line-1">
            <span class="name">{{ item.name }}</span>
            <StatusTag :tone="lastRunTone(item)" :label="lastRunText(item)" />
            <span v-if="item.run_count" class="runs tabular">跑过 {{ item.run_count }} 次</span>
          </div>
          <p class="prompt">{{ item.prompt }}</p>
          <div class="line-3">
            <span class="when">{{ item.schedule_text }}</span>
            <span class="dot">·</span>
            <span class="next">{{ nextRunText(item) }}</span>
            <template v-if="item.last_status === 'failed' && item.last_error">
              <span class="dot">·</span>
              <span class="err">{{ item.last_error }}</span>
            </template>
          </div>
        </div>
        <div class="actions">
          <AppButton size="sm" variant="ghost" :disabled="busyId === item.id" @click="runNow(item)">
            立即跑一次
          </AppButton>
          <AppButton
            v-if="item.conversation_id"
            size="sm"
            variant="ghost"
            @click="openConversation(item)"
          >
            看结果
          </AppButton>
          <AppButton size="sm" variant="ghost" @click="toggle(item)">
            {{ item.enabled ? '停用' : '启用' }}
          </AppButton>
          <AppButton size="sm" variant="ghost" aria-label="改" @click="openEdit(item)">
            <template #icon><IconEdit :size="14" /></template>
          </AppButton>
          <AppButton size="sm" variant="ghost" aria-label="删" @click="removing = item">
            <template #icon><IconTrash :size="14" /></template>
          </AppButton>
        </div>
      </li>
    </ul>

    <ScheduleDialog
      v-model:open="dialogOpen"
      :target="editing"
      :timezone="timezone"
      @saved="refresh"
    />

    <ConfirmDialog
      v-model:open="removeOpen"
      title="删除这条定时任务？"
      :lead="`「${removing?.name ?? ''}」不会再跑了。`"
      note="它已经跑出来的会话不会被删——那是它替你问过的内容。"
      confirm-label="删除"
      :busy="removing_busy"
      @confirm="remove"
    />
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.intro {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}

.tz {
  color: var(--text-faint);
}

.head-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.row.off {
  opacity: 0.66;
}

.icon {
  color: var(--text-faint);
  padding-top: 2px;
}

.body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.line-1 {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.name {
  font-weight: 600;
}

.runs {
  font-size: 12px;
  color: var(--text-faint);
}

.prompt {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
  /* 一句话说明它到点做什么：长了就截断，完整内容在「改」里 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.line-3 {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-faint);
}

.dot {
  opacity: 0.5;
}

.err {
  color: var(--danger, #c0392b);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 420px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.error-line {
  margin: 0;
  color: var(--danger, #c0392b);
  font-size: 13px;
}
</style>
