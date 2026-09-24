/**
 * 过程面板（旧 `ChatView.vue` 的 `.trace-head` + `.trace` 那两块）。
 *
 * 装四样东西，各有各的来历：
 *
 * 1. **时间线**：只列真发生过的步骤；同类工具**并成一行 + 次数**（合并的是入口，
 *    不是信息——点开才是每一次的结论与原文）；
 * 2. **大输出的两级懒加载**：一轮几十次工具调用时先画前 20 条（`TRACE_PAGE_SIZE`），
 *    这一行如实报出"画了多少 / 一共多少"；单条原文再切到 600 字（见 `TraceStepRow`）；
 * 3. **思考过程**：推理模型的 `reasoning_content`，它是过程的一部分，收在面板里、
 *    **按段排开**，并且长得与正文明显不同（缩进 + 底色 + 更小字号 + 更紧段距，
 *    v0.28 第二批评审 A3）——读者要一眼看得出"这是过程，不是答案"；
 * 4. **逐条出处**：默认只铺前 3 条，多出来的折成一行——一次命中上百个片段时，
 *    它会长成一面比回答还长的墙（用户报的"很长的会话"）。行内徽标 `[n]` 点进来时
 *    会自动展开（见 `revealSource`），否则会滚到一个不存在的节点上。
 *
 * 折叠用的是 `v-if` 那种"不是就不在文档里"的做法（React 里就是条件渲染）：
 * 这一块装着步骤、思考全文与每条出处的正文预览，聊到几十轮时它们只是被 CSS 藏起来，
 * DOM 开销一直在。
 */
import { ChevronDown } from 'lucide-react'
import { useEffect, useRef } from 'react'

import {
  liveLine,
  sourcePreview,
  sourceWhere,
  thinkingParagraphs,
  traceSummary,
  type Turn,
  type TraceEntry,
} from '@/features/chat/model/turns'
import type { ChatSource } from '@/api/chat'
import { formatCount } from '@/lib/format'

import { LinkText } from './LinkText'
import { StepIcon } from './stepIcons'
import { TraceStepRow } from './TraceStepRow'
import {
  STEP_BODY,
  STEP_ROW,
  STEP_TOGGLE,
  THINK_BLOCK,
  THINK_PARAGRAPH,
  caretClass,
  stepIconClass,
} from './traceStyles'
import { useChat, type ChatMessage } from '../runtime/ChatProvider'

/** 出处列表默认铺几条（多出来的折起来）。 */
const CITE_FOLD_LIMIT = 3

/** 过程面板的一行：单独一步，或**同类工具并成的一组**。 */
function EntryRow({ entry }: { entry: TraceEntry }) {
  const chat = useChat()

  // 单独一步：绝大多数工具只调一次，那一档不该多一层点击
  if (entry.kind === 'step') {
    return (
      <TraceStepRow
        step={entry.step}
        open={chat.isStepOpen(entry.step.key)}
        onToggle={() => chat.toggleStep(entry.step.key)}
      />
    )
  }

  const open = chat.isGroupOpen(entry.key)
  return (
    <li className={STEP_ROW} data-kind={entry.icon}>
      {/* 组那一行与单步**共用外壳**：图标位、圆底、起始线都走同一份取值 */}
      <span className={stepIconClass(entry.icon)}>
        <StepIcon icon={entry.icon} />
      </span>
      <div className={STEP_BODY}>
        <button
          type="button"
          className={STEP_TOGGLE}
          aria-expanded={open}
          onClick={() => chat.toggleGroup(entry.key)}
        >
          {entry.label}
          <span className="text-[length:var(--text-micro-size)] text-[var(--text-quaternary)]">
            {formatCount(entry.steps.length)} 次
          </span>
          <ChevronDown className={caretClass(open)} size={12} />
        </button>
        {open ? (
          <ol className="m-0 flex list-none flex-col p-0">
            {entry.steps.map((child) => (
              <TraceStepRow
                key={child.key}
                step={child}
                variant="child"
                open={chat.isStepOpen(child.key)}
                onToggle={() => chat.toggleStep(child.key)}
              />
            ))}
          </ol>
        ) : null}
      </div>
    </li>
  )
}

/** 逐条出处。点文件名/「看全文」都是**看这一段原文**，不离开对话页。 */
function Citations({ turnIndex, sources }: { turnIndex: number; sources: ChatSource[] }) {
  const chat = useChat()
  const expanded = chat.citesExpanded(turnIndex)
  const shown = expanded ? sources : sources.slice(0, CITE_FOLD_LIMIT)

  return (
    <ol className="m-0 mt-[var(--space-4)] flex list-none flex-col gap-[var(--space-2)] p-0">
      {shown.map((source) => (
        <li
          key={source.chunk_id}
          data-source={source.index}
          className={`rounded-[var(--radius-row)] transition-colors [transition:var(--transition-surface)] ${
            chat.flashCite === `${turnIndex}:${source.index}` ? 'bg-[var(--accent-soft)]' : ''
          }`}
        >
          <div className="flex flex-wrap items-baseline gap-[var(--space-2)]">
            <span className="tabular text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
              [{source.index}]
            </span>
            <button
              type="button"
              className="cursor-pointer text-left text-[length:var(--text-micro-size)] text-[var(--text-primary)] hover:underline"
              onClick={() => chat.openSource(source)}
            >
              {source.document_name}
            </button>
            {sourceWhere(source) ? (
              <span className="text-[length:var(--text-micro-size)] text-[var(--text-quaternary)]">
                {sourceWhere(source)}
              </span>
            ) : null}
            <button
              type="button"
              className="ml-auto cursor-pointer text-[length:var(--text-micro-size)] text-[var(--accent-text)] hover:underline"
              onClick={() => chat.openSource(source)}
            >
              看全文
            </button>
          </div>
          <LinkText
            className="mt-[var(--space-1)] block text-[length:var(--text-micro-size)] leading-[var(--line-prose)] text-[var(--text-secondary)]"
            text={sourcePreview(source)}
          />
        </li>
      ))}
      {sources.length > CITE_FOLD_LIMIT ? (
        <li>
          <button
            type="button"
            className="cursor-pointer text-[length:var(--text-micro-size)] text-[var(--accent-text)] hover:underline"
            onClick={() => chat.toggleCites(turnIndex)}
          >
            {expanded ? '收起出处' : `还有 ${sources.length - CITE_FOLD_LIMIT} 条出处`}
          </button>
        </li>
      ) : null}
    </ol>
  )
}

/**
 * "本轮带了什么"那一句：长期记忆与人设的注入量。
 *
 * 为什么值得常驻这一行：四份人设文件**每轮都进 system prompt**（实测占三成多），
 * 但界面上原先只有在输入框那个折叠的上下文仪表里才看得到"记忆与人设"一项，
 * 首轮之前它根本不渲染——于是用户的体感是"我写了 SOUL.md，它好像没读"
 * （用户原话："全程没有生效"）。把数字放到**这一轮的边上**之后，
 * "带了没带、带了多少"就不再是个需要推断的问题。
 *
 * 数字来自 `GET /chat/context-usage` 的 `memory` 项（`chars` / `tokens`）；
 * 这里**不复述任何文件内容**，只报数量。
 */
function memoryNote(chars: number, tokens: number): string {
  return `本轮带入长期记忆与人设 ${formatCount(chars)} 字（约 ${formatCount(tokens)} tokens）`
}

export function TracePanel({ turnIndex, turn }: { turnIndex: number; turn: Turn }) {
  const chat = useChat()
  const reply = turn.reply as ChatMessage | null
  if (!reply) return null

  const open = chat.traceOpen(reply)
  const view = chat.traceView(turnIndex, turn)

  /**
   * 只在**最新一轮**挂那一句：上下文用量是按会话（当前提示词）算的，
   * 挂在每一轮上会让旧轮次也宣称"本轮带了 N 字"，而它当时带的是那时那份
   * （用户改过记忆文件之后，两个数字就不一样了）。旧轮次不该替历史下结论。
   */
  const latest = turnIndex === chat.turns.length - 1
  const memory = chat.contextUsage.data?.items.find((item) => item.kind === 'memory')
  const memoryText =
    latest && memory && memory.chars > 0 ? memoryNote(memory.chars, memory.tokens) : ''

  return (
    <>
      {/* 依据摘要那一行：这一行的数字就是"这句回答有没有出处"的答案 */}
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-[var(--space-1)] bg-transparent p-0 text-left"
        aria-expanded={open}
        onClick={() => chat.toggleTrace(reply)}
      >
        <ChevronDown className={caretClass(open)} size={14} />
        {reply.streaming ? (
          /* 流式时这一行是**滚动的实时状态**：工具在跑就报工具名，思考在写就给它最新的那一截 */
          <LiveLine text={liveLine(reply)} />
        ) : (
          <span className="text-[length:var(--text-micro-size)] text-[var(--text-secondary)]">
            {traceSummary(reply)}
          </span>
        )}
      </button>

      {/*
        "带了什么"常驻、且**与面板是否展开无关**：它回答的是"这一轮它记得我什么"，
        而这件事在收起状态下同样是用户要看的（原先唯一的读法在输入框那个折叠仪表里）。
      */}
      {memoryText ? (
        <p
          className="tabular mt-[var(--space-1)] m-0 text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]"
          title="SOUL.md / PROFILE.md / AGENTS.md / MEMORY.md 四份文件每轮整份注入 system prompt，与记忆服务是否连通无关；这个数来自 GET /chat/context-usage 的「记忆与人设」一项（估算值）。"
        >
          {memoryText}
        </p>
      ) : null}

      {open ? (
        <div className="mt-[var(--space-3)]">
          <ol className="relative m-0 flex list-none flex-col p-0">
            {view.entries.map((entry) => (
              <EntryRow key={entry.key} entry={entry} />
            ))}
          </ol>

          {view.hidden > 0 ? (
            <div className="mt-[var(--space-3)] flex items-center gap-[var(--space-2)]">
              {view.total > 0 ? (
                <span className="tabular text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
                  当前已显示 {formatCount(view.shown)} / {formatCount(view.total)} 条工具调用
                </span>
              ) : (
                <span className="text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
                  还有 {formatCount(view.hidden)} 段过程没显示
                </span>
              )}
              <button
                type="button"
                className="cursor-pointer text-[length:var(--text-micro-size)] text-[var(--accent-text)] hover:underline"
                onClick={() => chat.showMoreTrace(turnIndex)}
              >
                加载更多
              </button>
            </div>
          ) : null}

          {/*
            思考过程：**按段切开的整块**（不是一整串 pre-wrap 的文本）。
            样子与正文刻意拉开距离（缩进、底色、左侧一道线、更小的字号与更紧的段距），
            因为它讲的是"这一步怎么想出来的"，不是答案本身。
            **默认仍然展开**（v0.25 照 Kimi 的那次选择：过程常驻在正文里，
            见 `isTraceOpen`）、也**不给折叠开关**——这里只改它长什么样。
          */}
          {reply.thinkingText ? (
            <div className="mt-[var(--space-4)]">
              <p className="m-0 text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
                思考过程
              </p>
              <div className={THINK_BLOCK} data-testid="thinking-block">
                {thinkingParagraphs(reply.thinkingText).map((paragraph, index) => (
                  // 段落是**同一段文本按空行切出来的**，没有稳定 id；下标即位置
                  <LinkText key={index} className={THINK_PARAGRAPH} text={paragraph} />
                ))}
              </div>
            </div>
          ) : null}

          {reply.sources.length > 0 ? (
            <Citations turnIndex={turnIndex} sources={reply.sources} />
          ) : null}
        </div>
      ) : null}
    </>
  )
}

/**
 * 流式期间那一行实时状态（旧 `components/chat/LiveLine.vue`）。
 *
 * **只有一行**，最新吐出来的字从右边进来、旧的往左边滚出去（左边淡出）。
 * 它替掉的是"思考像一堵墙一样长高"那种观感：一轮里想了几千字，屏幕上始终是
 * 一行在滚——这是"它在飞快地做事"最直接的画面。
 *
 * 两处实现上的取舍（照旧）：用 `scrollLeft` 而不是动画库（零额外状态、零计时器）；
 * 左侧用 `mask-image` 淡出（滚出去的是半句话，硬切会留下一排断口）。
 */
function LiveLine({ text }: { text: string }) {
  const line = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    // 内容还在变宽时才要滚；`scrollLeft` 直接给到最右，mid-roll 的新内容不会跳
    const node = line.current
    if (node) node.scrollLeft = node.scrollWidth
  }, [text])

  return (
    <span
      ref={line}
      // 这里那个 `#000` 是**蒙版的截止色**（纯黑=完全不透明），不是界面上的颜色：
      // 它必须是固定值——换成主题色的话，浅色主题那种带透明度的值会让淡出失效
      className="block min-w-0 overflow-hidden whitespace-nowrap [scroll-behavior:smooth] [mask-image:linear-gradient(to_right,transparent,#000_28px)]"
    >
      <span className="inline-block text-[length:var(--text-micro-size)] text-[var(--text-secondary)]">
        {text}
      </span>
    </span>
  )
}
