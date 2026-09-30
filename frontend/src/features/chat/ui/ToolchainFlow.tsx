/**
 * 工具链块（ToolchainFlow）——旧 TracePanel 的替代物，《对话UI-重做-设计》§4 的核心。
 *
 * 与旧面板的四条根本区别：
 *
 * 1. **一条缩进轴**：所有子项对齐同一根竖向引导线（`.ch-item` 的 `::after` 虚线，
 *    `left:10px` = 图标槽中心），不再"面板里再套面板"；
 * 2. **开合口径沿用 `isTraceOpen` 那一份**（流式展开 / 答完收起 / 用户点过听用户 /
 *    待确认强制展开）——那一套四规则已是定稿，本组件只管"按档画"，不自己再判；
 * 3. **行即状态**：running 的行是流光字（`.ch-live`，不是转圈——「那个蓝色循环圈
 *    没有用」是用户原话）+ 图标位那枚**半月旋转 dot**（`.ch-loading-dot`，
 *    2026-09-30 用户批注照 kimi.com 的 `widget-loading-dot`），被拦下/等确认/失败的行
 *    前置展开且着色；**行级耗时一律不印**（2026-09-30 用户批注：单步行与组行都撤，
 *    整轮那一处总计行报耗时），行详情不印原始 JSON（`displayDetail` 从 `find_tools`
 *    的返回里取工具名，见 `model/turns.ts`）；
 * 4. **动效与结构都按生产 CSS 落地**（2026-09-30 第二版纠偏）：
 *    - 链：每个条目 `.ch-item`（`position:relative` + 行间 `margin-top:12px`），虚线是它自己的
 *      `::after`（`.5px dashed`、`top:24px/bottom:-12px`），**末行无线由 `:not(:last-child)` 保证**
 *      ——判据在 DOM 结构里，不由这一层算相邻；
 *    - 折叠：整块头部那层 `.25s/.38s`，**行内**展开另走 `.48s` 体系（`.ch-clp--row`）；
 *    - 入场：`ch-in`（blur→0 + 8px 上浮，链内 .38s，**没有逐项 delay**）；
 *    - 行尾箭头平时不出现，悬停/聚焦才滑入，展开态常显并转 90°；
 *    - 滚动区 35px 五段阶梯渐隐 + 隐藏原生滚动条。
 * 5. **R4 三件**（2026-09-30 用户批注后口径更新）：原文用 **Request / Response 面板**
 *    （JSON 缩进着色 + 行号槽，见 `StepPayload`）——**联网那两档除外**：联网搜索与
 *    抓取网页的展开**只留网页清单**（搜索是 favicon + 标题 + 域名，抓页是 favicon +
 *    完整 URL），面板与"列表之外的那段原文"一并撤（用户原话"搜索网页的不显示 request
 *    和 response，只显示网页列表"；抓页同档处理，与 Kimi 一致）；抓页那一档的行是
 *    「[favicon] N 个网页」；落定后的「组织回答」行不画（判据 `visibleEntries`，
 *    块出不出问 `hasFlow`）。
 * 6. **头部只有总名与箭头**（2026-09-30 用户批注：总标题不加图标）——此前那条
 *    "Kimi 的工具链标题是图标 + 摘要"的判断已被用户推翻：段首那枚 `FileText` 图标槽
 *    连同它在 `flow.css` 里的 `.ch-head-icon` 一并撤掉，头部只剩总名 + chevron。
 *
 * 数据全部来自 `model/turns.ts` 的派生层（`traceEntries` / `trailingThinking` /
 * `groupHeading`）——这一层不重新发明任何判定；这里唯一的"策略"是**头部总名怎么拼**
 * （`toolTotal`：`使用 N 个工具，动作短语`），它也只是把那一层的输出接起来。
 *
 * **开合状态是宿主给的**（`expansion`）：单步/组的"他点开过没有"挂在
 * `ChatProvider` 上（换会话再回来还在），本组件自己不存——所以这里的 key 一律先过
 * `traceKey(turnIndex, ·)` 套上轮次前缀再交出去（跨轮串号是钉过的真 bug）。
 *
 * 样式的 token 与 keyframes 在 `flow.css`（Kimi 源码值，chat 域局部，不碰全局）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, FileText } from 'lucide-react'

import type { ChatSource } from '@/api/chat'
import { formatCount } from '@/lib/format'

import { fetchedPagesOfSteps, webCitationsOfSteps } from '../model/sourceCitations'
import {
  displayDetail,
  groupHeading,
  humanizeArtifactKeys,
  isBlockRunning,
  isRunningStep,
  resultPreview,
  sourceWhere,
  thinkingParagraphs,
  thinkingTitle,
  THINKING_DONE_TITLE,
  traceEntries,
  traceKey,
  traceSteps,
  trailingThinking,
  type TraceEntry,
  type TraceIcon,
  type TraceStep,
  type Turn,
} from '../model/turns'
import { isWebStep, webSitesOfSteps } from '../model/webSites'
import './flow.css'
import { FetchPages, SearchHits } from './SearchHits'
import { StepDot, StepIcon, StepOutcomeBadge, type StepOutcome } from './stepIcons'
import { RequestPanel } from './StepPayload'
import { StepResult } from './StepResult'
import { WebSiteIcons, WebSiteList } from './WebSiteList'

/**
 * 聚合行标题里那个「 · 」——**拆成"标签 + 详情"两截**（2026-09-30 R2 批注）。
 *
 * 生产里这些行是「标签(Secondary) + 0.5px×14px 竖条 + 详情(Tertiary)」，而我们的聚合句
 * （`groupHeading`）是把两截焊在一个字符串里的。这一层只做**显示**上的切分：在**第一个**
 * 「 · 」处断开，前半是标签、后半进详情槽（走 `.ch-row-sep` + `.ch-row-detail`，
 * 与普通步行同一套）。调用方两处：组行渲染（标签 + 详情分画）与头部总名的短语提取
 * （`toolTotal` 只要标签那半）。
 *
 * 两条分寸：
 *
 * 1. **没有「 · 」就原样返回**：正在跑的聚合句（「正在检索 X… 1/3」）、老快照那句
 *    「联网搜索 2 次」都走这一支，一个字不动；
 * 2. **只在聚合行上用**：来源行那句「N 个来源 · M 篇文档」是**两个计数并列**，
 *    不是"标签 | 详情"的语义，所以它不调用这个函数（保持原样）。思考行也一样
 *    ——它的标题跟着开合走、不再带「 · N 字」（2026-09-30 用户批注）。
 *
 * 切的是**渲染**，不是数据：`groupHeading()` 的返回值与它的用例断言一个字都没改。
 */
function splitLabel(text: string): { label: string; detail: string } {
  const at = text.indexOf(' · ')
  if (at < 0) return { label: text, detail: '' }
  return { label: text.slice(0, at), detail: text.slice(at + 3) }
}

/**
 * 头部总名的两个数——**Kimi 的"动作态"策略**（2026-09-30 R3 批注）。
 *
 * 生产里工具链头部不是"结果态"（「本轮没有命中资料」这种），而是「使用 19 个工具，
 * 生成今日早报并列出工具」——**用了几个工具 + 干了什么**。所以这一层按同一形状派生：
 *
 * - `count` = **原始工具步数**：聚合前的每一次调用都算一次（两次读文件 = 2 次），
 *   与 Kimi「19 个工具」同口径。非工具步（组织回答 / 思考）一律不计。
 * - `phrases` = **聚合后的动作短语**，与行文案**同源**、不新造词表：组行取
 *   `groupHeading` 那句的标签段（「检索 3 个问题」「回忆 1 个主题」…），
 *   单条工具步取它自己的 `label`（「导出文档」「抓取网页」…）；按出现顺序去重、
 *   顿号连接，太长由头部的单行省略自然截断。
 *
 * 吃的是**本组件已经算好的** `traceEntries(turn)`（就是渲染成一行的那个口径），
 * 所以头部的数与展开后看到的行天然对得上——组行的数是"对象数"、这里数是"调用次数"，
 * 两者按生产各说各的（Kimi 也是这样：19 个工具，但行里是「读取 2 个文件」）。
 * `count` 的口径与 `model/turns.ts::countCalls`（「已显示 X/Y 条工具调用」用的那个）逐字相同。
 */
function toolTotal(entries: readonly TraceEntry[]): { count: number; phrases: string[] } {
  const phrases: string[] = []
  const seen = new Set<string>()
  let count = 0
  for (const entry of entries) {
    // 非工具步（组织回答 / 思考）在 `TraceStep` 上没有 `tool`，天然被排除
    const phrase =
      entry.kind === 'group'
        ? splitLabel(groupHeading(entry)).label
        : entry.step.tool
          ? entry.step.label
          : ''
    if (!phrase) continue
    count += entry.kind === 'group' ? entry.steps.length : 1
    if (seen.has(phrase)) continue
    seen.add(phrase)
    phrases.push(phrase)
  }
  return { count, phrases }
}

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

/** 没有名表时的空表（模块级一份：默认值不该每帧换身份）。 */
const NO_NAMES: ReadonlyMap<string, string> = new Map()

/** `step.outcome` 是裸 string；只有这三档进状态灯与着色（其余当正常）。 */
function outcomeOf(step: TraceStep): StepOutcome | undefined {
  return step.outcome === 'failed' || step.outcome === 'blocked' || step.outcome === 'awaiting'
    ? step.outcome
    : undefined
}

/** 组的状态灯 = 组内第一条带状态位的调用（与组行图标取组内第一步同一口径）。 */
function groupOutcomeOf(steps: readonly TraceStep[]): StepOutcome | undefined {
  for (const step of steps) {
    const outcome = outcomeOf(step)
    if (outcome) return outcome
  }
  return undefined
}

/**
 * 老快照兜底词表（随旧 TraceStepRow 退役**搬**过来的，行为一字未变）：
 * 那时步骤里没有 `outcome` 字段，"这一行说的不是成功"只能按句式认。
 * 新数据一律看结构化字段，这张表只对**字段缺省**的老数据生效。
 */
const REFUSAL_MARKS = ['没有执行', '等待确认', '拒绝执行', '不能执行命令']

/**
 * 这一步**必须看得见**吗——「前置展开」的唯一判据（单步与组内子行共用）：
 * `outcome` 字段在（含 `""` = 正常）就听它的；字段不在（老快照）回退认词表。
 */
function forceExpand(step: TraceStep): boolean {
  if (step.outcome !== undefined) return outcomeOf(step) !== undefined
  return REFUSAL_MARKS.some((mark) => step.detail.includes(mark))
}

/**
 * 这一行的图标位画**圆点**还是**那一档的图形**（2026-09-30 用户批注 §2）。
 *
 * 只有非工具的两档（思考 / 组织回答）画圆点——它们是"过程的一句话"；
 * 工具行（检索、联网、执行…）一律保留各自那一枚，那正是"这一步干了什么"的第一眼线索。
 * 判据取 `TraceStep.icon`（渲染层那一档），与 `StepIcon` 的入参同一个字段。
 */
function isDotIcon(icon: TraceIcon): boolean {
  return icon === 'think' || icon === 'build'
}

/*
 * 虚线链路**不再由这一层算**（2026-09-30 第二版按生产纠偏）：生产是把线画在
 * `toolcall-flow__item` 自己的 `::after` 上、由 `:not(:last-child)` 保证末行没有线——
 * 判据落在 DOM 结构里，一眼看得见，也不会出现"JS 算错一档、整块少一条线"。
 * 见 `flow.css` 的 `.ch-item:not(:last-child)::after`。
 */

/**
 * 「跑了多久」的显示（沿用旧面板照 LobeHub 的三档，单位换成中文）：
 * 不足 1 秒给毫秒（`123 毫秒`）；不足 1 分钟给**向下取**的一位小数（`1.2 秒`，
 * 59.96 秒不许印成 60.0）；再长给 `N 分 M 秒`。
 *
 * **现在只有一处消费者：整轮那一行总计**（2026-09-30 用户批注：行级的耗时全撤——
 * 单步行与组行都不印，用户要的是"这一轮一共跑了多久"，不是逐行报数）。
 * 函数本身留着不删就是为这一处。
 */
export function formatStepDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  if (ms < 60_000) return `${Math.floor(ms / 100) / 10} 秒`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`
}

/**
 * 折叠容器（Kimi 时序版）。
 *
 * 不直接用旧 `Fold`：那一版的过渡是 200ms 匀速、没有 blur 编排（它随旧面板一起退役）。
 * `everOpened` 那一条保留——从没展开过的块内容不上 DOM（几十轮时的 DOM 开销是真的），
 * 展开过一次之后常驻，于是"展开 → 收起 → 再展开"每一次都有过渡。
 *
 * **两档时序**（生产里也是两层不同的类）：整块头部那层是 `.ch-clp`（.25s/.38s，
 * `toolcall-flow__summary-clp`）；**行内**展开那层是 `.ch-clp--row`（.48s 体系，
 * `toolcall-flow__collapse` + `.collapse-inner`）——所以这里多一个 `row` 开关。
 */
function FlowFold({
  open,
  row,
  sub,
  id,
  children,
}: {
  open: boolean
  /** 行内展开那一层（工具行 / 思考行 / 来源行）：`.48s` 体系，内容从 label 列起（缩进 28px）。 */
  row?: boolean
  /** 组内子行那一层：同一套 `.48s` 时序，但**不缩进**——里面是子步行，它们有自己的缩进轴。 */
  sub?: boolean
  id?: string
  children: ReactNode
}) {
  const [everOpened, setEverOpened] = useState(open)
  useEffect(() => {
    if (open) setEverOpened(true)
  }, [open])
  const kind = sub ? 'ch-clp ch-clp--sub' : row ? 'ch-clp ch-clp--row' : 'ch-clp'
  return (
    <div className={kind} data-open={open} data-fold={open ? 'open' : 'closed'} id={id}>
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
  names,
}: {
  step: TraceStep
  /** 组内子行：5px 圆点取代图标（层级语言与旧面板一致）。 */
  sub?: boolean
  open: boolean
  onToggle: () => void
  /** `art_*` → 真实文件名（`humanizeArtifactKeys`）；没有就空表。 */
  names: ReadonlyMap<string, string>
}) {
  const running = isRunningStep(step)
  const outcome = outcomeOf(step)
  /**
   * 这一步是不是"上网"那一档（联网搜索 / 抓取网页）——判据取自 `model/webSites.ts`
   * 那一份（`isWebStep`），与图标分档、清单解析**同源**，不在这里另认一遍工具名。
   */
  const web = isWebStep({ tool: step.tool, label: step.label })
  /**
   * 行详情那一格印什么：普通结论原样，**原始 JSON 一律不印**（2026-09-30 用户批注；
   * `find_tools` 那种返回换成它 `found` 里的工具名，取不到就是空串——判据与分寸
   * 全在 `displayDetail` 里，这一层不重判一遍）。
   */
  const detail = displayDetail(step)
  // 返回默认只铺预览（600 字），被裁掉的才给「加载全部」——长 JSON 不该全铺
  const [showAll, setShowAll] = useState(false)
  const preview = step.result ? resultPreview(step.result) : null
  /**
   * 联网搜索那一步的**结果清单**（`SearchHits` 的料）。
   *
   * `useMemo` 不是提前优化：这一步在流式里每一拍都会重渲染，而解析是逐行扫返回文本的，
   * 一趟几十条搜索就是几十次白扫。依赖只写三个**原始值**（步骤对象每帧都是新的）。
   */
  const hits = useMemo(
    () =>
      step.result
        ? [
            ...webCitationsOfSteps([
              { tool: step.tool, label: step.label, result: step.result },
            ]).values(),
          ]
        : [],
    [step.result, step.tool, step.label],
  )
  /**
   * 抓页那一档**读到的页**（行上的 favicon + 页数、**展开后的清单**都用它）。
   *
   * 不是抓页、或解析不出来就是空数组——行上那一格照旧铺后端给的结论（不造内容）。
   * `useMemo` 的依赖只写四个**原始值**：这一步在流式里每一拍都会重渲染。
   */
  const pages = useMemo(
    () =>
      fetchedPagesOfSteps([
        { tool: step.tool, label: step.label, args: step.args, result: step.result },
      ]),
    [step.tool, step.label, step.args, step.result],
  )
  /** 这一档的展开内容 = **网页清单**（搜到的那几条 / 抓回来的那几页，两者互斥）。 */
  const hasList = hits.length > 0 || pages.length > 0
  /**
   * 展开区里**有没有东西**。
   *
   * 非联网的行照旧（入参 / 返回 / 行内思考任一有就算）；**联网那两档只认网页清单**——
   * 2026-09-30 用户批注之后它们的展开区里只剩清单（Request / Response 面板与清单之外的
   * 原文都不再画，见下面的行体），清单也解不出来时这一行就不给"能点开"的许诺
   * （点了是个空盒子，箭头也是假的）。行内思考仍算数：它是这一步自己的话，不是原文。
   */
  const hasBody = web
    ? hasList || (step.thinking ?? '').trim() !== ''
    : Boolean(step.args || step.result || (step.thinking ?? '').trim())
  /**
   * 这一步是**前置展开**的（失败 / 被拦下 / 等确认：`forceExpand`）——那种行 `open` 恒为真、
   * 点也收不起来，所以**不画行尾那枚箭头**（摆了等于许诺一个点不动的动作）。
   * 顶层行与组内子行走的是同一个判据（R2 批注：两层行为一致）。
   */
  const forced = forceExpand(step)
  return (
    /* 链内每个条目都是 `.ch-item`（生产 `.toolcall-flow__item`）：虚线由它的 `::after`
       按 `:has(~ .ch-item)` 画出来（末行没有），行距由 `.ch-item + .ch-item` 的 margin-top 给。
       组内子行（`sub`）不是链上的一环，单独用 `.ch-sub` 缩进。 */
    <div className={sub ? 'ch-sub' : 'ch-item'}>
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
          <span className="ch-icon-slot">
            {/*
              这一行**还在跑**：图标位换成那枚半月旋转 dot（2026-09-30 用户批注，照
              kimi.com 的 `widget-loading-dot`）——它取代的是"这一步是哪种工具"那一枚，
              不是状态灯，所以 outcome badge 照挂（`.ch-icon-slot` 是 20×20 的居中槽，
              与圆点槽同尺寸，标签与那条虚线都不动；样式在 `flow.css`）。
            */}
            {running ? (
              <span className="ch-loading-dot" aria-hidden />
            ) : isDotIcon(step.icon) ? (
              <StepDot icon={step.icon} />
            ) : (
              <StepIcon icon={step.icon} tool={step.tool} label={step.label} />
            )}
            {outcome && <StepOutcomeBadge outcome={outcome} />}
          </span>
        )}
        <span className={running ? 'ch-row-label ch-live' : 'ch-row-label'}>{step.label}</span>
        {/*
          详情位（Kimi 的行模式「标签 | 详情」，竖条由 `.ch-row-sep` 画）。两条分岔：
          - **抓页那一档** ＝ `[favicon] N 个网页`（R4 批注，Kimi 是「获取网页 | 🔴 1 个网页」）
            ——站点 favicon 与页数都收进这一格，行尾不再挂那一组站点牌；后端给的结论
            （抓页那一步是"【标题】来源：url…"被裁过的一段）不再进这一行，整页信息在展开里；
          - 其余 ＝ `displayDetail(step)`：普通结论原样，**原始 JSON 不再印上去**
            （2026-09-30 用户批注；`find_tools` 那种返回换成一串工具名，取不到就空着）。
        */}
        {pages.length > 0 ? (
          <>
            <span className="ch-row-sep" aria-hidden />
            <span className="ch-row-detail ch-row-detail--sites">
              <WebSiteIcons {...webSitesOfSteps([step])} />
              <span className="ch-row-count">{formatCount(pages.length)} 个网页</span>
            </span>
          </>
        ) : (
          detail && (
            <>
              <span className="ch-row-sep" aria-hidden />
              <span className="ch-row-detail">{detail}</span>
            </>
          )
        )}
        {/* 联网搜索那几类：查了哪些站点仍然标在行尾（牌子先画、真 logo 后换，见 WebSiteList）；
            抓页那一档已经收进上面那一格，不再重复挂一遍（R4 批注要撤的就是它） */}
        {!sub && pages.length === 0 && <WebSiteList {...webSitesOfSteps([step])} />}
        <span className="ch-row-right">
          {running && <span data-running-text>进行中</span>}
          {/* 行级耗时**撤了**（2026-09-30 用户批注：单步行与组行都不报）——耗时只在整轮
              那一处总计行给（见本文件末的 `.ch-total`），逐行报数读起来是噪声 */}
          {/* 行尾箭头：平时不画（悬停/聚焦才滑入，展开态常显并转 90°，见 `.ch-row .ch-chev`）；
              前置展开的行连元素都不给——它收不起来，箭头是假的 */}
          {hasBody && !forced && <ChevronRight size={18} className="ch-chev" aria-hidden />}
        </span>
      </button>
      {hasBody && (
        <FlowFold row open={open}>
          {(step.thinking ?? '').trim() && <Thinking text={step.thinking ?? ''} />}
          {web ? (
            /*
              **联网那两档的展开只剩一张网页清单**（2026-09-30 用户批注原话"搜索网页的
              不显示 request 和 response，只显示网页列表"；抓页同档处理，与 Kimi 一致）：

              - 抓取网页 → `FetchPages`（Kimi 的 `fetch-urls-item`：favicon + 完整 URL）；
              - 联网搜索 → `SearchHits`（favicon + 标题 + 域名，用户批注 §3 那套，一个字没动）。

              于是这一档里**没有** Request 面板（入参）、**也没有** Response 面板——连同
              原先接在清单下面的那段原文（搜索的"前 N 条的正文开头"、抓页去掉抬头后的正文）
              一并撤掉。行上那一格（详情 / `displayDetail`）仍然说着这一步的结论，
              清单之外的原始载荷不再铺（撤是用户点名的，不在这里找回）。

              清单包在 `FadeScroll` 里（用户批注 §10）：限高 256px + 底部 35px 阶梯渐隐 +
              隐藏原生滚动条，只有滚动盒给得出来（渐隐层是 sticky 的）。
            */
            <FadeScroll sites>
              {pages.length > 0 && <FetchPages hits={pages} />}
              {hits.length > 0 && <SearchHits hits={hits} />}
            </FadeScroll>
          ) : (
            <>
              {/* 其余工具行照旧：入参 / 返回两块 Request / Response 面板（`StepPayload`） */}
              {step.args && <RequestPanel text={humanizeArtifactKeys(step.args, names)} />}
              {step.result && (
                <>
                  <StepResult text={showAll ? step.result : (preview ?? step.result)} />
                  {preview !== null && (
                    <button
                      type="button"
                      className="ch-more"
                      onClick={() => setShowAll((value) => !value)}
                    >
                      {showAll ? '收起' : `加载全部（${formatCount(step.result.length)} 字）`}
                    </button>
                  )}
                </>
              )}
            </>
          )}
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
  names,
}: {
  entry: Extract<TraceEntry, { kind: 'group' }>
  expansion: FlowExpansion
  /** 套过轮次前缀的 key 工厂。 */
  k: (key: string) => string
  names: ReadonlyMap<string, string>
}) {
  const running = entry.steps.some(isRunningStep)
  // 没碰过的组看"还在跑就摊开"；他点过的（开/收）完全听他的
  const open = expansion.groupChoice(k(entry.key)) ?? running
  const bodyId = `flow-group-${k(entry.key)}`
  // 聚合句按「 · 」拆成"标签 + 详情"两截（R2 批注；判据与分寸见 `splitLabel`）
  const heading = splitLabel(groupHeading(entry))
  return (
    <div className="ch-item">
      <button
        type="button"
        className="ch-row"
        data-kind={entry.steps[0]?.kind}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => expansion.chooseGroup(k(entry.key), !open)}
      >
        <span className="ch-icon-slot">
          {/* 这一组**还在跑**：与单步行同一档——图标位换成那枚半月旋转 dot
              （2026-09-30 用户批注；组级的状态灯照挂，见下面一行） */}
          {running ? (
            <span className="ch-loading-dot" aria-hidden />
          ) : (
            <StepIcon icon={entry.icon} tool={entry.tool} label={entry.label} />
          )}
          {/* 组级状态灯 = 组内第一条带状态位的调用（与组行图标同口径） */}
          {groupOutcomeOf(entry.steps) && (
            <StepOutcomeBadge outcome={groupOutcomeOf(entry.steps)!} />
          )}
        </span>
        {/* 标题是"与对象绑定的聚合句"（§12.333）：数目数对象、对象列出来，
            不是干巴巴的「N 次」——那会被读成"每次都成了"。
            **「 · 」两截分开画**（2026-09-30 R2 批注）：前半是标签（Secondary），
            后半那段对象清单进详情槽（0.5px 竖条 + Tertiary）——与普通步行同一个行模式。 */}
        <span className={running ? 'ch-row-label ch-live' : 'ch-row-label'}>{heading.label}</span>
        {heading.detail && (
          <>
            <span className="ch-row-sep" aria-hidden />
            <span className="ch-row-detail">{heading.detail}</span>
          </>
        )}
        {/* 这一组查了哪些站点（联网组才有；一行 favicon 牌） */}
        <WebSiteList {...webSitesOfSteps(entry.steps)} />
        <span className="ch-row-right">
          {running && <span data-running-text>进行中</span>}
          {/* 组级耗时也**撤了**（2026-09-30 用户批注：单步行与组行都不报；整轮那一处总计行给） */}
          <ChevronRight size={18} className="ch-chev" aria-hidden />
        </span>
      </button>
      <FlowFold sub open={open} id={bodyId}>
        {entry.steps.map((step) => (
          <StepRow
            key={step.key}
            step={step}
            sub
            open={forceExpand(step) || expansion.isOpen(k(step.key))}
            onToggle={() => expansion.toggle(k(step.key))}
            names={names}
          />
        ))}
      </FlowFold>
    </div>
  )
}

/**
 * 整轮那一串思考（老消息兜底，`trailingThinking` 的口径：新数据已经在各自步骤里）。
 *
 * 标题三档（2026-09-30 用户批注，照 kimi.com 实测）：
 *
 * - **流式中**：「思考中…」+ 流光（`.ch-live`）；
 * - **落定且收起**：`thinkingTitle(text)`——**描述性**的首段首行（模型层派生，截 30 字），
 *   一个字都取不到时它自己回退「思考已完成」；
 * - **落定且展开**：固定 `THINKING_DONE_TITLE`（生产里点开之后标题就换成这一句）。
 *
 * 「 · N 字」那个字数详情**一并撤掉**（同一条批注）：标题是"这段在讲什么"，
 * 不是读数；过程总计那一行如今也只剩耗时一个读数（见文件末的 `.ch-total`）。
 */
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
  const title = streaming ? '思考中…' : open ? THINKING_DONE_TITLE : thinkingTitle(text)
  return (
    <div className="ch-item">
      <button type="button" className="ch-row" aria-expanded={open} onClick={onToggle}>
        {/* 圆点与工具行里那两档（思考 / 组织回答）同款：Kimi「思考已完成」就是一枚实心小圆点 */}
        <StepDot icon="think" />
        <span className={streaming ? 'ch-row-label ch-live' : 'ch-row-label'}>{title}</span>
        <span className="ch-row-right">
          <ChevronRight size={18} className="ch-chev" aria-hidden />
        </span>
      </button>
      <FlowFold row open={open}>
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
    <div className="ch-item">
      <button
        type="button"
        className="ch-row"
        aria-expanded={open}
        onClick={onToggle}
        data-testid="flow-sources"
      >
        <FileText size={15} aria-hidden />
        <span className="ch-row-label">
          {formatCount(sources.length)} 个来源 · {formatCount(documents)} 篇文档
        </span>
        <span className="ch-row-right">
          <ChevronRight size={18} className="ch-chev" aria-hidden />
        </span>
      </button>
      <FlowFold row open={open}>
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
 * 这一轮**真正画出来**的链项（R4 批注）。
 *
 * 与 `traceEntries(turn)` 只差一条：**落定之后的「组织回答」那一行不再画**
 * ——它没有可展开的内容（入参 / 返回都是空），用户原话"没有意义显示"。
 * **流式进行中那一行要留**：它是"正在组织回答"的活动指示（`.ch-live` 流光那行），
 * 也是"还没出正文"时过程区唯一在动的东西。
 *
 * 隐藏只影响**渲染**：T 计数、头部短语、聚合分组本来就不把非工具步算进去，
 * 所以那些口径一个字没变。
 */
export function visibleEntries(turn: Turn): TraceEntry[] {
  return traceEntries(turn).filter(
    (entry) => entry.kind === 'group' || entry.step.icon !== 'build' || isRunningStep(entry.step),
  )
}

/**
 * 这一轮的工具链块（以及正文上面那条灰线）**出不出**：链项 / 思考 / 来源，
 * 有一个就出。
 *
 * 与模型层 `hasTraceContent` 的差别只有一处：**纯直接作答那一轮整块不出**
 * ——那种轮次链上只剩一条「组织回答」，而它按 R4 已经不画了，块里空无一物
 * （Kimi 直接作答本来就没有块）。判据只有这一处：块的早退与那条灰线问的都是它。
 */
export function hasFlow(turn: Turn): boolean {
  const message = turn.reply
  if (!message) return false
  return (
    visibleEntries(turn).length > 0 ||
    trailingThinking(message) !== '' ||
    message.sources.length > 0
  )
}

/**
 * 一轮的工具链块。`open` / `onToggle` 与各行开合都由宿主持有（判定分别在
 * `isTraceOpen` 与 provider 那两份表，**各只有一份**）。
 * 没有链项、没有思考、没有来源的一轮（直接作答）**整块不画**（判据 `hasFlow`）。
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
  artifactNames = NO_NAMES,
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
  /** 入参里的 `art_*` → 真实文件名（`humanizeArtifactKeys` 的表）。 */
  artifactNames?: ReadonlyMap<string, string>
}) {
  const k = (key: string): string => traceKey(turnIndex, key)

  const message = turn.reply
  if (!message) return null
  /*
    块出不出：**链项 / 思考 / 来源三者有一个就出**（R4 起用的判据，见 `hasFlow`）。
    纯直接作答那一轮——链上只剩一条「组织回答」而它已经不画了——整块不出：
    Kimi 直接作答本来就没有块。（判据只有这一处，正文上面那条灰线问的也是它。）
  */
  if (!hasFlow(turn)) return null
  const thinking = trailingThinking(message)
  const entries = visibleEntries(turn)
  /*
    头部总名（R3 批注）。没有工具步的那一轮仍是「直接作答」——那是**语义照旧**的一句话
    （"这一轮没调工具"），不是结果态文案；「拒识 / 命中」那几档（本轮没有命中资料 /
    检索完成 · 引用了 N 个片段…）不再出现在头部，答案正文自己会说。
    流式进行中走同一条规则（T 随步数实时增长），不另搞"正在…"变体——行内的 `.ch-live`
    已经在承担进行态。
  */
  const tools = toolTotal(entries)
  const summary =
    tools.count > 0
      ? `使用 ${formatCount(tools.count)} 个工具，${tools.phrases.join('、')}`
      : '直接作答'

  const running = isBlockRunning({ streaming: message.streaming, steps: traceSteps(turn) })
  // 整轮那一处总计唯一的读数：各步耗时之和（`TraceStep.durationMs` 的口径见那边——
  // 只有"界面当场看着跑完"的步有它，历史回放一律没有，于是总和为 0、整行不画）
  const stepsAll = traceSteps(turn)
  const traceMs = stepsAll.reduce((sum, step) => sum + (step.durationMs ?? 0), 0)
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
        {/* 头部**只有总名与箭头**（2026-09-30 用户批注：总标题不加图标）。改前这里有一格
            20×20 的图标槽（`<FileText>` + `flow.css` 的 `.ch-head-icon`），依据是当时那条
            "Kimi 的工具链标题是图标 + 摘要"（设计文档 §1.1）——用户已推翻，槽与图标一并撤掉；
            样式里那条规则也清了，头部不再为图标留位置。 */}
        <span className={running ? 'ch-summary ch-live' : 'ch-summary'}>{summary}</span>
        {/* 头部那枚箭头：生产是**右向 chevron**，展开时由 CSS 转 90°（见 flow.css 的 `.ch-chev`）。
            右侧**没有计数**（R3 批注：Kimi 的头部只有这一句总名，计数已经在 `使用 N 个工具` 里）。 */}
        <ChevronRight size={16} className="ch-chev" aria-hidden />
      </button>
      <FlowFold open={bodyOpen}>
        <div className="ch-body">
          {entries.map((entry) => {
            // 虚线的画法全在 DOM 结构里（每个 `.ch-item` 自己的 `::after` +
            // `:not(:last-child)`），这一层不再算相邻。
            return entry.kind === 'group' ? (
              <GroupRow
                key={entry.key}
                entry={entry}
                expansion={expansion}
                k={k}
                names={artifactNames}
              />
            ) : (
              <StepRow
                key={entry.key}
                step={entry.step}
                open={forceExpand(entry.step) || expansion.isOpen(k(entry.step.key))}
                onToggle={() => expansion.toggle(k(entry.step.key))}
                names={artifactNames}
              />
            )
          })}
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
          {/*
            过程总计：**一处、只一处**，而且**只报耗时**（2026-09-30 用户批注）。
            原先这行是「共 N 字 · 用时 M」——字数统计整档撤掉（逐步不报字数是
            2026-09-29 定的，那么整轮那个"共 N 字"也就没有对应的需求了），「用时」
            这个前缀也去掉：这一行只有一个读数，写出来就是它本身（`2 分 56 秒`）。
            耗时只加"当场看着跑完"的那些步（见 `TraceStep.durationMs`）：总和为 0
            ——历史回放、刷新回来的轮次——**整行不画**（不印一个 0 秒）。
          */}
          {!running && traceMs > 0 && (
            <p className="ch-total" data-testid="trace-total">
              {formatStepDuration(traceMs)}
            </p>
          )}
        </div>
      </FlowFold>
    </div>
  )
}
