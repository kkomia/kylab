/**
 * 界面与「常驻流」那一层之间的**唯一接口**。
 *
 * 常驻流（`src/features/chat/model/liveTurn.ts`，接口名与旧 Vue 的 `useLiveTurn.ts`
 * 一致）由并行的另一位同事实现：状态与连接都在模块作用域里，切页不丢、刷新能按
 * 锚点接回来（旧版 `useLiveTurn` 的 P2-2 设计）。
 *
 * 为什么还要这一层：**把"外部模块长什么样"收在一处**。界面（`ui/**`）只认这里导出的
 * 名字，于是那一层将来换了取状态的方式（zustand / hook / 别的），要改的只有这个文件，
 * 而不是散在十几个组件里的 import。
 *
 * 这里**不实现任何流逻辑**：事件怎么写进状态、重连怎么排、停止怎么收口，全在
 * `model/liveTurn.ts` 里（同一份逻辑只该有一处）。
 */
import {
  abortLiveTurn,
  attachLiveTurn,
  clearLiveTurn,
  settleLiveApproval,
  startChatTurn,
  startCommandTurn,
  startResumeTurn,
  useLiveTurn,
  type LiveTurnState,
} from '@/features/chat/model/liveTurn'
import { mergeStep } from '@/features/chat/model/turns'

import type {
  ChatCommandResult,
  ChatHandlers,
  ChatPayload,
  ResumePayload,
  ThinkingEffort,
} from '@/api/chat'

export type { LiveTurnState }

/** 这一轮的思考档（过程面板据此如实显示"这一步做没做"）。 */
export interface LiveThinking {
  enabled: boolean
  effort: ThinkingEffort
}

/**
 * 当前这一轮（`null` = 没有在跑的、也没有刚跑完还没被库接手的一轮）。
 *
 * 是个 React hook：模型层管订阅，这里只是把它的名字固定下来。
 */
export function useLiveTurnState(): LiveTurnState | null {
  return useLiveTurn()
}

/** 事件该用哪一套 handler（与 `model/liveTurn` 里那份逐字同源）。 */
export type { ChatHandlers }

export interface StartTurnMeta {
  conversationId: string
  /**
   * 这一轮的提问。**重放时要靠它补出提问那一条**（`append` 与 `command` 两种模式）；
   * `recover`（刷新后接回来的那一轮）没有它——提问随落库才有。
   */
  query: string
  thinking: LiveThinking | null
}

export const liveActions = {
  /** 发送 / 重新生成：新起一轮。 */
  startChatTurn,
  /** 一条斜杠命令：走正常那一轮，是不是"只回一句"由结果说了算（P1-2）。 */
  startCommandTurn,
  /** 续跑上一轮（改的是**同一条**回答）。 */
  startResumeTurn,
  /** 接回这条会话上正在跑的那一轮（挂载与断线重连同一个入口）。 */
  attachLiveTurn,
  /** 用户点了「停止」：本页不再等它（后端那一轮走 `/stop` 才真停）。 */
  abortLiveTurn,
  /** 这一轮已经交付给库了（或用户换了会话）：忘掉它。 */
  clearLiveTurn,
  /** 那条确认已经有结论了：把确认条收起来。 */
  settleLiveApproval,
}

export type { ChatCommandResult, ChatPayload, ResumePayload }

/** 把步骤并进列表（界面不自己写合并规则，见 `model/turns.ts` 的 `mergeStep`）。 */
export { mergeStep }
