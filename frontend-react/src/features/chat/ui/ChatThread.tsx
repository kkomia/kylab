/**
 * 对话区骨架（assistant-ui 的 Thread 原语）+ 我们自己那三种"这一块现在画什么"。
 *
 * **骨架给的是那几件容易做错的事**：视口、跟随滚动（贴底才跟随，用户往上翻就不抢）、
 * 会话状态（`isRunning`）、以及"回到最新"浮标的出现时机（那块在 `Composer` 上沿，
 * 见 `ui/Composer.tsx`）。**我们给的是内容**：欢迎层、骨架屏、每条消息。
 *
 * 三个状态互斥，顺序不能换（旧 `ChatView` 的模板顺序）：
 * 1. **还没决定显示哪条会话**（解析入口 / 回放中）→ 骨架屏，**不画欢迎层**：
 *    先画再跳的话，用户还是会看到"一屏新对话一闪而过"；
 * 2. **一条消息都没有** → 欢迎层（品牌标 + 标语 + 推荐问题）；
 * 3. 其余 → 消息列表。
 *
 * 消息列表按**我们自己的消息数组**遍历，而不是走 `ThreadPrimitive.Messages`
 * 的渲染函数：那一路给的是 assistant-ui 自己的 parts 结构，而这边每一条都要读回
 * 我们的原对象（过程步骤、出处、交付物都挂在那上面）。少一层翻译，
 * 过程面板那类"我们的字段"就不会在骨架里被磨掉。
 */
import { ThreadPrimitive, useAuiState } from '@assistant-ui/react'

import { buildTurns } from '@/features/chat/model/turns'

import { MessageView } from './MessageView'
import { Welcome } from './Welcome'
import { useChat, type ChatMessage } from '../runtime/ChatProvider'

/** 轮次号：一条提问与它后面那条回答共享同一个号（0 起，与旧 `turns` 的下标一致）。 */
function turnIndexes(messages: ChatMessage[]): Map<string, number> {
  const map = new Map<string, number>()
  let turn = -1
  for (const message of messages) {
    if (message.role === 'user') {
      turn += 1
      map.set(message.id, turn)
    } else {
      // 第一条回答前面可能没有提问（刷新之后接回来的那一轮就是这种）
      map.set(message.id, Math.max(turn, 0))
    }
  }
  return map
}

/** 骨架屏：只画有把握的结构（几行灰条），不画"空对话"的欢迎层，也别让人干等一屏白。 */
function LoadingSkeleton() {
  return (
    <div className="py-[var(--space-6)]" aria-hidden>
      {[92, 78, 85, 64].map((width, row) => (
        <div
          key={row}
          className="mb-[var(--space-3)] h-[14px] rounded-[var(--radius-control)] bg-[var(--bg-subtle)]"
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  )
}

export function ChatThread() {
  const chat = useChat()
  const isRunning = useAuiState((state) => state.thread.isRunning)
  const order = turnIndexes(chat.messages)
  // 提问与回答是**一个整体**（旧前端渲染前先配对）：配对交给 `model/turns` 的
  // `buildTurns`，这里按轮次号取回来——「存为笔记」的标题、出处、交付物都按它对
  const turns = buildTurns(chat.messages)

  return (
    <ThreadPrimitive.Root
      className="relative flex h-full flex-col"
      data-running={isRunning ? 'true' : 'false'}
    >
      <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto" aria-label="对话内容">
        <div
          className={
            chat.welcome
              ? 'mx-auto flex min-h-full w-full max-w-[calc(var(--chat-input-max-width)+2*var(--page-gutter))] flex-col items-center justify-center px-[var(--page-gutter)] py-[var(--space-4)]'
              : 'mx-auto w-full max-w-[calc(var(--chat-input-max-width)+2*var(--page-gutter))] px-[var(--page-gutter)] pt-[var(--space-6)] pb-[var(--space-4)]'
          }
        >
          {chat.messages.length === 0 && chat.pendingEntry ? (
            <div className="w-full">
              <LoadingSkeleton />
            </div>
          ) : chat.welcome ? (
            <Welcome />
          ) : (
            <div data-testid="message-list">
              {chat.messages.map((message, index) => (
                <MessageView
                  key={message.id}
                  message={message}
                  turn={turns[order.get(message.id) ?? 0] ?? { user: null, reply: message }}
                  turnIndex={order.get(message.id) ?? 0}
                  isFirst={index === 0}
                  role={message.role === 'user' ? 'user' : 'assistant'}
                />
              ))}
            </div>
          )}
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}
