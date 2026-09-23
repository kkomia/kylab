/**
 * assistant-ui 的 **runtime 适配层**：把我们的消息数组与流接进它的 external store。
 *
 * 三条硬约束（迁移计划 §4 的 P1、任务书第 1 条），逐条都以上游源码为据
 * （见同目录 `README.md`：`useExternalStoreRuntime` 全量零 fetch、零 transport，
 * `append()` 的唯一出口就是 `onNew`）：
 *
 * 1. **协议是我们自己的**：消息来自 `ChatProvider`（`Message[]` + `model/turns` 的
 *    回合模型），发送走 `liveAdapter` 的 `startChatTurn`，停止走 `abortLiveTurn` + `/stop`，
 *    审批走 `api/chat.decideApproval`。assistant-ui **不碰网络**——它拿到的
 *    `onNew` / `onCancel` 只是"用户按了发送/停止"的转发；
 * 2. **消息的真相在我们手上**：`messages` 传进去的是外部数组，`convertMessage`
 *    只做"翻译"（id + role + 正文）。过程面板、出处、交付物这些属于我们的字段
 *    一个字都没进它的结构——界面直接读我们自己的消息对象（见 `ui/ChatThread.tsx`）；
 * 3. **它带来的是骨架**：视口、跟随滚动、"回到最新"浮标、`isRunning`
 *    （发送按钮 → 停止按钮的那一档）。
 *
 * 三条来自上游源码的纪律（README §7.2），这里都守住了：
 * - `convertMessage` **必须是稳定引用**（模块级函数）——引用一变就清空整张转换缓存，
 *   流式时全量重转；
 * - 消息对象**绝不原地改**（转换缓存是 `WeakMap`，key 不变 UI 不更新）——
 *   我们的镜像每来一个增量都换新对象；
 * - `messages` 里**只有变化的那一条换引用**，其余保持原对象（同上）。
 *
 * 为什么输入框没有用 `ComposerPrimitive`：那一排要挂斜杠命令菜单、`@` 提及菜单、
 * 两种拖拽、模型/思考/模式/执行策略/上下文仪表六个控件，而菜单的过滤词、插入位置、
 * 发送键都由我们自己定。用它的 composer 就得把"输入框里的文本"存两份、
 * 并在它的运行时 API 里做这些事——多一层没有收益的耦合（它的 `/` 与 `@` 触发器
 * 是另一套适配器契约，接我们的命令表要反过来包一层）。输入框的**行为**仍然逐条
 * 对着旧 `ChatView` 实现（见 `ui/Composer.tsx`）。
 */
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { useCallback, type ReactNode } from 'react'

import { useChat, type ChatMessage } from './ChatProvider'

/**
 * 翻译一件东西：**这是第几条、谁说的、说了什么**。
 *
 * 模块级常量是必须的（见文件头第三条纪律）；`status` 刻意不填——运行时按内容
 * 自动推导（流式时 `isRunning` 会让最后一条是 `running`），我们填反而会和它对不上。
 */
function convertMessage(message: ChatMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: [{ type: 'text', text: message.text }],
  }
}

/** 从 assistant-ui 的"追加消息"里取出正文（我们只发纯文本）。 */
function textOf(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim()
}

export function ChatRuntime({ children }: { children: ReactNode }) {
  const { messages, sending, send, stop } = useChat()
  const sendRef = useCallback(() => send(), [send])

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = textOf(message)
      if (!text) return
      // 走我们自己的发送链路：建会话、命令分流、起一轮全在 `ChatProvider` 里。
      // 这里**不把这条消息塞回数组**——`send` 自己会添（塞两次会多一个气泡）。
      void sendRef()
    },
    [sendRef],
  )

  const onCancel = useCallback(async () => {
    stop()
  }, [stop])

  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages,
    isRunning: sending,
    onNew,
    onCancel,
    convertMessage,
  })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
