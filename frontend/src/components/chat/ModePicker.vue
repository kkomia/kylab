<script setup lang="ts">
/**
 * 输入框那一排的「Agent 模式」四档（v0.43，开发计划 §12.225 的 P1-1）。
 *
 * 四档的枚举、顺序与语义**照抄 ZCode**（调研报告 §2.6，证据是它的枚举与 UI 字符串）：
 * `plan / build / edit / yolo`；每档一句话的文案也是它的 UI 文案直译
 * （后端同一份在 `backend/app/services/modes.py` 的 `MODE_DEFS`）。
 *
 * 为什么放在输入框这一排：模式管的是"这一轮它能不能动手"，与「执行策略」同一类
 * ——被它拦下的那一刻，用户正看着这段对话。让他先去设置页翻出这一项是这条链路上
 * 最没必要的往返（这条理由与 `ExecPolicyControl` 逐字同源，那一个控件就是这么来的）。
 *
 * **读写的是与设置页同一份**（`chat.mode`，走 `/settings` 那两个接口）：
 * 在这里另存一份是最危险的实现方式——两处的档迟早不一致，
 * 而"我明明切到全放行了，它怎么还问我"正是最难查的一类问题。
 *
 * 两点边界：
 *
 * - **取值以后端返回的候选为准**（`getChatMode` 的 `options`）：后端多出一档时照样
 *   列出来（只是没有那句人话），少了一档也不会显示一个点不动的项；
 * - **读不到就不显示这个控件**（非管理员、旧后端没有这一项、请求失败）：
 *   它是顺手的入口，不值得为它把对话页变成错误提示（同 `ExecPolicyControl`）。
 *
 * **切换只影响下一轮**：模式在服务端是"这一轮开始时读一次"（见 `services/chat.tool_loop`），
 * 所以正在跑的这一轮不会中途换档——那是刻意的，否则一轮里前几步宽松后几步严格，
 * 回看时说不清是按哪一档跑的。
 */
import { computed, onMounted, ref } from 'vue'

import { getChatMode, setChatMode } from '@/api/settings'
import IconCheck from '@/components/icons/IconCheck.vue'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import { isAdmin } from '@/composables/useSession'
import { useToast } from '@/composables/useToast'

/**
 * 每一档的短名字与那一句人话（**没有这一档就退化成后端给的展示名**）。
 *
 * 档名与取值不在这里定——那份以后端的候选为准（见文件头）。这里只配文案，
 * 所以后端换一句措辞不会让界面上的档名跟着错位。
 */
const COPY: Record<string, { label: string; hint: string }> = {
  build: { label: '构建', hint: '变更前确认：该问的照问' },
  edit: { label: '编辑', hint: '自动编辑：写东西不再逐条问' },
  plan: { label: '计划', hint: '先给计划再动手：没计划前不写东西' },
  yolo: { label: '全放行', hint: '少确认全放行：连审批也不再问' },
}

interface Entry {
  value: string
  label: string
  hint: string
}

const { notifyError, notifySuccess } = useToast()

/** `null` = 还没读到（没读到就不画，免得先显示一个错的档再跳一下）。 */
const mode = ref<string | null>(null)
const options = ref<Entry[]>([])
const saving = ref(false)

const current = computed(() => options.value.find((item) => item.value === mode.value))
const label = computed(() => current.value?.label ?? mode.value ?? '')

onMounted(async () => {
  if (!isAdmin.value) return
  try {
    const view = await getChatMode()
    if (!view.mode || view.options.length === 0) {
      // 后端没有这一项（旧版本，或者字段没登记）：**不显示**——
      // 显示了也写不动，那就是一个点了没反应的控件
      mode.value = null
      return
    }
    options.value = view.options.map((option) => ({
      value: option.value,
      label: COPY[option.value]?.label ?? option.label,
      hint: COPY[option.value]?.hint ?? '',
    }))
    mode.value = view.mode
  } catch {
    // 读不到就**不显示这个控件**：它是顺手的入口，不值得为它把对话页变成错误提示
    mode.value = null
  }
})

/**
 * 菜单里点了一项：**先收起菜单，再改配置**。
 *
 * 不把 `close()` 与 `choose()` 直接写成内联的多语句处理器：那种写法在 Vue 模板里
 * 一换行就解析不了（实测被编译器拒绝，整页白屏）——`ExecPolicyControl` 踩过同一个坑。
 */
function pick(close: () => void, value: string): void {
  close()
  void choose(value)
}

async function choose(value: string): Promise<void> {
  if (value === mode.value || saving.value) return
  saving.value = true
  try {
    const result = await setChatMode(value)
    if (result.rejected.length > 0) {
      notifyError(`这一项不被接受：${result.rejected.join('、')}`)
      return
    }
    mode.value = value
    const chosen = options.value.find((item) => item.value === value)
    notifySuccess(`Agent 模式已切到「${chosen?.label ?? value}」，下一轮生效`)
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '保存失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <RowMenu v-if="isAdmin && mode !== null" class="tool-mode" align="left" label="Agent 模式">
    <template #trigger>
      <span class="mode-text">模式·{{ label }}</span>
      <IconChevronDown :size="13" />
    </template>
    <template #default="{ close }">
      <ul class="mode-list">
        <li v-for="item in options" :key="item.value">
          <button
            type="button"
            class="mode-item"
            :disabled="saving"
            :data-mode="item.value"
            :title="item.hint"
            @click="pick(close, item.value)"
          >
            <span class="mode-mark">
              <IconCheck v-if="item.value === mode" :size="14" />
            </span>
            <span class="mode-copy">
              <span class="mode-name">{{ item.label }}</span>
              <span v-if="item.hint" class="mode-hint">{{ item.hint }}</span>
            </span>
          </button>
        </li>
      </ul>
    </template>
  </RowMenu>
</template>

<style scoped>
/* 触发器与旁边几个控件同一套尺寸（ChatView 的 `.tool` 那一族：高 `--control-height`、
   浅填充、透明描边、圆角 `--radius-row`）。这里自己写一份而不是共用那个类：
   那些类在 ChatView 的 scoped 样式里，跨组件拿不到；而"一排里两个高度"是用户
   明确报过的毛病，所以这几个值要跟着那一族走（与 `ExecPolicyControl` 同一处理）。 */
.tool-mode :deep(.menu-trigger) {
  gap: var(--space-1-5);
  min-width: 0;
  height: var(--control-height);
  padding: 0 var(--space-2);
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid transparent;
  border-radius: var(--radius-row);
}

.tool-mode :deep(.menu-trigger:hover),
.tool-mode[open] :deep(.menu-trigger) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.mode-text {
  max-width: 132px;
  overflow: hidden;
  font-size: var(--text-meta-size);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mode-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mode-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-primary);
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: var(--radius-control);
  cursor: pointer;
}

.mode-item:hover {
  background: var(--bg-hover);
}

.mode-item:disabled {
  color: var(--text-tertiary);
  cursor: not-allowed;
}

/* 勾的位置**永远占着**（没选中的那些也留一格）：否则选中项一变，整列文字会左右跳 */
.mode-mark {
  display: inline-flex;
  /* 与第一行文字对齐（这几项是两行：档名 + 那句人话） */
  padding-top: 1px;
  width: 14px;
  color: var(--accent);
}

.mode-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mode-name {
  font-weight: 500;
}

.mode-hint {
  color: var(--text-tertiary);
  font-size: var(--text-meta-size);
}
</style>
