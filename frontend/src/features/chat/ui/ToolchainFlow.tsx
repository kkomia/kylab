/**
 * 工具链块（ToolchainFlow）——旧 TracePanel 的替代物，《对话UI-重做-设计》§4 的核心。
 *
 * 与旧面板的四条根本区别：
 *
 * 1. **一条缩进轴**：所有子项对齐同一根竖向引导线（`.ch-body` 的 0.5px hairline），
 *    不再"面板里再套面板"；
 * 2. **开合口径沿用 `isTraceOpen` 那一份**（流式展开 / 答完收起 / 用户点过听用户 /
 *    待确认强制展开）——那一套四规则已是定稿，本组件只管"按档画"，不自己再判；
 * 3. **行即状态**：running 的行是流光字（`.ch-live`，不是转圈——「那个蓝色循环圈
 *    没有用」是用户原话），done 的行带耗时，被拦下/等确认/失败的行前置展开且着色；
 * 4. **动效抄 Kimi 源码**：折叠走 grid-rows 时序编排（先消失再收拢 / 先展开再淡入），
 *    新行入场 `ch-in`（blur→0 + 8px 上浮），滚动区 35px 五段阶梯渐隐。
 *
 * 数据全部来自 `model/turns.ts` 的派生层（`traceEntries` / `trailingThinking` /
 * `traceSummary`）——这一层不重新发明任何判定。
 *
 * **开合状态是宿主给的**（`expansion`）：单步/组的"他点开过没有"挂在
 * `ChatProvider` 上（换会话再回来还在），本组件自己不存——所以这里的 key 一律先过
 * `traceKey(turnIndex, ·)` 套上轮次前缀再交出去（跨轮串号是钉过的真 bug）。
 *
 * 样式的 token 与 keyframes 在 `flow.css`（Kimi 源码值，chat 域局部，不碰全局）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, FileText } from 'lucide-react'

import type { ChatSource } from '@/api/chat'
import { formatCount, formatMillis } from '@/lib/format'

import {
  groupHeading,
  isBlockRunning,
  isRunningStep,
  resultPreview,
  sourceWhere,
  thinkingParagraphs,
  traceEntries,
  traceKey,
  traceSummary,
  trailingThinking,
  type TraceEntry,
  type TraceStep,
  type Turn,
} from '../model/turns'
import './flow.css'
import { StepIcon, StepOutcomeBadge, type StepOutcome } from './stepIcons'
import { StepResult } from './StepResult'

/**
 * 行级开合的宿主接口（`ChatProvider` 的 openSteps / openGroups 那两份表的投影）。
 * `groupChoice` 三档：他开过 / 他收过 / 没碰过（`undefined`）——没碰过的组才看
 * "还在跑就摊开"那条默认档。
 */
export interface FlowExpansion {
  isOpen: (key: string) => boolean
  toggle: (key: string) => void
  groupChoice: (key: string) => boolean | undefined
  chooseGroup: (key: string, open: boolean) => void
}

/** `step.outcome` 是裸 string；只有这三档进状态灯与着色（其余当正常）。 */
function outcomeOf(step: TraceStep): StepOutcome | undefined {
  return step.outcome === 'failed' || step.outcome === 'blocked' || step.outcome === 'awaiting'
    ? step.outcome
    : undefined
}

/**
 * 折叠容器（Kimi 时序版）。
 *
 * 不直接用旧 `Fold`：那一版的过渡是 200ms 匀速、没有 blur 编排（它随旧面板一起退役）。
 * `everOpened` 那一条保留——从没展开过的块内容不上 DOM（几十轮时的 DOM 开销是真的），
 * 展开过一次之后常驻，于是"展开 → 收起 → 再展开"每一次都有过渡。
 */
function FlowFold({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  const [everOpened, setEverOpened] = useState(open)
  useEffect(() => {
    if (open) setEverOpened(true)
  }, [open])
  return (
    <div className="ch-clp" data-open={open} data-fold={open ? 'open' : 'closed'} id={id}>
      <div className="ch-clp-in">{open || everOpened ? children : null}</div>
    </div>
  )
}

/**
 * 限高滚动区 + 上下 35px 五段阶梯渐隐。
 *
 * 渐隐层是 sticky 钉在滚动盒两端的（源码机制），`data-on` 由滚动位置切换：
 * 到顶了上渐隐就消失，到底了下渐隐就消失——渐隐说的是"那边还有"。
 */
function FadeScroll({ sites, children }: { sites?: boolean; children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [topOn, setTopOn] = useState(false)
  const [bottomOn, setBottomOn] = useState(false)

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const update = (): void => {
      setTopOn(box.scrollTop > 1)
      setBottomOn(box.scrollHeight - box.scrollTop - box.clientHeight > 1)
    }
    update()
    box.addEventListener('scroll', update, { passive: true })
    return () => box.removeEventListener('scroll', update)
  }, [children])

  return (
    <div className="ch-scroll">
      <div ref={boxRef} className={sites ? 'ch-scroll-box ch-scroll-box--sites' : 'ch-scroll-box'}>
        <div className="ch-fade ch-fade-top" data-on={topOn} aria-hidden />
        {children}
        <div className="ch-fade ch-fade-bottom" data-on={bottomOn} aria-hidden />
      </div>
    </div>
  )
}

/** 思考正文：B3 灰字（14/22），按段切开（段距比整串 pre-wrap 的一整行空档收敛）。 */
function Thinking({ text }: { text: string }) {
  return (
    <FadeScroll>
      <div className="ch-think" data-thinking>
        {thinkingParagraphs(text).map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
    </FadeScroll>
  )
}

/** 单步（或组内一次调用）那一行。 */
function StepRow({
  step,
  sub,
  open,
  onToggle,
}: {
  step: TraceStep
  /** 组内子行：5px 圆点取代图标（层级语言与旧面板一致）。 */
  sub?: boolean
  open: boolean
  onToggle: () => void
}) {
  const running = isRunningStep(step)
  const outcome = outcomeOf(step)
  const hasBody = Boolean(step.args || step.result || (step.thinking ?? '').trim())
  return (
    <div className={sub ? 'ch-sub' : undefined}>
      <button
        type="button"
        className="ch-row"
        data-kind={step.kind}
        data-outcome={outcome}
        data-running={running || undefined}
        aria-expanded={hasBody ? open : undefined}
        aria-disabled={!hasBody}
        onClick={hasBody ? onToggle : undefined}
      >
        {sub ? (
          <span className="ch-sub-dot" aria-hidden />
        ) : (
          <span style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}>
            <StepIcon icon={step.icon} tool={step.tool} label={step.label} />
            {outcome && <StepOutcomeBadge outcome={outcome} />}
          </span>
        )}
        <span className={running ? 'ch-row-label ch-live' : 'ch-row-label'}>{step.label}</span>
        {step.detail && <span className="ch-row-detail">{step.detail}</span>}
        <span className="ch-row-right">
          {running && <span data-running-text>进行中</span>}
          {!running && step.durationMs != null && (
            <span data-duration>{formatMillis(step.durationMs)}</span>
          )}
          {hasBody && (
            <ChevronDown
              size={14}
              className="ch-chev"
              style={{ transform: open ? 'rotate(180deg)' : undefined }}
              aria-hidden
            />
          )}
        </span>
      </button>
      {hasBody && (
        <FlowFold open={open}>
          {(step.thinking ?? '').trim() && <Thinking text={step.thinking ?? ''} />}
          {step.args && (
            <pre className="ch-raw" data-args>
              {step.args}
            </pre>
          )}
          {step.result && <StepResult text={resultPreview(step.result) ?? step.result} />}
        </FlowFold>
      )}
    </div>
  )
}

/** 同类工具并成的一组（`traceEntries` 的口径：只有一次的不并）。 */
function GroupRow({
  entry,
  expansion,
  k,
}: {
  entry: Extract<TraceEntry, { kind: 'group' }>
  expansion: FlowExpansion
  /** 套过轮次前缀的 key 工厂。 */
  k: (key: string) => string
}) {
  const running = entry.steps.some(isRunningStep)
  // 没碰过的组看"还在跑就摊开"；他点过的（开/收）完全听他的
  const open = expansion.groupChoice(k(entry.key)) ?? running
  // 耗时只加"界面真看着跑完"的那些（见 TraceStep.durationMs 的口径）；一个都没有就不显示
  const duration = entry.steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0)
  const bodyId = `flow-group-${k(entry.key)}`
  return (
    <div>
      <button
        type="button"
        className="ch-row"
        data-kind={entry.steps[0]?.kind}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => expansion.chooseGroup(k(entry.key), !open)}
      >
        <StepIcon icon={entry.icon} tool={entry.tool} label={entry.label} />
        {/* 标题是"与对象绑定的聚合句"（§12.333）：数目数对象、对象列出来，
            不是干巴巴的「N 次」——那会被读成"每次都成了" */}
        <span className={running ? 'ch-row-label ch-live' : 'ch-row-label'}>
          {groupHeading(entry)}
        </span>
        <span className="ch-row-right">
          {running && <span data-running-text>进行中</span>}
          {!running && duration > 0 && <span data-duration>{formatMillis(duration)}</span>}
          <ChevronDown
            size={14}
            className="ch-chev"
            style={{ transform: open ? 'rotate(180deg)' : undefined }}
            aria-hidden
          />
        </span>
      </button>
      <FlowFold open={open} id={bodyId}>
        {entry.steps.map((step) => (
          <StepRow
            key={step.key}
            step={step}
            sub
            open={outcomeOf(step) !== undefined || expansion.isOpen(k(step.key))}
            onToggle={() => expansion.toggle(k(step.key))}
          />
        ))}
      </FlowFold>
    </div>
  )
}

/** 整轮那一串思考（老消息兜底，`trailingThinking` 的口径：新数据已经在各自步骤里）。 */
function TrailingThinkingRow({
  text,
  streaming,
  open,
  onToggle,
}: {
  text: string
  streaming: boolean
  open: boolean
  onToggle: () => void
}) {
  return (
    <div>
      <button type="button" className="ch-row" aria-expanded={open} onClick={onToggle}>
        <span className="ch-bullet" aria-hidden>
          •
        </span>
        <span className={streaming ? 'ch-row-label ch-live' : 'ch-row-label'}>
          {streaming ? '思考中…' : `思考已完成 · ${formatCount(text.length)} 字`}
        </span>
        <span className="ch-row-right">
          <ChevronDown
            size={14}
            className="ch-chev"
            style={{ transform: open ? 'rotate(180deg)' : undefined }}
            aria-hidden
          />
        </span>
      </button>
      <FlowFold open={open}>
        <Thinking text={text} />
      </FlowFold>
    </div>
  )
}

/**
 * 来源（这一轮引用的片段）：默认收起，展开出文档清单。
 *
 * 行上的 `data-source` 与闪一下（`data-flash`）是给「点正文徽标 → 展开 → 滚到那一条 →
 * 闪一下」那条链路用的（`ChatProvider.revealSource`，三步缺一不可）；点行本身则交给
 * 宿主（`onOpenSource`）开出处抽屉。
 */
function SourcesRow({
  turnIndex,
  sources,
  open,
  onToggle,
  flashSource,
  onOpenSource,
}: {
  turnIndex: number
  sources: readonly ChatSource[]
  open: boolean
  onToggle: () => void
  flashSource: string
  onOpenSource?: (source: ChatSource) => void
}) {
  const documents = new Set(sources.map((item) => item.document_id)).size
  return (
    <div>
      <button
        type="button"
        className="ch-row"
        aria-expanded={open}
        onClick={onToggle}
        data-testid="flow-sources"
      >
        <FileText size={13} aria-hidden />
        <span className="ch-row-label">
          {formatCount(sources.length)} 个来源 · {formatCount(documents)} 篇文档
        </span>
        <span className="ch-row-right">
          <ChevronDown
            size={14}
            className="ch-chev"
            style={{ transform: open ? 'rotate(180deg)' : undefined }}
            aria-hidden
          />
        </span>
      </button>
      <FlowFold open={open}>
        <FadeScroll sites>
          {sources.map((source) => (
            <button
              key={source.chunk_id}
              type="button"
              className="ch-src"
              data-source={source.index}
              data-flash={flashSource === `${turnIndex}:${source.index}` || undefined}
              onClick={onOpenSource ? () => onOpenSource(source) : undefined}
            >
              <span className="ch-src-name">{source.document_name}</span>
              <span className="ch-src-where">{sourceWhere(source)}</span>
            </button>
          ))}
        </FadeScroll>
      </FlowFold>
    </div>
  )
}

/**
 * 一轮的工具链块。`open` / `onToggle` 与各行开合都由宿主持有（判定分别在
 * `isTraceOpen` 与 provider 那两份表，**各只有一份**）。
 * 没有步骤、没有思考、没有来源的一轮（直接作答）**整块不画**。
 */
export function ToolchainFlow({
  turn,
  turnIndex,
  open,
  onToggle,
  expansion,
  citesOpen,
  onToggleCites,
  flashSource = '',
  onOpenSource,
}: {
  turn: Turn
  turnIndex: number
  open: boolean
  onToggle: () => void
  expansion: FlowExpansion
  citesOpen: boolean
  onToggleCites: () => void
  /** `${turnIndex}:${sourceIndex}`（或 ''）——要点亮的那一条来源行。 */
  flashSource?: string
  onOpenSource?: (source: ChatSource) => void
}) {
  const k = (key: string): string => traceKey(turnIndex, key)

  const message = turn.reply
  if (!message) return null
  /*
   * 「这一轮有没有真东西」只看真实数据（步骤 / 思考 / 来源）：`traceEntries` 对老消息会
   * 合成 legacy 兜底行（至少有一条「已生成回答」），拿它判"画不画"会让**每一轮**都顶着
   * 一个块——直接作答不该有工具链块（Kimi 也没有）。
   */
  const thinking = trailingThinking(message)
  if (
    message.steps.length === 0 &&
    !thinking &&
    message.sources.length === 0 &&
    !message.thinking?.enabled
  ) {
    return null
  }
  const entries = traceEntries(turn)

  const running = isBlockRunning(message)
  // 点正文徽标会把来源清单撑开（`revealSource`）：那时块体也得开着，否则滚不到那一行
  const bodyOpen = open || citesOpen
  return (
    <div className="ch-flow" data-testid="toolchain-flow">
      <button
        type="button"
        className="ch-head"
        data-testid="trace-toggle"
        aria-expanded={bodyOpen}
        onClick={onToggle}
        data-running={running || undefined}
      >
        <span className={running ? 'ch-summary ch-live' : 'ch-summary'}>
          {traceSummary(message)}
        </span>
        {message.steps.length > 0 && (
          <span className="ch-head-meta">{formatCount(message.steps.length)} 步</span>
        )}
        <ChevronDown size={16} className="ch-chev" aria-hidden />
      </button>
      <FlowFold open={bodyOpen}>
        <div className="ch-body">
          {entries.map((entry) =>
            entry.kind === 'group' ? (
              <GroupRow key={entry.key} entry={entry} expansion={expansion} k={k} />
            ) : (
              <StepRow
                key={entry.key}
                step={entry.step}
                open={outcomeOf(entry.step) !== undefined || expansion.isOpen(k(entry.step.key))}
                onToggle={() => expansion.toggle(k(entry.step.key))}
              />
            ),
          )}
          {thinking && (
            <TrailingThinkingRow
              text={thinking}
              streaming={Boolean(message.streaming)}
              open={expansion.isOpen(k('thinking'))}
              onToggle={() => expansion.toggle(k('thinking'))}
            />
          )}
          {message.sources.length > 0 && (
            <SourcesRow
              turnIndex={turnIndex}
              sources={message.sources}
              open={citesOpen}
              onToggle={onToggleCites}
              flashSource={flashSource}
              onOpenSource={onOpenSource}
            />
          )}
        </div>
      </FlowFold>
    </div>
  )
}
