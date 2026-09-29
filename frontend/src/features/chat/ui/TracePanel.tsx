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
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  artifactNameMap,
  liveLine,
  sourcePreview,
  sourceWhere,
  thinkingParagraphs,
  traceKey,
  traceSummary,
  trailingThinking,
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
function EntryRow({
  turnIndex,
  entry,
  streaming,
}: {
  turnIndex: number
  entry: TraceEntry
  streaming: boolean
}) {
  const chat = useChat()
  /**
   * `art_*` → 文件名（D19，2026-09-28 走查）。
   *
   * 在这一层算一次、发给行用：行里只显示，不该各自去扫一遍会话；
   * 表里同时收了**消息附件**（用户上传）与**步骤产物**（工具导出）两处。
   */
  const artifactNames = useMemo(() => artifactNameMap(chat.turns), [chat.turns])

  /**
   * 这一行的开合 key **带上轮次**（P0，真 bug）。
   *
   * 数据层给的 key 只保证"同一轮内唯一"，而宿主的展开表是整个会话共用的一张——
   * 不套这一层前缀，"第 2 轮第 1 步"与"第 5 轮第 1 步"就是同一个 key，
   * 点开一个另一个跟着开（见 `turns.ts::traceKey`）。
   */
  const key = traceKey(turnIndex, entry.key)

  // 单独一步：绝大多数工具只调一次，那一档不该多一层点击
  if (entry.kind === 'step') {
    return (
      <TraceStepRow
        step={entry.step}
        streaming={streaming}
        names={artifactNames}
        open={chat.isStepOpen(key)}
        onToggle={() => chat.toggleStep(key)}
      />
    )
  }

  const open = chat.isGroupOpen(key)
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
          onClick={() => chat.toggleGroup(key)}
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
                streaming={streaming}
                names={artifactNames}
                // 组内每一次调用同样是"哪一轮的第几步"：不带轮次会跨轮串号
                open={chat.isStepOpen(traceKey(turnIndex, child.key))}
                onToggle={() => chat.toggleStep(traceKey(turnIndex, child.key))}
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

export function TracePanel({ turnIndex, turn }: { turnIndex: number; turn: Turn }) {
  const chat = useChat()
  /**
   * 整轮那一串思考的展开态（v0.54）：**默认收起**。
   *
   * 它是给老消息兜底的（见 `trailingThinking`），用户报的正是"这一整块很难看"，
   * 所以默认值只能是收起；要看时点一下就行——"当然用户也可以展开查看"是用户的原话。
   *
   * **必须写在下面那个提前 return 之前**：钩子的顺序不能随渲染分支变
   * （写在 return 之后会被 lint 判成"条件调用"）。
   */
  const [trailingOpen, setTrailingOpen] = useState(false)
  const reply = turn.reply as ChatMessage | null
  if (!reply) return null

  /**
   * 面板的档位来自宿主（判定在 `turns.ts::isTraceOpen`，这里只把"是不是摊开"翻出来用）。
   * 收起时**只剩摘要那一行**：步骤与整轮思考都不进文档（条件渲染），
   * 而回答正文与出处都在面板之外——**正文永远不在这块折叠里**（规则 d）。
   */
  const open = chat.traceOpen(reply) === 'full'
  const view = chat.traceView(turnIndex, turn)
  const trailingThinkingText = trailingThinking(reply)

  return (
    <>
      {/*
        依据摘要那一行：**它同时是过程面板的开合开关**（左边那个箭头）。

        右侧那句话（`traceSummary`）**只在真的有出处时才说**：有出处时它报的是
        「检索完成 · 引用了 N 个片段 · M 篇文档」，那是这一行唯一有用的读数。
        没有出处时它会说"本轮没有命中资料 / 直接作答"——用户原话是"没啥用"，
        所以那两种情况**只留箭头**（收起/展开照样点得到）。
      */}
      <button
        type="button"
        /**
         * 面板收起时这一行**只剩一枚箭头与一句摘要**（没出处时连摘要都没有），
         * 于是它没有可读的无障碍名字。测试要按它开合面板，这里给它一个稳定的抓点
         * （P0 的用例正是"默认收起 → 点一下才摊开"）。
         */
        data-testid="trace-toggle"
        className="flex w-full cursor-pointer items-center gap-[var(--space-1)] bg-transparent p-0 text-left"
        aria-expanded={open}
        onClick={() => chat.toggleTrace(reply)}
      >
        <ChevronDown className={caretClass(open)} size={14} />
        {reply.streaming ? (
          /* 流式时这一行是**滚动的实时状态**：工具在跑就报工具名，思考在写就给它最新的那一截 */
          <LiveLine text={liveLine(reply)} />
        ) : reply.sources.length > 0 ? (
          <span className="text-[length:var(--text-micro-size)] text-[var(--text-secondary)]">
            {traceSummary(reply)}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="mt-[var(--space-3)]">
          <ol className="relative m-0 flex list-none flex-col p-0">
            {view.entries.map((entry) => (
              <EntryRow
                key={entry.key}
                turnIndex={turnIndex}
                entry={entry}
                streaming={Boolean(reply.streaming)}
              />
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
            整轮那一串思考（v0.54 改）：**只有"没有任何一步带自己的推理"时才画**，
            而且**默认折叠**——用户原话："他是把所有思考的内容全部放在一起了。很难看……
            输出最终结果完毕后，把思考折叠起来，就显示工具调用信息就行了。当然用户也可以展开查看。"

            新数据不走这里：每一步的推理已经落在它自己那行里（见 `TraceStepRow`），
            再在末尾铺一遍是把同一件事说两遍（`trailingThinking` 会返回空串）。
            这里兜的是**老消息**（这条规则上线前落库的、整轮只有一串的那种）——
            用户手上正开着的就是它们；拆不出来就只能整块给，但至少不再一直摊着。
          */}
          {trailingThinkingText ? (
            <div className="mt-[var(--space-4)]">
              <button
                type="button"
                className={STEP_TOGGLE}
                aria-expanded={trailingOpen}
                onClick={() => setTrailingOpen((value) => !value)}
              >
                思考过程
                <span className="tabular text-[length:var(--text-micro-size)] text-[var(--text-quaternary)]">
                  {formatCount(trailingThinkingText.length)} 字
                </span>
                <ChevronDown className={caretClass(trailingOpen)} size={12} />
              </button>
              {trailingOpen ? (
                <div className={THINK_BLOCK} data-testid="thinking-block">
                  {thinkingParagraphs(trailingThinkingText).map((paragraph, index) => (
                    // 段落是**同一段文本按空行切出来的**，没有稳定 id；下标即位置
                    <LinkText key={index} className={THINK_PARAGRAPH} text={paragraph} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/*
        出处**不跟着过程一起折**（P0 的规则 d：答案常显）。

        它折进去之前的位置就在上面那个 `open ?` 里，于是"过程默认收起"会顺手把
        "这一轮引了哪几篇文档"一起藏起来——那正是回答的依据，用户看答案时就要能一眼扫到
        （默认铺前 3 条、多出来的折一行，是 `Citations` 自己那一套）。过程可以收起，
        **依据不能**：收起来的信息等于没有（v0.25 那条判断在依据这一块仍然成立）。
      */}
      {reply.sources.length > 0 ? (
        <Citations turnIndex={turnIndex} sources={reply.sources} />
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
