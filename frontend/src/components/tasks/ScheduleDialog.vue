<script setup lang="ts">
/**
 * 新建 / 改一条定时任务（《前端设计规范》§7 的弹窗形态）。
 *
 * **时间这块刻意不做 cron 编辑器**：那是一个要自己维护一套语法高亮与校验的控件，
 * 而真实用法里九成是"每天几点""每周几几点"。所以给**四个常见档 + 自定义**：
 * 前四档由"时间"选择器拼出 cron（拼法只有一份，就是下面那张表），
 * 自定义那一档直接把表达式交给后端校验（报错文案是后端照着"怎么改对"写的，
 * 前端再写一份解析只会多一处会漂的真相）。
 *
 * 「一次性」用 `datetime-local`：它给的字符串**不带时区**，后端按服务器本地时间解释——
 * 与界面上显示的钟点一致（时区在面板上标出来，见 SchedulePanel）。
 */
import { computed, ref, watch } from 'vue'

import type { ScheduledTask, ScheduledTaskPayload } from '@/api/schedules'
import { createScheduledTask, updateScheduledTask } from '@/api/schedules'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppMultiSelect from '@/components/ui/AppMultiSelect.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { useToast } from '@/composables/useToast'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const props = defineProps<{
  /** 编辑哪一条；null = 新建。 */
  target: ScheduledTask | null
  /** 服务器时区（面板上取的，显示在这里让人知道"9 点"是哪个 9 点）。 */
  timezone: string
}>()

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [ScheduledTask] }>()

const store = useKnowledgeBaseStore()
const { notifyError, notifySuccess } = useToast()

/** 周期档：四个常见的 + 自定义。 */
const MODES = [
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '每个工作日' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'custom', label: '自定义表达式' },
]

const WEEKDAYS = [
  { value: '1', label: '周一' },
  { value: '2', label: '周二' },
  { value: '3', label: '周三' },
  { value: '4', label: '周四' },
  { value: '5', label: '周五' },
  { value: '6', label: '周六' },
  { value: '0', label: '周日' },
]

const name = ref('')
const prompt = ref('')
const kind = ref<'cron' | 'once'>('cron')
const mode = ref('daily')
const time = ref('09:00')
const weekday = ref('1')
const dayOfMonth = ref('1')
const customCron = ref('0 9 * * *')
const runAt = ref('')
const kbIds = ref<string[]>([])
const saving = ref(false)

const kbOptions = computed(() => store.items.map((item) => ({ value: item.id, label: item.name })))

/** 四个档拼出来的表达式（**只有这一处拼**，别处不再拼第二份）。 */
const composedCron = computed(() => {
  if (mode.value === 'custom') return customCron.value.trim()
  const [hour, minute] = (time.value || '09:00').split(':')
  const m = String(Number(minute ?? 0))
  const h = String(Number(hour ?? 9))
  if (mode.value === 'weekdays') return `${m} ${h} * * 1-5`
  if (mode.value === 'weekly') return `${m} ${h} * * ${weekday.value}`
  if (mode.value === 'monthly') return `${m} ${h} ${Number(dayOfMonth.value) || 1} * *`
  return `${m} ${h} * * *`
})

const preview = computed(() => {
  if (kind.value === 'once') {
    return runAt.value ? `只跑一次：${runAt.value.replace('T', ' ')}` : '还没选时间'
  }
  const at = time.value
  if (mode.value === 'custom') return `按表达式：${composedCron.value}`
  if (mode.value === 'weekdays') return `每个工作日 ${at}`
  if (mode.value === 'weekly') {
    const label = WEEKDAYS.find((item) => item.value === weekday.value)?.label ?? '周一'
    return `每${label} ${at}`
  }
  if (mode.value === 'monthly') return `每月 ${Number(dayOfMonth.value) || 1} 号 ${at}`
  return `每天 ${at}`
})

/** 打开时按目标装载（新建则清空）。**每一次打开都重置**，免得带上一条的残留。 */
watch(open, (value) => {
  if (!value) return
  const item = props.target
  if (item) {
    name.value = item.name
    prompt.value = item.prompt
    kind.value = item.kind
    customCron.value = item.cron || '0 9 * * *'
    mode.value = item.kind === 'cron' ? guessMode(item.cron) : 'daily'
    const [minute, hour] = (item.cron || '').split(' ')
    if (/^\d+$/.test(hour ?? '') && /^\d+$/.test(minute ?? '')) {
      time.value = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    }
    const parts = (item.cron || '').split(' ')
    if (parts[4] && /^\d$/.test(parts[4])) weekday.value = parts[4]
    if (parts[2] && /^\d+$/.test(parts[2])) dayOfMonth.value = parts[2]
    runAt.value = item.run_at ? toLocalInput(item.run_at) : ''
    kbIds.value = [...item.kb_ids]
    return
  }
  name.value = ''
  prompt.value = ''
  kind.value = 'cron'
  mode.value = 'daily'
  time.value = '09:00'
  weekday.value = '1'
  dayOfMonth.value = '1'
  customCron.value = '0 9 * * *'
  runAt.value = ''
  kbIds.value = []
})

/** 把一条既有表达式认回某一档（认不出就是自定义）。 */
function guessMode(cron: string): string {
  const parts = (cron || '').split(' ')
  if (parts.length !== 5) return 'custom'
  const [, , day, month, week] = parts
  if (day === '*' && month === '*' && week === '1-5') return 'weekdays'
  if (day === '*' && month === '*' && /^\d$/.test(week)) return 'weekly'
  if (/^\d+$/.test(day) && month === '*' && week === '*') return 'monthly'
  if (day === '*' && month === '*' && week === '*') return 'daily'
  return 'custom'
}

/** 带时区的 ISO → `datetime-local` 要的本地钟点串。 */
function toLocalInput(value: string): string {
  const date = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

async function submit(): Promise<void> {
  if (saving.value) return
  const payload: ScheduledTaskPayload = {
    name: name.value.trim(),
    prompt: prompt.value.trim(),
    kind: kind.value,
    kb_ids: kbIds.value,
  }
  if (kind.value === 'once') {
    payload.run_at = runAt.value || null
  } else {
    payload.cron = composedCron.value
  }
  saving.value = true
  try {
    const saved = props.target
      ? await updateScheduledTask(props.target.id, payload)
      : await createScheduledTask(payload)
    notifySuccess(props.target ? '已保存' : '已挂上定时任务')
    emit('saved', saved)
    open.value = false
  } catch (cause) {
    // 后端那句报错是照着"怎么改对"写的（哪个字段、错在哪），直接显示它
    notifyError(cause instanceof Error ? cause.message : '没保存成功')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AppModal v-model:open="open" :title="target ? '改定时任务' : '新建定时任务'">
    <div class="form">
      <label class="field">
        <span class="label">名字</span>
        <AppInput v-model="name" placeholder="每日早报" />
      </label>

      <label class="field">
        <span class="label">到点要做什么</span>
        <AppInput
          v-model="prompt"
          multiline
          :rows="3"
          placeholder="把昨天的构建日志汇总成三条结论"
        />
        <span class="hint">这就是它每次要问的那句话，写具体一点结果更有用。</span>
      </label>

      <div class="field">
        <span class="label">什么时候跑</span>
        <div class="row">
          <div class="pick">
            <AppSelect
              v-model="kind"
              :options="[
                { value: 'cron', label: '重复' },
                { value: 'once', label: '只跑一次' },
              ]"
              aria-label="重复还是一次"
            />
          </div>
          <template v-if="kind === 'cron'">
            <div class="pick">
              <AppSelect v-model="mode" :options="MODES" aria-label="周期" />
            </div>
            <template v-if="mode !== 'custom'">
              <input v-model="time" type="time" class="native" aria-label="时间" />
            </template>
            <template v-if="mode === 'weekly'">
              <div class="pick">
                <AppSelect v-model="weekday" :options="WEEKDAYS" aria-label="周几" />
              </div>
            </template>
            <template v-if="mode === 'monthly'">
              <input
                v-model="dayOfMonth"
                type="number"
                min="1"
                max="31"
                class="native narrow"
                aria-label="几号"
              />
            </template>
          </template>
          <input v-else v-model="runAt" type="datetime-local" class="native" aria-label="时间" />
        </div>
        <AppInput
          v-if="kind === 'cron' && mode === 'custom'"
          v-model="customCron"
          placeholder="0 9 * * *"
        />
        <span class="hint"> {{ preview }} · 按服务器时区（{{ timezone }}）计算 </span>
      </div>

      <div class="field">
        <span class="label">到点查哪些知识库</span>
        <AppMultiSelect v-model="kbIds" :options="kbOptions" placeholder="不查资料" />
        <span class="hint">不选就是不查知识库，只靠模型自己的能力回答。</span>
      </div>
    </div>

    <template #footer>
      <AppButton variant="ghost" @click="open = false">取消</AppButton>
      <AppButton :disabled="saving || !name.trim() || !prompt.trim()" @click="submit">
        {{ saving ? '保存中…' : '保存' }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.label {
  font-size: 13px;
  color: var(--text-muted);
}

.hint {
  font-size: 12px;
  color: var(--text-faint);
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* 触发器宽度跟着内容走：这三个下拉一排放得下，不必各占满一行 */
.pick {
  min-width: 108px;
}

.native {
  height: var(--control-height, 32px);
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font: inherit;
}

.narrow {
  width: 72px;
}
</style>
