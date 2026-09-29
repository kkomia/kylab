/**
 * 过程面板（旧 `ChatView.vue` 的 `.trace-head` + `.trace` 那两块）。
 *
 * 装四样东西，各有各的来历：
 *
 * 1. **时间线**：只列真发生过的步骤；同类工具**并成一行**，行标题是人话
 *    （跑着说"在做什么 + 进度"，跑完说"做了什么、对哪些对象做的"，见 `turns.groupHeading`）
 *    ——合并的是入口，不是信息：点开才是每一次的结论与原文；
 * 2. **大输出的两级懒加载**：一轮几十次工具调用时先画前 20 条（`TRACE_PAGE_SIZE`），
 *    这一行如实报出"画了多少 / 一共多少"；单条原文再切到 600 字（见 `TraceStepRow`）；
 * 3. **思考过程**：推理模型的 `reasoning_content`，它是过程的一部分，收在面板里、
 *    **按段排开**，并且长得与正文明显不同（缩进 + 底色 + 更小字号 + 更紧段距，
 *    v0.28 第二批评审 A3）——读者要一眼看得出"这是过程，不是答案"；
 * 4. **逐条出处**：默认只铺前 3 条，多出来的折成一行——一次命中上百个片段时，
 *    它会长成一面比回答还长的墙（用户报的"很长的会话"）。行内徽标 `[n]` 点进来时
 *    会自动展开（见 `revealSource`），否则会滚到一个不存在的节点上。
 *
 * 折叠那一块（§12.335 起）：三处折叠（面板、组、单步）共用 `ui/Fold.tsx` 那一个容器，
 * 行高走 `0fr ↔ 1fr`、**双向**都有 200ms 过渡（`traceStyles.TRACE_FOLD`），
 * `prefers-reduced-motion` 直落。**DOM 开销这样挡住**：内容在**第一次展开之后才常驻**
 * ——从没被点开过的那一轮，子内容根本不渲染（DOM 上与改造前同一档），
 * 而"展开 → 收起 → 再展开"每一次都有动效。取舍与细节见 `Fold.tsx` 头注。
 */
import { ChevronDown, ListTree } from 'lucide-react'
import { useRef, useState } from 'react'

import {
  groupHeading,
  isBlockRunning,
  sourcePreview,
  sourceWhere,
  thinkingParagraphs,
  traceKey,
  traceSummary,
  trailingThinking,
  type Turn,
  type TraceEntry,
  type TracePage,
} from '@/features/chat/model/turns'
import { webSitesOfSteps } from '@/features/chat/model/webSites'
import type { ChatSource } from '@/api/chat'
import { formatCount } from '@/lib/format'

import { Fold } from './Fold'
import { LinkText } from './LinkText'
import { StepIcon, StepOutcomeBadge, StepSpinner } from './stepIcons'
import { forceExpand, stepsOutcome, TraceStepRow } from './TraceStepRow'
import {
  STEP_BODY,
  STEP_ROW,
  STEP_TOGGLE,
  THINK_BLOCK,
  THINK_PARAGRAPH,
  TRACE_FOLD_CONTENT,
  caretClass,
  stepIconClass,
} from './traceStyles'
import { WebSiteList } from './WebSiteList'
import { useChatRows, type ChatMessage, type ChatRowApi } from '../runtime/ChatProvider'

/** 出处列表默认铺几条（多出来的折起来）。 */
const CITE_FOLD_LIMIT = 3

/**
 * 面板那一行的**固定短名**（§12.334 的"图标 + 文字"：每一行都得说得出自己是什么）。
 *
 * 用它的两种情况：**跑着的时候**，以及**跑完又没有出处的时候**——后者原先什么都不写，
 * 整行只剩一枚箭头（用户看不出这里能点开，而这是**唯一**能点开过程面板的地方）。
 *
 * **这不是把当年那条动态摘要恢复回来**：用户否掉的是「本轮没有命中资料 / 直接作答」
 * 那种替它编一段经过的话（判据见 `turns.traceSummary`），这一条只回答"这一行叫什么"，
 * 不声称任何发生过的事；两个分支共用一个词，也就不会分成两句不一样的话。
 */
const TRACE_PANEL_NAME = '执行过程'

/** 组容器 / 面板容器的 DOM id：`aria-controls` 要用它，而 key 里带 `:` 之类不能直接用。 */
function domId(prefix: string, raw: string): string {
  return `${prefix}-${raw.replace(/[^0-9a-zA-Z]+/g, '-')}`
}

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
  const chat = useChatRows()
  /**
   * `art_*` → 文件名（D19，2026-09-28 走查）。
   *
   * 这张表来自宿主（`ChatRowApi.artifactNames`）：**身份按内容签名缓存**，所以它不会
   * 每一拍换新引用、也不会把下面那些行上的 `memo` 一起作废（理由写在宿主那一段）。
   */
  const artifactNames = chat.artifactNames

  /**
   * 这一行的开合 key **带上轮次**（P0，真 bug）。
   *
   * 数据层给的 key 只保证"同一轮内唯一"，而宿主的展开表是整个会话共用的一张——
   * 不套这一层前缀，"第 2 轮第 1 步"与"第 5 轮第 1 步"就是同一个 key，
   * 点开一个另一个跟着开（见 `turns.ts::traceKey`）。
   */
  const key = traceKey(turnIndex, entry.key)

  /**
   * 组那一行的开合：**进行中展开、内容跑完折叠**（§12.333，与面板级同一条规则）。
   *
   * 优先级三层，从强到弱：
   *
   * 1. **组里有 `awaiting` / `failed`**（`forceExpand`，单步那一行也走它）：强制展开，
   *    而且**拒绝收起**（见下面 `toggle`）——"要你动手 / 它没做成"是三家收敛的安全语义，
   *    折起来等于把**整组行连同状态一起**藏进一次点击后面；
   * 2. **用户选过这一组**（宿主的 `openGroups`，**开与收两档都记**，见 `ChatProvider`）：
   *    完全听他的 —— 默认档听用户的，**进入 forceExpand 那三档之后不再听**。
   *    这一档记在宿主上而不是组件里：收起面板再打开、换会话再回来，得还是他选的那一档；
   * 3. **默认档**：这一组还在跑就展开（那就是进度条），跑完就折叠。
   *
   * "这一组还在跑吗"问的是 `turns.isBlockRunning`（面板级那条规则问同一个函数），
   * 两层不会各判出一个答案；键是带轮次的（`traceKey`），跨轮不会串号。
   *
   * 这些判据**必须写在"单独一步"的提前 return 之前**：它们跟着渲染分支变的话，
   * lint 会判成"条件调用"（钩子顺序不能变）。
   */
  const groupForced = entry.kind === 'group' && entry.steps.some(forceExpand)
  /** 组里还有一次调用在跑：那一行也要看得出来。 */
  const groupRunning = entry.kind === 'group' && isBlockRunning({ steps: entry.steps })

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

  const groupOpen = groupForced || (chat.groupOpenChoice(key) ?? groupRunning)
  const toggle = () => {
    // 第 1 层那一档不收（与宿主 `toggleTrace` 拒绝收起同一个写法）：连"他选过"都不留，
    // 否则这一步不再 forced 时，会突然按那一下无效的点击折起来
    if (groupForced) return
    chat.chooseGroupOpen(key, !groupOpen)
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
  /** 组行标题：跑着说"正在做什么 + 进度"，跑完换成与对象绑定的聚合句（`turns.groupHeading`）。 */
  const heading = groupHeading(entry, artifactNames)
  /** 展开的容器（`aria-controls` 指着它）；组 key 在同一轮内唯一，套上轮次便整页唯一。 */
  const bodyId = domId('trace-group', key)

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
        <button
          type="button"
          className={STEP_TOGGLE}
          aria-expanded={groupOpen}
          aria-controls={bodyId}
          onClick={toggle}
        >
          {heading}
          <ChevronDown className={caretClass(groupOpen)} size={12} aria-hidden />
        </button>
        {/* 组行上那一排站点：默认折着的时候也看得见（见上面 `sites` 的说明） */}
        <WebSiteList sites={sites.sites} more={sites.more} />
        {/*
          展开的那一块：外层只管"它归谁管"（id + 角色 + 名字），折叠与"内容挂不挂"
          都交给 `Fold`（§12.335：双向过渡 + 第一次展开之后才常驻）。
          `role="group"` + `aria-label` 是本仓既有的容器做法（见设置页那几个分组）。
        */}
        <Fold id={bodyId} role="group" aria-label={heading} open={groupOpen}>
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
        </Fold>
      </div>
    </li>
  )
}

/** 逐条出处。点文件名/「看全文」都是**看这一段原文**，不离开对话页。 */
function Citations({ turnIndex, sources }: { turnIndex: number; sources: ChatSource[] }) {
  const chat = useChatRows()
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
  const chat = useChatRows()
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

  /**
   * 面板那一页（前 N 条）：**只在"这一轮"或"取页的那支函数"真的换了时才重算**。
   *
   * 为什么用 ref 缓存而不是 `useMemo`：这一段在下面那个 `if (!reply) return null` 之后，
   * 钩子不能放在条件返回后面（lint 会判"条件调用"）。没在流式的那几轮 `turn` 是稳定引用
   * （见 `ChatThread` 的 `useStableTurns`），于是这一页与里面的 `entries` 也保持稳定——
   * 它们就是下面那些行 memo 的 prop。
   *
   * `traceView` 也要进判据：点「加载更多」时它的身份会换（宿主那边依赖 `traceExtraPages`），
   * 少这一条的话"加载更多"就再也点不动了。
   */
  const viewRef = useRef<{
    turn: Turn
    traceView: ChatRowApi['traceView']
    page: TracePage
  } | null>(null)

  const reply = turn.reply as ChatMessage | null
  if (!reply) return null

  if (
    !viewRef.current ||
    viewRef.current.turn !== turn ||
    viewRef.current.traceView !== chat.traceView
  ) {
    viewRef.current = { turn, traceView: chat.traceView, page: chat.traceView(turnIndex, turn) }
  }
  const view = viewRef.current.page

  /**
   * 面板的档位来自宿主（判定在 `turns.ts::isTraceOpen`，这里只把"是不是摊开"翻出来用）。
   * 收起时**只剩摘要那一行**：步骤与整轮思考都不进文档（条件渲染），
   * 而回答正文与出处都在面板之外——**正文永远不在这块折叠里**（规则 d）。
   */
  const open = chat.traceOpen(reply) === 'full'
  const trailingThinkingText = trailingThinking(reply)

  /**
   * 这一行此刻写什么：**有出处就报出处摘要**（`traceSummary`），**没有就写固定短名**
   * （见 `TRACE_PANEL_NAME`）——跑着的时候本来也走这一条。
   *
   * 顺带解决了一件无障碍上的事：收起态原先可能一个字都没有（只剩一枚箭头），
   * 于是这个按钮**没有可读的名字**；现在两种状态都有一句文字，名字就是它。
   */
  const headline =
    reply.streaming || reply.sources.length === 0 ? TRACE_PANEL_NAME : traceSummary(reply)
  /** 折起来的那一块要有个 id 指着（`aria-controls`）；同一页可能有好几轮。 */
  const panelId = domId('trace-panel', String(turnIndex))

  return (
    <>
      {/*
        依据摘要那一行：**它同时是过程面板的开合开关**（左边那个箭头）。

        三种状态各写什么：**执行期间**一个静态短标签（见下面那段，实时文案已按用户
        要求整条删掉）；**跑完且有出处**写 `traceSummary`；跑完又没出处则写**固定短名**——
        那时它会说"本轮没有命中资料 / 直接作答"，用户原话是"没啥用"，所以那句话不回来；
        但那一行不能只剩一枚箭头（看不出这里能点开）。无论哪一种，收起/展开都点得到。
      */}
      <button
        type="button"
        /**
         * 面板收起时这一行**只剩一枚箭头与一句短名**，测试要按它开合面板，
         * 这里给它一个稳定的抓点（P0 的用例正是"默认收起 → 点一下才摊开"）。
         */
        data-testid="trace-toggle"
        className="flex w-full cursor-pointer items-center gap-[var(--space-1)] bg-transparent p-0 text-left"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => chat.toggleTrace(reply)}
      >
        {/*
          箭头与那枚过程图标都是**装饰**：名字由这一行的文字给（本仓口径）。

          **箭头取 12px 是为了让这一行的文字与行内标签落在同一条左边缘**（用户点名的
          "图标对齐"，2026-09-29）。真浏览器量出来的账（`.shots/d11b-align/`，会话
          `conv_615c4ac504fe`）：

          - 行内那一条沟 = 图标圆底 21 + 间距 12（`--space-3`）= **33** → 标签文字 x=461；
          - 这一行改前 = 箭头 14 + 间距 4（`--space-1`）+ 图标 13 + 间距 4 = **35**
            → 文字 x=**463**（比标签右 2px ✗）；
          - 在这一层把箭头收成 12（面板里其余的开关本来都是 12：组行、子行、思考那一行）
            → 12+4+13+4 = **33**，与行内那条沟**逐字相同** → 文字 x=461 ✓。

          为什么不直接改 `gap`：那要么引进一个 3px 的字面量（这一族取值都走令牌），
          要么把两个间距拆成两种取值；而"面板头的箭头和别的开关一样大"本来就更该成立。
        */}
        <ChevronDown className={caretClass(open)} size={12} aria-hidden />
        <ListTree size={13} aria-hidden className="shrink-0 text-[var(--text-quaternary)]" />
        {/*
          执行期间这一行只写一个**静态名字**（现在它与"跑完没出处"共用同一个词）。

          原先这里是那条会滚的实时文案（「正在抓取网页…」/ 思考的尾巴 /
          「正在处理…」，由 `turns.liveLine` 给）：它挂在助手列的第一个节点上，
          与头像齐平，用户原话是"把 agent 执行中跟头像齐平的那个流式输出干掉"——
          整条删掉了（函数与它的用例一起，见 `model/README.md` §3.3）。

          但删掉之后这一行会只剩一枚箭头，看起来像残留符号，而它恰恰是**唯一**
          能点开这一块的地方。所以补一个静态短标签说明"这一行是什么"：
          它不随任何状态变化（没有要实时报告的东西了），只负责让人看出这里能点开。
        */}
        <span className="text-[length:var(--text-micro-size)] text-[var(--text-secondary)]">
          {headline}
        </span>
      </button>

      {/*
        折叠那一块（§12.335）：容器一直在文档里（一个 grid），折叠与"内容挂不挂"交给 `Fold`。

        为什么不在这里再做条件渲染（旧做法）：那样**收起是直落**——内容与行高在同一个提交
        里变，没有东西可以过渡；而用户这一批要的是"以动效最好为优先"，两个方向都得动。
        `Fold` 里那一层"展开过一次才常驻"就是这笔账的另一半：从没点开过的一轮，子内容
        根本不渲染（DOM 开销与旧做法同一档），代价只落在用户真的看过的那几块上。

        容器上那三笔（`id` / `role="group"` / `aria-label`）是给读屏器与用例的：
        开关报 `aria-expanded`，这一块报"归谁管、叫什么"；图标全部 `aria-hidden`。
      */}
      <Fold id={panelId} role="group" aria-label={headline} open={open}>
        <div className={TRACE_FOLD_CONTENT}>
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
                <ChevronDown className={caretClass(trailingOpen)} size={12} aria-hidden />
              </button>
              {/*
                    整轮那一串思考答完就折起（v0.54）：这里也走 `Fold`
                    （§12.335 的三处折叠之外，这一块是老消息专用的第四处），
                    展开过一次之后它同样常驻——动效与 DOM 开销的账见 `Fold.tsx`。
                  */}
              <Fold open={trailingOpen} data-testid="thinking-block-fold">
                <div className={THINK_BLOCK} data-testid="thinking-block">
                  {thinkingParagraphs(trailingThinkingText).map((paragraph, index) => (
                    // 段落是**同一段文本按空行切出来的**，没有稳定 id；下标即位置
                    <LinkText key={index} className={THINK_PARAGRAPH} text={paragraph} />
                  ))}
                </div>
              </Fold>
            </div>
          ) : null}
        </div>
      </Fold>

      {/*
        出处**不跟着过程一起折**（P0 的规则 d：答案常显）。

        它折进去之前的位置就在上面那一个折叠容器里，于是"过程默认收起"会顺手把
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
