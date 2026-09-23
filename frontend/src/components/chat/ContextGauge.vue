<script setup lang="ts">
/**
 * 上下文仪表（P1-3，开发计划 §12.225）。
 *
 * 抄的是 ZCode 的 `chat.contextUsage.breakdown`：输入框旁边给一个**能核对**的读数
 * ——「上下文已用 X / Y」，点开看到**按来源分解**（消息 / 系统提示词 / 技能目录 /
 * 工具定义 / 记忆与人设 / 其它）。
 *
 * 为什么值得摆这么一个东西：用户看到的是"它怎么变笨了、怎么变慢了"，
 * 而能回答那句话的往往就是一句"上下文里 60% 是技能目录"。按来源分解比一个百分比
 * 有用得多——它同时让"装了多少技能、给了多少工具"第一次变得可核对。
 *
 * 三条纪律：
 *
 * 1. **数字全部来自接口**（`GET /chat/context-usage`）：`used` / `total` /
 *    `share` 一个都不在这里算。估算口径（中日韩 1 字≈1 token、其余 4 字符≈1）
 *    在服务端那一处，界面再算一遍必然分叉——而仪表上最忌讳的正是
 *    "分解条加起来不等于总数"。
 * 2. **只读**：调它不会触发压缩，所以随时可以刷新（压缩是那个按钮的事）。
 * 3. **是估算就说出来**：`estimated` 与后端的 `note` 原样显示，
 *    不把估算画成账单。
 *
 * 压缩走**既有那条链路**（`/compact` 命令 → 服务端 `ChatService.compact`），
 * 所以这里只 emit 一个事件、由 ChatView 发出那条命令——压缩的语义（要不要模型、
 * 压完之后怎么记账）全在后端一处，界面不另造一套。
 */
import { computed, ref, watch } from 'vue'

import { getContextUsage, type ContextUsage } from '@/api/chat'
import IconAlert from '@/components/icons/IconAlert.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import { formatCount } from '@/composables/useFormat'

const props = defineProps<{
  /** 算哪条会话的上下文。没会话（新对话）时不显示——那时还没有上下文这回事。 */
  conversationId: string | null
}>()

const emit = defineEmits<{ compress: [] }>()

const usage = ref<ContextUsage | null>(null)
const loading = ref(false)
/** 读不到时的原因（前端不编一个数出来，也不悄悄显示 0）。 */
const error = ref('')

/**
 * token 数的显示走 `useFormat` 的**千分位**（`formatCount`），与用量页同一套口径：
 * 这些数动辄五位数，不分位读不出量级——而"还剩多少、离压缩还有多远"
 * 正是看着这组数字时要回答的问题。
 */
const formatTokens = formatCount

const label = computed(() => {
  if (!props.conversationId) return ''
  if (error.value) return '上下文读数不可用'
  if (!usage.value) return loading.value ? '正在读上下文…' : '上下文未知'
  return `上下文已用 ${formatTokens(usage.value.used)} / ${formatTokens(usage.value.total)}`
})

/** 已用占比（**接口给的 ratio**，不自己除）。 */
const ratioPercent = computed(() =>
  usage.value ? Math.round(Math.min(1, Math.max(0, usage.value.ratio)) * 100) : 0,
)

async function refresh(): Promise<void> {
  const id = props.conversationId
  if (!id) return
  loading.value = true
  try {
    const result = await getContextUsage(id)
    // 取的这一路上用户可能又换会话了：别把旧的读数盖到新的那条上
    if (props.conversationId !== id) return
    usage.value = result
    error.value = ''
  } catch (cause) {
    if (props.conversationId !== id) return
    error.value = cause instanceof Error ? cause.message : '上下文用量读不到'
    usage.value = null
  } finally {
    if (props.conversationId === id) loading.value = false
  }
}

// 切会话就重新读一次；没有会话（新对话）时清空，免得留着上一条会话的读数
watch(
  () => props.conversationId,
  (id) => {
    usage.value = null
    error.value = ''
    if (id) void refresh()
  },
  { immediate: true },
)

defineExpose({ refresh })
</script>

<template>
  <RowMenu v-if="conversationId" class="gauge" align="right" label="上下文用量">
    <template #trigger>
      <!-- 点开就顺手刷一次：用户点它正是想问"现在占了多少" -->
      <span class="gauge-text" @click="refresh">
        <span class="gauge-value tabular">{{ label }}</span>
        <span class="gauge-meter" aria-hidden="true">
          <span class="gauge-meter-fill" :style="{ width: `${ratioPercent}%` }" />
        </span>
      </span>
    </template>

    <div class="gauge-panel">
      <template v-if="usage">
        <p class="gauge-head">
          已用 {{ formatTokens(usage.used) }} / {{ formatTokens(usage.total) }} tokens
          <span class="gauge-share">（{{ ratioPercent }}%）</span>
        </p>
        <!-- 按来源分解：**label 用后端给的中文**（口径在服务端，界面不翻译 kind） -->
        <ul class="gauge-list">
          <li v-for="part in usage.items" :key="part.kind" class="gauge-item">
            <span class="gauge-item-label">{{ part.label }}</span>
            <span class="gauge-item-tokens tabular">{{ formatTokens(part.tokens) }}</span>
            <span class="gauge-item-bar" aria-hidden="true">
              <span
                class="gauge-item-bar-fill"
                :style="{ width: `${Math.round(part.share * 100)}%` }"
              />
            </span>
          </li>
          <!-- 分解可能还不如总数大（框架开销那一项）——差额如实说，不藏 -->
          <li v-if="!usage.items.length" class="gauge-note">这一轮还没有可分解的内容。</li>
        </ul>
        <p v-if="usage.compress_at > 0" class="gauge-note">
          到 {{ formatTokens(usage.compress_at) }} 会自动压缩（先剪旧工具结果，再摘要）。
        </p>
        <p v-if="usage.estimated && usage.note" class="gauge-note">{{ usage.note }}</p>
      </template>
      <p v-else-if="error" class="gauge-note gauge-note-bad">
        <IconAlert :size="14" />
        {{ error }}
      </p>
      <p v-else class="gauge-note">正在读上下文用量…</p>

      <button type="button" class="gauge-compress" @click="emit('compress')">
        压缩上下文（/compact）
      </button>
    </div>
  </RowMenu>
</template>

<style scoped>
.gauge-text {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  cursor: pointer;
}

.gauge-value {
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

/* 一圈很细的占用条：它替掉"再去点开看一眼"的那一步 */
.gauge-meter {
  display: inline-block;
  width: 28px;
  height: 4px;
  overflow: hidden;
  background: var(--bg-active);
  border-radius: 2px;
}

.gauge-meter-fill {
  display: block;
  height: 100%;
  background: var(--text-tertiary);
}

.gauge-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  min-width: 240px;
  padding: var(--space-1) var(--space-1);
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
}

.gauge-head {
  margin: 0;
  color: var(--text-primary);
}

.gauge-share {
  color: var(--text-tertiary);
}

.gauge-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.gauge-item {
  display: grid;
  grid-template-columns: 1fr auto 64px;
  align-items: center;
  gap: var(--space-2);
}

.gauge-item-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gauge-item-tokens {
  color: var(--text-tertiary);
}

.gauge-item-bar {
  height: 4px;
  overflow: hidden;
  background: var(--bg-active);
  border-radius: 2px;
}

.gauge-item-bar-fill {
  display: block;
  height: 100%;
  background: var(--accent, var(--text-secondary));
}

.gauge-note {
  display: flex;
  gap: var(--space-1);
  margin: 0;
  color: var(--text-quaternary);
  line-height: 1.5;
}

.gauge-note-bad {
  color: var(--status-danger);
}

.gauge-compress {
  justify-content: center;
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  min-height: var(--menu-item-height);
}
</style>
