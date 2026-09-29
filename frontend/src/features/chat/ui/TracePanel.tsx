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
import { useMemo, useState } from 'react'

import {
  artifactNameMap,
  isRunningStep,
  sourcePreview,
  sourceWhere,
  thinkingParagraphs,
  traceKey,
  traceSummary,
  trailingThinking,
  type Turn,
  type TraceEntry,
} from '@/features/chat/model/turns'
import { webSitesOfSteps } from '@/features/chat/model/webSites'
import type { ChatSource } from '@/api/chat'
import { formatCount } from '@/lib/format'

import { LinkText } from './LinkText'
import { StepIcon, StepOutcomeBadge, StepSpinner } from './stepIcons'
import { forceExpand, stepsOutcome, TraceStepRow } from './TraceStepRow'
import {
  STEP_BODY,
  STEP_ROW,
  STEP_TOGGLE,
  THINK_BLOCK,
  THINK_PARAGRAPH,
  caretClass,
  stepIconClass,
} from './traceStyles'
import { WebSiteList } from './WebSiteList'
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

  /**
   * 组那一行的开合：**默认开着的情况有两种**——用户自己开过，或者组里有一行
   * "必须看得见"（`forceExpand`，与单步那一行走的是同一个判据）。
   *
   * 为什么组也要管这一件：不成功的步骤折在组里等于没展开——用户扫过面板时看到的
   * 只是「联网搜索 3 次」，而其中一次其实是"没有执行"。判据不在这里另写一遍。
   *
   * 用户的点击照样压过默认值（与 `TraceStepRow` 同一个分寸）：默认展开不等于折不起来。
   * 这个钩子与下面两个判据**必须写在"单独一步"的提前 return 之前**：钩子的顺序不能随
   * 渲染分支变（写在 return 之后会被 lint 判成"条件调用"）。
   */
  const [groupChose, setGroupChose] = useState<boolean | null>(null)
  const groupForced = entry.kind === 'group' && entry.steps.some(forceExpand)
  /** 组里还有一次调用在跑（见 `turns.isRunningStep`）：那一行也要看得出来。 */
  const groupRunning = entry.kind === 'group' && entry.steps.some(isRunningStep)

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

  const open = groupChose ?? (chat.isGroupOpen(key) || groupForced)
  const toggle = () => {
    setGroupChose(!open)
    chat.toggleGroup(key)
  }

  /**
   * 这一组查了哪些站点（§12.334 第二节）。
   *
   * **汇总在组行上**：联网搜索动辄七八次、默认折着（`traceEntries` 把同类工具并成一行），
   * 如果只在每个子行上画牌子，用户要连点好几次才看得出"它在查哪些常见的网页"——
   * 而那正是用户提这件事的目的。汇总与单步走的是同一个 `webSitesOfSteps`
   * （组内几步并起来喂给它），不另写一套判据。
   */
  const sites = webSitesOfSteps(entry.steps)
  /** 组行的状态灯：组内第一条带状态位的调用（见 `stepsOutcome`）。 */
  const outcome = stepsOutcome(entry.steps)

  return (
    <li
      className={STEP_ROW}
      data-kind={entry.icon}
      data-running={groupRunning ? '' : undefined}
      data-outcome={outcome}
    >
      {/* 组那一行与单步**共用外壳**：图标位、圆底、起始线都走同一份取值 */}
      <span className={stepIconClass(entry.icon)}>
        <StepIcon icon={entry.icon} tool={entry.tool} label={entry.label} />
        {outcome ? <StepOutcomeBadge outcome={outcome} /> : groupRunning ? <StepSpinner /> : null}
      </span>
      <div className={STEP_BODY}>
        <button type="button" className={STEP_TOGGLE} aria-expanded={open} onClick={toggle}>
          {entry.label}
          <span className="text-[length:var(--text-micro-size)] text-[var(--text-quaternary)]">
            {formatCount(entry.steps.length)} 次
          </span>
          <ChevronDown className={caretClass(open)} size={12} />
        </button>
        {/* 组行上那一排站点：默认折着的时候也看得见（见上面 `sites` 的说明） */}
        <WebSiteList sites={sites.sites} more={sites.more} />
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

        三种状态各写什么：**执行期间**一个静态短标签（见下面那段，实时文案已按用户
        要求整条删掉）；**跑完且有出处**写 `traceSummary`；跑完又没出处则**只留箭头**——
        那时它会说"本轮没有命中资料 / 直接作答"，用户原话是"没啥用"。
        无论哪一种，收起/展开都点得到。
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
          /*
            执行期间这一行只写一个**静态名字**。

            原先这里是那条会滚的实时文案（「正在抓取网页…」/ 思考的尾巴 /
            「正在处理…」，由 `turns.liveLine` 给）：它挂在助手列的第一个节点上，
            与头像齐平，用户原话是"把 agent 执行中跟头像齐平的那个流式输出干掉"——
            整条删掉了（函数与它的用例一起，见 `model/README.md` §3.3）。

            但删掉之后这一行会只剩一枚箭头，看起来像残留符号，而它恰恰是**唯一**
            能点开这一块的地方。所以补一个静态短标签说明"这一行是什么"：
            它不随任何状态变化（没有要实时报告的东西了），只负责让人看出这里能点开。
          */
          <span className="text-[length:var(--text-micro-size)] text-[var(--text-secondary)]">
            执行过程
          </span>
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
