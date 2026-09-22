/**
 * 正在流式的那一轮：**状态与连接由这个模块持有，而不是某个组件**（v0.41）。
 *
 * ## 为什么要有它
 *
 * 用户报的第 4 条：回答写到一半切去笔记页，回来这一轮就没了。
 * 根因是"**流的所有权跟着页面走**"——`ChatView` 卸载时 `abort()` 掉连接、
 * 而消息数组是组件局部的（见 `ChatView` 里 `messages` 的声明），
 * 页面一没，提问、半截回答、已经跑过的工具步骤一起消失；
 * 更糟的是那条 SSE 被掐了，后端那一轮也跟着没了（落库发生在流跑完之后）。
 *
 * 所以这一层把三样东西搬出组件：**这一轮的状态**（正文 / 思考 / 步骤 / 来源）、
 * **连接句柄**、以及**它属于哪条会话**。组件只在挂载期间做一件事：
 * 把这里的状态**镜像**进自己的消息数组（`syncLive`）。它随时可以走，镜像断了不影响流。
 *
 * ## 两种落法（`mode`）
 *
 * - `append`：新起一轮（发送、重新生成）——需要一对"提问 + 占位回答"；
 * - `patch`：续写最后一条回答（续跑）——只改那一条，不新增。
 *
 * 分开的理由是**回到页面时的重放**：`append` 的那一轮在库里还没有（落库要等流跑完），
 * 必须由镜像把那一对补回画面上；`patch` 的那条在库里已经存在（只是内容旧），
 * 补一对会凭空多出一轮。
 */
import { ref } from 'vue'

import {
  chatStream,
  isAbortError,
  resumeStream,
  type ChatHandlers,
  type ChatPayload,
  type ChatSource,
  type ChatStep,
  type ChatStreamHandle,
  type ResumePayload,
  type ThinkingEffort,
} from '@/api/chat'
import { mergeStep } from '@/composables/useChatTurns'

/** `append` = 新起一轮；`patch` = 续写最后一条回答。 */
export type LiveMode = 'append' | 'patch'

export interface LiveTurnState {
  conversationId: string
  mode: LiveMode
  /** 这一轮的提问（`append` 重放时要用它补出提问那一条）。 */
  query: string
  /** 这一轮实际用的思考档：过程面板要如实显示"这一步做没做"。 */
  thinking: { enabled: boolean; effort: ThinkingEffort } | null
  text: string
  thinkingText: string
  steps: ChatStep[]
  sources: ChatSource[]
  streaming: boolean
  /** 失败原因（空 = 没失败）。抛在模块里而不是组件里——切页之后也要看得见。 */
  error: string
}

/** 模块作用域：组件挂载/卸载都不影响它。**整个应用只有这一份「正在流的那一轮」**。 */
export const liveTurnState = ref<LiveTurnState | null>(null)
let handle: ChatStreamHandle | null = null

/**
 * 这一轮结束了（成功、失败、被停止都算）。
 *
 * **只翻状态、不回调**：收尾那一摊（写缓存、让后端校准）由**当时挂载着的组件**
 * 看见 `streaming` 变假之后自己做。曾经这里存过一个 `onSettled` 回调，
 * 但那是"发起这一轮的那个组件"的函数——用户切走之后它已经不在画面上了，
 * 它手里的 `conversationId` 甚至是空的，于是收尾被静默跳过（实测踩到）。
 * 换成"当前挂载者接手"之后，谁在看谁负责，与发起者无关。
 */
function endStream(): void {
  const state = liveTurnState.value
  if (state) state.streaming = false
  handle = null
}

function finishWith(answer: string): void {
  const state = liveTurnState.value
  if (state) {
    // done 带的是后端拼好的全文：以它为准，避免个别 delta 丢失后正文与引用对不上
    state.text = answer
    state.error = ''
  }
  endStream()
}

function failWith(message: string): void {
  const state = liveTurnState.value
  if (state) state.error = message
  endStream()
}

/**
 * 开一轮：先登记状态，再建连接，事件一路写进 `live`。
 *
 * `open` 由调用方给（发送/重新生成走 `chatStream`，续跑走 `resumeStream`）——
 * 这里只认"怎么开这条流"，不认它是哪条链路的。
 */
async function begin(
  state: LiveTurnState,
  open: (handlers: ChatHandlers) => Promise<ChatStreamHandle>,
): Promise<void> {
  liveTurnState.value = state
  try {
    handle = await open({
      onStep: (step) => {
        if (liveTurnState.value)
          liveTurnState.value.steps = mergeStep(liveTurnState.value.steps, step)
      },
      onSources: (items) => {
        if (liveTurnState.value) liveTurnState.value.sources = items
      },
      onThinking: (chunk) => {
        if (liveTurnState.value) liveTurnState.value.thinkingText += chunk
      },
      onDelta: (delta) => {
        if (liveTurnState.value) liveTurnState.value.text += delta
      },
      onDone: (answer) => finishWith(answer),
      onError: (message) => failWith(message),
    })
  } catch (cause) {
    // 用户点了「停止」：已经流出来的部分留着，它仍然是有用的
    if (isAbortError(cause)) endStream()
    else failWith(cause instanceof Error ? cause.message : '对话失败')
  }
}

function makeState(
  conversationId: string,
  mode: LiveMode,
  query: string,
  thinking: { enabled: boolean; effort: ThinkingEffort } | null,
): LiveTurnState {
  return {
    conversationId,
    mode,
    query,
    thinking,
    text: '',
    thinkingText: '',
    steps: [],
    sources: [],
    streaming: true,
    error: '',
  }
}

/** 发送 / 重新生成：新起一轮。 */
export function startChatTurn(
  payload: ChatPayload,
  meta: {
    conversationId: string
    /** 这一轮的提问——重放时要靠它补出提问那一条。 */
    query: string
    thinking: { enabled: boolean; effort: ThinkingEffort } | null
  },
): Promise<void> {
  return begin(makeState(meta.conversationId, 'append', meta.query, meta.thinking), (handlers) =>
    chatStream(payload, handlers),
  )
}

/** 续跑：改的是**同一条**回答（`mode: 'patch'`）。 */
export function startResumeTurn(
  conversationId: string,
  payload: ResumePayload,
  meta: {
    thinking: { enabled: boolean; effort: ThinkingEffort } | null
  },
): Promise<void> {
  return begin(makeState(conversationId, 'patch', '', meta.thinking), (handlers) =>
    resumeStream(conversationId, payload, handlers),
  )
}

/** 用户点了「停止」。 */
export function abortLiveTurn(): void {
  handle?.abort()
}

/** 这一轮已经交付给库了（或用户换了会话）：忘掉它。 */
export function clearLiveTurn(): void {
  liveTurnState.value = null
}
