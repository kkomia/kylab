/**
 * 一条消息（旧 `ChatView.vue` 模板里的 `.ask` 与 `.reply` 两块）。
 *
 * 提问是**右对齐气泡**（位置与形状已经说明它是谁说的，不再有"我的问题"这类标签）；
 * 回答左侧留一条头像沟槽（40px），正文与它下面的动作都归右边那一列。
 *
 * 消息的原对象从 `getExternalStoreMessages` 回读——assistant-ui 只管"这是第几条、
 * 谁说的"，过程面板/出处/交付物这些属于我们的字段一个字都没经过它。
 */
import { Copy, RotateCcw, StickyNote, TriangleAlert } from 'lucide-react'

import {
  degradedReason,
  hasToolCallMarkup,
  replyArtifacts,
  wasDegraded,
  type Turn,
} from '@/features/chat/model/turns'

import { AnswerText } from './AnswerText'
import { Deliverables } from './Deliverables'
import { Logo } from './Logo'
import { TracePanel } from './TracePanel'
import { useChat, type ChatMessage } from '../runtime/ChatProvider'

/** 空的头像沟槽留给 logo：回答这一列的起点在它右边，与正文列对齐。 */
function AssistantAvatar() {
  return (
    <span
      className="inline-flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--accent)] text-[var(--Always-White)]"
      aria-hidden
    >
      <Logo variant="mark" size={22} label="" />
    </span>
  )
}

function UserMessage({ message, turnIndex }: { message: ChatMessage; turnIndex: number }) {
  const chat = useChat()
  const copied = chat.copiedKey === `${turnIndex}:user`
  return (
    <div className="group/ask flex items-end justify-end gap-[var(--space-2)]">
      {/* 提问也能复制：用户常常要把同一个问题拿去别处问 */}
      <button
        type="button"
        className={`mb-[2px] inline-flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-[var(--radius-control)] text-[var(--text-tertiary)] opacity-0 transition-opacity [transition:opacity_var(--motion-fast)_var(--motion-ease)] group-hover/ask:opacity-100 focus-visible:opacity-100 ${
          copied ? 'opacity-100' : ''
        }`}
        aria-label={copied ? '已复制提问' : '复制提问'}
        title={copied ? '已复制' : '复制'}
        onClick={() => chat.copyMessage(turnIndex, message)}
      >
        <Copy size={13} />
      </button>
      <p className="m-0 max-w-[min(78%,620px)] rounded-[var(--radius-panel)_var(--radius-panel)_var(--space-1)_var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--bg-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-body-size)] whitespace-pre-wrap text-[var(--text-primary)] [overflow-wrap:anywhere]">
        {message.text}
      </p>
    </div>
  )
}

function AssistantMessage({
  message,
  turn,
  turnIndex,
}: {
  message: ChatMessage
  turn: Turn
  turnIndex: number
}) {
  const chat = useChat()
  const artifacts = replyArtifacts(turn)
  const isLastTurn = turnIndex === chat.turns.length - 1
  const copied = chat.copiedKey === `${turnIndex}:assistant`
  const saved = chat.savedTurns.includes(turnIndex)
  const degraded = !message.streaming && wasDegraded(message)
  const rawTools = hasToolCallMarkup(message.text)

  return (
    <div className="flex items-start gap-[var(--space-3)]">
      <AssistantAvatar />
      <div className="min-w-0 flex-1">
        {message.error ? (
          <p className="m-0 max-w-[var(--measure)] text-[length:var(--text-body-size)] text-[var(--status-danger)]">
            {message.error}
          </p>
        ) : (
          <>
            {/* 出错的那一轮没有过程可讲，只报错 */}
            <TracePanel turnIndex={turnIndex} turn={turn} />

            {/*
              模型把工具调用写进正文（§12.219）：**不当回答渲染**。
              原文照旧显示（只是按原文排版、不走 Markdown），上面加一行说明——
              把"这段不是人话"这件事说在明处，而不是让用户自己猜。
            */}
            {rawTools ? (
              <>
                <p className="mt-[var(--space-3)] mb-0 flex items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-secondary)]">
                  <TriangleAlert size={13} />
                  这一段是模型写出来的工具调用标记，没有执行。
                </p>
                <div
                  data-testid="reply-raw-tools"
                  className="mt-[var(--space-2)] max-w-[var(--measure)] font-mono text-[length:var(--text-micro-size)] whitespace-pre-wrap text-[var(--text-secondary)] [overflow-wrap:anywhere]"
                >
                  {message.text}
                </div>
              </>
            ) : (
              /* `max-w-[var(--measure)]`：旧 `.reply-text { max-width: var(--measure) }`
                 ——正文列是 768px，但**行宽**另有 66ch 的上限（阅读型界面的口径），
                 照旧版补齐（对照记录 §3 第 5 条）。 */
              <AnswerText
                className="mt-[var(--space-3)] max-w-[var(--measure)] text-[length:var(--text-body-size)] leading-[var(--line-prose)] text-[var(--text-primary)]"
                text={message.text}
                sources={message.sources}
                onCite={(sourceIndex) => chat.revealSource(turnIndex, sourceIndex)}
              />
            )}

            {/*
              降级提示：**没按设计走完**是这一轮唯一的降级情形。两个出口是两件不同的事：
              「继续」= 接着做（已经查到的资料接着用）；「重试」= 从头再来（回退一轮重发）。
              两个都只在最后一轮给：续跑端点认的就是"会话里最后一条回答"。
            */}
            {degraded ? (
              <p className="mt-[var(--space-3)] mb-0 flex flex-wrap items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--status-warning)]">
                <TriangleAlert size={13} />
                这次没跑完（{degradedReason(message)}）。
                {isLastTurn && !chat.sending ? (
                  <>
                    <button
                      type="button"
                      className="cursor-pointer font-medium text-[var(--accent-text)] hover:underline disabled:cursor-default disabled:opacity-60"
                      disabled={chat.resuming || chat.regenerating}
                      title="接着用已经查到的资料继续做"
                      onClick={() => chat.resumeTurn(turnIndex)}
                    >
                      {chat.resuming ? '继续中…' : '继续'}
                    </button>
                    <span className="text-[var(--separator)]">·</span>
                    <button
                      type="button"
                      className="cursor-pointer text-[var(--accent-text)] hover:underline disabled:cursor-default disabled:opacity-60"
                      disabled={chat.resuming || chat.regenerating}
                      title="丢掉这次的过程，重新问一遍"
                      onClick={() => chat.regenerate(turnIndex)}
                    >
                      {chat.regenerating ? '重试中…' : '重试'}
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}

            {/* 交付物：**流式中先不摆**，等这一轮收尾再一起交付 */}
            {artifacts.length > 0 && !message.streaming ? <Deliverables files={artifacts} /> : null}

            {/* 消息级操作：复制永远可用；重新生成只给**最后一轮** */}
            {!message.streaming ? (
              <div className="mt-[var(--space-2)] flex items-center gap-[var(--space-3)]">
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                  onClick={() => chat.copyMessage(turnIndex, message)}
                >
                  <Copy size={13} />
                  {copied ? '已复制' : '复制'}
                </button>
                {/* 存为笔记：问答是笔记最自然的来源之一（问答 → 笔记 → 语料 闭环） */}
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                  onClick={() => chat.saveAsNote(turnIndex, turn)}
                >
                  <StickyNote size={13} />
                  {saved ? '已存为笔记' : '存为笔记'}
                </button>
                {isLastTurn && !chat.sending ? (
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-60"
                    disabled={chat.regenerating}
                    onClick={() => chat.regenerate(turnIndex)}
                  >
                    <RotateCcw size={13} />
                    {chat.regenerating ? '生成中…' : '重新生成'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 一条消息的入口（由 assistant-ui 的消息列表逐个调用）。
 *
 * `turnIndex` 由外层算好传进来（`数据` 里那两个键 `[turnIndex]:[role]` 用它）：
 * 一条回答与它前面那条提问共享同一个轮次号，行内徽标、出处、消息动作都按它分组。
 */
export function MessageView({
  message,
  turn,
  turnIndex,
  isFirst,
  role,
}: {
  message: ChatMessage
  /** 这一条所属的那一轮（提问 + 回答）——「存为笔记」的标题要用提问那条。 */
  turn: Turn
  turnIndex: number
  isFirst: boolean
  role: 'user' | 'assistant'
}) {
  // 回答紧跟着自己的提问：24px 是"两组问答之间"的距离，组内不该有那么大空隙
  const spacing = isFirst ? '' : role === 'user' ? 'mt-[var(--space-6)]' : 'mt-[var(--space-3)]'

  return (
    <div className={spacing} data-turn={turnIndex} data-role={role}>
      {role === 'user' ? (
        <UserMessage message={message} turnIndex={turnIndex} />
      ) : (
        <AssistantMessage message={message} turn={turn} turnIndex={turnIndex} />
      )}
    </div>
  )
}
