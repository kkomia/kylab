<script setup lang="ts">
/**
 * 「这条命令要执行，你同意吗」——输入框上方那一条（v0.41）。
 *
 * 为什么是**一条确认条**而不是弹窗：后端此刻停在等待上（见 `services/approvals.py`），
 * 用户要做的是"看一眼命令、点一下"，而不是被打断去处理一个模态框——
 * 弹窗还会把对话内容整块盖住，而他要核对的恰恰是"这条命令配不配得上刚才那句话"。
 *
 * 三个按钮对应后端 `ChatApprovalIn` 的三个取值，一个不多：
 * **允许一次**（就这一次）、**这类都允许**（顺手写进放行清单，之后不再问）、
 * **拒绝**（不执行）。第二个必须把要写下的那行规则**先摆出来**——
 * 不摆就是让用户盲签一张"以后都放行"的空白支票。
 *
 * **拒绝理由（P2-1，照 ZCode）**：拒绝时能补一句给模型的话（可空）。
 * 这一句的价值在下一轮：只有"被拒了"，模型多半换个说法再试一次同一条命令；
 * 带上"为什么不行"，它才知道该往哪走。所以输入框就摆在这一条上——
 * 藏进二次确认会让"想说话的用户"少一条路（而他要说的话正是最省事的那种纠偏）。
 *
 * 决定**自己 POST**（与 `SettingGroupPanel` 同一个取舍：这个组件只做一件事，
 * 让调用方喂数据会变成"每个宿主都要记得替它发请求"）。点完立刻 `settled`，
 * 让宿主把确认条收起来：**POST 失败时也要收**——后端那一头等的是它自己的超时，
 * 摆着一条点不动的确认只会让人以为还有机会。
 */
import { computed, ref } from 'vue'

import { decideApproval, type ApprovalDecision, type ChatApproval } from '@/api/chat'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import { useToast } from '@/composables/useToast'

const props = defineProps<{
  approval: ChatApproval
}>()

const emit = defineEmits<{ settled: [] }>()

const { notifyError } = useToast()

const busy = ref(false)

/**
 * 用户写的拒绝理由（P2-1）。**只跟着「拒绝」发出去**：
 * 在"允许"上捎一句"顺便提一下"，回灌给模型的话是另一回事（见 `_with_reason`）——
 * 把两种意图混成一句，模型下一轮就会读错。
 */
const reason = ref('')

/** 「这类都允许」会写下的那行规则：后端没给（老版本事件）时不摆这句话。 */
const rule = computed(() => props.approval.rule.trim())

/** 等多久算没有回应。0 = 后端没给（老版本事件），那就不摆这句话。 */
const waitHint = computed(() => {
  const seconds = Math.round(props.approval.timeout_seconds)
  return seconds > 0 ? `${seconds} 秒内不回应，这一轮会按「拒绝」继续` : ''
})

async function decide(decision: ApprovalDecision): Promise<void> {
  if (busy.value) return
  busy.value = true
  const text = reason.value.trim()
  try {
    // **没写理由时调用形状与以前逐字相同**（两个参数）：这样"不填"那条路上
    // 请求体一个字都不变（后端也有对应用例钉着）
    if (decision === 'deny' && text) {
      await decideApproval(props.approval.approval_id, decision, text)
    } else {
      await decideApproval(props.approval.approval_id, decision)
    }
  } catch (cause) {
    // 409（已经超时/点过一次）也走这里：**如实说**，不谎报"已执行"
    notifyError(cause instanceof Error ? cause.message : '没能把这个决定送到')
  } finally {
    busy.value = false
    emit('settled')
  }
}
</script>

<template>
  <div class="approval">
    <div class="approval-head">
      <span class="approval-title">{{ approval.label || '要执行一个动作' }}</span>
      <code class="approval-args">{{ approval.args }}</code>
    </div>
    <div v-if="approval.detail" class="approval-detail">{{ approval.detail }}</div>
    <div v-if="rule" class="approval-detail">
      「这类都允许」会往放行清单加一行 <code>{{ rule }}</code>
    </div>
    <!--
      拒绝理由（P2-1）：**可空**，只说给模型听。
      回车就等于点「拒绝」——写理由的人下一句要做的就是拒绝，不必再挪手去点。
    -->
    <div class="approval-reason">
      <AppInput
        id="kylab-approval-reason"
        v-model="reason"
        :disabled="busy"
        placeholder="拒绝时补一句理由，例如「这条别动生产库」（可空）"
        @keydown.enter.prevent="decide('deny')"
      />
      <span class="approval-reason-hint">这句话会随拒绝一起告诉模型，它据此换个做法</span>
    </div>
    <div class="approval-actions">
      <AppButton variant="primary" size="sm" :disabled="busy" @click="decide('allow_once')">
        允许一次
      </AppButton>
      <AppButton size="sm" :disabled="busy" @click="decide('allow_always')"> 这类都允许 </AppButton>
      <AppButton variant="danger" size="sm" :disabled="busy" @click="decide('deny')">
        拒绝
      </AppButton>
      <span v-if="waitHint" class="approval-wait">{{ waitHint }}</span>
    </div>
  </div>
</template>

<style scoped>
/* 贴着输入框上沿的一条（在 `.composer-wrap` 里、`.composer` 之前）。
   底色用警示而非错误色：它是"等你一句话"，不是"出错了" */
.approval {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  /* 与输入框同宽同轴（`.composer` 是 `max-width: var(--chat-measure); margin: 0 auto`）：
     两条宽度不一的块叠在一起，看起来像"贴错位置了" */
  max-width: var(--chat-measure);
  margin: 0 auto var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-panel);
  background: var(--bg-subtle);
}

.approval-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.approval-title {
  font-size: var(--text-meta-size);
  font-weight: 600;
  color: var(--text-primary);
}

/* 命令原文用等宽字体、可以横向滚：它是给人**核对**的，不能被省略号截掉中间那段 */
.approval-args {
  font-family: var(--font-mono);
  font-size: var(--text-meta-size);
  color: var(--text-primary);
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
  padding: 2px var(--space-2);
  overflow-x: auto;
  max-width: 100%;
}

.approval-detail {
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

.approval-detail code {
  font-family: var(--font-mono);
}

.approval-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/* 拒绝理由：输入框 + 一行说明。说明用二级灰而不是三级——
   它是"这句话会去哪"的唯一交代，用户得读到它才知道写了有用 */
.approval-reason {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.approval-reason-hint {
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

.approval-wait {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}
</style>
