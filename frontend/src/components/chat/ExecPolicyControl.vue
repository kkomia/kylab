<script setup lang="ts">
/**
 * 输入框那一排的「执行策略」（v0.41，用户报的第 6 条）。
 *
 * 为什么把它从设置页搬到输入框旁边：被拦下的那一刻，用户正看着这段对话——
 * 让他先去「能力 → 沙箱执行」翻出那一项、改完再问一遍，是这条链路上最没必要的往返。
 * 而这一项恰恰是"改完立刻能感觉到差别"的那种设置（下一个动作就会被问/不被问）。
 *
 * **读写的是与设置页同一份**（`sandbox.exec_policy`，走 `/settings` 那两个接口）：
 * 在这里另存一份是最危险的实现方式——两处显示的档位迟早不一致，
 * 而"我明明改成允许了，它怎么还拦"正是最难查的一类问题（数据只有一份，
 * 这里只是它的另一个门）。
 *
 * 只引导三档（allow / ask / deny）：`sandbox` 是四档里更早的写法，仍然认，
 * 但不在这里引导去选。当前值不在三档里时**照原样显示**，不假装它是别的东西。
 *
 * 非管理员**不显示**：它背后是管理员端点（与执行命令同一档），
 * 摆在成员眼前只会让他点了拿到 403。
 */
import { computed, onMounted, ref } from 'vue'

import { getSettings, updateSettings } from '@/api/settings'
import IconCheck from '@/components/icons/IconCheck.vue'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import { isAdmin } from '@/composables/useSession'
import { useToast } from '@/composables/useToast'

/** 后端 `sandbox.exec_policy` 的键。**不另起名字**：改的就是设置页那一项。 */
const KEY = 'sandbox.exec_policy'

const POLICIES: { value: string; label: string; hint: string }[] = [
  { value: 'allow', label: '允许', hint: '直接执行，不再问你' },
  { value: 'ask', label: '需确认', hint: '每次执行前问你一下' },
  { value: 'deny', label: '拒绝', hint: '一律不执行' },
]

const { notifyError, notifySuccess } = useToast()

/** `null` = 还没读到（没读到就不画，免得先显示一个错的档再跳一下）。 */
const mode = ref<string | null>(null)
const saving = ref(false)

const label = computed(() => {
  const found = POLICIES.find((item) => item.value === mode.value)
  return found ? found.label : (mode.value ?? '')
})

onMounted(async () => {
  if (!isAdmin.value) return
  try {
    const view = await getSettings()
    const field = view.groups
      .find((group) => group.key === 'sandbox')
      ?.fields.find((item) => item.key === KEY)
    mode.value = field?.value ?? null
  } catch {
    // 读不到就**不显示这个控件**：它是顺手的入口，不值得为它把对话页变成错误提示
    mode.value = null
  }
})

/**
 * 菜单里点了一项：**先收起菜单，再改配置**。
 *
 * 不把 `close()` 与 `choose()` 直接写成内联的多语句处理器：那种写法在 Vue 模板里
 * 一换行就解析不了（实测被编译器拒绝，整页白屏）。收进函数还顺手说清了顺序。
 */
function pick(close: () => void, value: string): void {
  close()
  void choose(value)
}

async function choose(value: string): Promise<void> {
  if (value === mode.value || saving.value) return
  saving.value = true
  try {
    const result = await updateSettings([{ key: KEY, value }])
    if (result.rejected.length > 0) {
      notifyError(`这一项不被接受：${result.rejected.join('、')}`)
      return
    }
    mode.value = value
    notifySuccess(`执行策略已改成「${label.value}」，下一个动作就生效`)
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '保存失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <RowMenu v-if="isAdmin && mode !== null" class="tool-policy" align="left" label="执行策略">
    <template #trigger>
      <span class="policy-text">执行·{{ label }}</span>
      <IconChevronDown :size="13" />
    </template>
    <template #default="{ close }">
      <ul class="policy-list">
        <li v-for="item in POLICIES" :key="item.value">
          <button
            type="button"
            class="policy-item"
            :disabled="saving"
            :title="item.hint"
            @click="pick(close, item.value)"
          >
            <span class="policy-mark">
              <IconCheck v-if="item.value === mode" :size="14" />
            </span>
            <span>{{ item.label }}</span>
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
   明确报过的毛病，所以这几个值要跟着那一族走。 */
.tool-policy :deep(.menu-trigger) {
  gap: var(--space-1-5);
  min-width: 0;
  height: var(--control-height);
  padding: 0 var(--space-2);
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid transparent;
  border-radius: var(--radius-row);
}

.tool-policy :deep(.menu-trigger:hover),
.tool-policy[open] :deep(.menu-trigger) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.policy-text {
  max-width: 132px;
  overflow: hidden;
  font-size: var(--text-meta-size);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.policy-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.policy-item {
  display: flex;
  align-items: center;
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

.policy-item:hover {
  background: var(--bg-hover);
}

.policy-item:disabled {
  color: var(--text-tertiary);
  cursor: not-allowed;
}

/* 勾的位置**永远占着**（没选中的那些也留一格）：否则选中项一变，整列文字会左右跳 */
.policy-mark {
  display: inline-flex;
  width: 14px;
  color: var(--accent);
}
</style>
