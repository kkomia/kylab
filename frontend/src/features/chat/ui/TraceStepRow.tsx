/**
 * 过程面板里的**一行**（旧 `components/chat/TraceStepRow.vue`）。
 *
 * 两个位置共用：正常的一行，以及"同类工具合并"那一组**展开后的每一次调用**。
 * 同一份标记复制两遍，改一处忘一处只是时间问题——而这里装着的是
 * "这一步到底做了什么"（结论 / 入参 / 返回），最不该出现两份。
 *
 * 图标由 `stepIcons.tsx` 那张表给：这一层只认 `step.icon` 那个类别键。
 */
import { ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  humanizeArtifactKeys,
  isRunningStep,
  resultPreview,
  thinkingParagraphs,
  type TraceStep,
} from '@/features/chat/model/turns'
import { formatCount } from '@/lib/format'

/** 没有名字表时用的空表（**常量**：`) => new Map()` 会每次渲染换一个引用）。 */
const EMPTY_NAMES: ReadonlyMap<string, string> = new Map()

import { LinkText } from './LinkText'
import { StepIcon, StepSpinner } from './stepIcons'
import {
  STEP_BODY,
  STEP_DETAIL,
  STEP_EMPTY_DIM,
  STEP_LABEL,
  STEP_ROW,
  STEP_ROW_CHILD,
  STEP_TOGGLE,
  THINK_BLOCK,
  THINK_PARAGRAPH,
  caretClass,
  RAW_BODY,
  RAW_LABEL,
  RAW_MORE,
  RAW_NOTE,
  stepIconClass,
} from './traceStyles'

/**
 * 结论那一行是**原始 JSON** 吗（v0.26）。
 *
 * 判据是结构而不是 `JSON.parse`：老快照里那条被裁到 120 字，**根本解析不了**，
 * 而它恰恰是这里要挡的东西。所以只认"以 `{` 开头、紧跟着一个 `"键":`"。
 *
 * 为什么要挡：后端在没有摘要时会**回退到结果的开头**，而 exports / remember
 * 这几个工具回的是 dict——于是过程面板里铺出的是
 * `{"artifact_id": "art_89cb…", "name": …}` 这样的原文。
 * 宁可那一行什么都不写，也不要把 JSON 当句子印出来；原始载荷没丢，
 * 点开这一步的「入参 / 返回」就是它。
 */
function detailIsRawJson(detail: string): boolean {
  return /^\s*\{\s*"[\w.]+"\s*:/.test(detail)
}

/**
 * "这一步不成功"的那几个摘要（这一行**默认展开**）。
 *
 * 判据只能是这句话本身：老快照里 `StepEvent` 只有 ``status``（``running``/``done``），
 * 拦下与跑完都是 `done`。所以按**执行器写死的句式**认——
 * `agent_exec._refused` / `_awaiting` 与 `tool_loop._blocked_by_mode` 的摘要
 * 都是「没有执行（…拦下）」「等待确认」，还有权限与隔离那两条
 * （「…不能执行命令」「…拒绝执行」）。老快照里的措辞（"计划档拦下"）也在词表里，
 * 因为它就躺在用户正打开的那些会话里。
 *
 * **它只是兜底**：新数据一律走 `step.outcome`（见 `forceExpand`）。
 */
const REFUSAL_MARKS = ['没有执行', '等待确认', '拒绝执行', '不能执行命令']

/** **老快照**的兜底：那时步骤里还没有 `outcome` 这个字段，只能按词表认。 */
export function isRefusalDetail(detail: string): boolean {
  return REFUSAL_MARKS.some((mark) => detail.includes(mark))
}

/**
 * 这一步**必须看得见**吗——不成功的那几档一律强制展开。
 *
 * 这是"什么必须摊在用户眼前"的**唯一判据**：单步那一行（本文件）、组那一行
 * （`TracePanel` 的 `EntryRow`）都问它，别处不许再各判一遍。
 *
 * 三档，都由后端给的结构化事实决定（`StepEvent.outcome`，见 `ToolOutcome.outcome`）：
 *
 * - `blocked`：被模式 / 权限 / 隔离 / 成员身份拦下；
 * - `awaiting`：卡在"等你点头"上；
 * - `failed`：这一步自己出错了（工具内部异常——`summary` 里有真原因，
 *   而它恰恰是用户排查"它怎么没做成"的唯一线索）。
 *
 * 为什么宁可默认展开：折起来等于把"这一步没有成功"藏进一次点击后面，而用户扫过
 * 面板时默认会以为每一行都做成了。调研发现在这一点上三家（Qwen / Kimi / LobeHub）
 * 是收敛的：**出错与待确认强制展开**。
 *
 * 两处刻意的分寸：
 *
 * 1. `outcome` **缺省（老快照）才回退认句式**：靠句式认拦截，措辞一改就瞎；
 *    而 `outcome` 说 `""`（正常）时也不许句式翻案（既有用例钉着这一条）。
 * 2. 这里管的是**行**（与组），不管**整块面板**：面板那一层的规则 c 只管 `awaiting`
 *    （`turns.traceForceExpanded`，"拒绝收起"是更强的一档，一个失败步骤不该把
 *    整块面板锁住）。两层判据不同不是重复，而是两种动作的代价不同。
 */
export function forceExpand(step: { outcome?: string; detail: string }): boolean {
  // **字段在就听它的**（`""` = 正常也是它的结论）；字段不在（老快照）才回退认句式
  if (step.outcome !== undefined) {
    return step.outcome === 'blocked' || step.outcome === 'awaiting' || step.outcome === 'failed'
  }
  return isRefusalDetail(step.detail)
}

/**
 * 「跑了多久」那一小句（照 LobeHub `ExecutionTime` 的三档）。
 *
 * - 不足 1 秒给毫秒（`123ms`）——这一档才是"快"，写成 `0.1s` 反而看不出差别；
 * - 不足 1 分钟给一位小数（`3.2s`，取的是**向下**的那一位：59.96s 不许印成 `60.0s`）；
 * - 再长就给 `Xm Ys`。
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms - minutes * 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function TraceStepRow({
  step,
  open: hostOpen,
  onToggle,
  variant = 'plain',
  streaming = false,
  names,
}: {
  step: TraceStep
  /** 原文（入参 / 返回）是否展开。由宿主持有——它才管得住"哪几行开着"。 */
  open: boolean
  onToggle: () => void
  /**
   * `child` = 某一组展开后的一次调用：图标位换成小圆点、文字只比父行往里一点点
   * （9px，见 `STEP_ROW_CHILD`），展开箭头排在结论之后——排在前面的话这一笔
   * 22px 会自己变成一层缩进。 */
  variant?: 'plain' | 'child'
  /**
   * 这一轮还在流式生成中（v0.54）。**只影响"这一步的思考"的初始开合**：
   * 干活的时候它还摊着（用户在等，看着它想什么），**答完就自动收起来**——
   * 用户原话："输出最终结果完毕后，把思考折叠起来，就显示工具调用信息就行了。
   * 当然用户也可以展开查看。"
   */
  streaming?: boolean
  /**
   * `art_*` → 文件名（D19，2026-09-28 走查）。来自 `model/turns.ts::artifactNameMap`。
   *
   * 只影响**入参那一行的显示**：工具调用里传的是文件 key，原样打印的话用户不知道那是
   * 哪一份文件（走查实测的原文就是 `{"key": "art_7e7aecbd2ca0"}`）。key 仍然保留，
   * 只是后面缀上名字。不给（或表里查不到）就照旧原样显示——不编、不猜。
   */
  names?: ReadonlyMap<string, string>
}) {
  /** 展开入口只在真有原文时给：没有原文却画个能点的箭头，点了什么都不变。 */
  const hasDetail = Boolean(step.args || step.result)

  /**
   * **用户的点击压过默认值**（`null` = 他还没点过）。
   *
   * 不成功的行默认展开（判据是 `forceExpand`，见它上面的说明），但**不能变成折不起来**：
   * 点一下就该收起。所以真正的取值是"他选了就听他的，否则看默认值"，而宿主那份状态照样
   * 同步（`onToggle`）——两处一起更新，下一次重渲染才不会把用户刚收起的那一行弹回去。
   */
  const [userChose, setUserChose] = useState<boolean | null>(null)
  const open = userChose ?? (hostOpen || forceExpand(step))
  const toggle = () => {
    setUserChose(!open)
    onToggle()
  }

  /**
   * 这一步自己的思考（v0.54）：**默认值跟着流式状态走**、用户点过就听他的。
   *
   * 与上面原文那两个开关**分开**：它们是两件事（"它想了什么" vs "它拿回来什么"），
   * 合成一个的话，想看一眼推理就得把 2000 字的工具原文一起铺开。
   */
  const [thinkingChose, setThinkingChose] = useState<boolean | null>(null)
  const thinking = step.thinking ?? ''
  const thinkingOpen = thinkingChose ?? streaming

  /**
   * **超长返回先只给预览**（P2-1，照 ZCode 的两级懒加载 `previewBytes/fullBytes`）。
   *
   * 后端已经把结果裁到 2000 字，但一屏里连着展开十条就是两万字的 `<pre>`——
   * 这里再切到 600 字：够判断"它拿回来的是什么"，其余由「加载全部」给。
   * 预览态**只活在这一次渲染里**（收起再打开又回到先给预览）——记忆下来的后果
   * 就是"下次点开直接铺两万字"，那正是这一刀要避免的事。
   */
  const [fullResult, setFullResult] = useState(false)
  const preview = useMemo(() => (step.result ? resultPreview(step.result) : null), [step.result])
  const shownResult = preview !== null && !fullResult ? preview : (step.result ?? '')

  const child = variant === 'child'
  /**
   * 这一步还在跑（见 `turns.isRunningStep`）。
   *
   * 只有**父行**画那枚转圈：子行的那个位置是一颗 5px 的圆点（它标的是"组内第几次"），
   * 塞不进一枚状态灯；子行因此只带 `data-running`，由外层那一组替它显示"还在跑"。
   */
  const running = isRunningStep(step)

  return (
    <li
      // 子行换的是**外壳的行内间距**，不是再补一层左内边距：两笔叠加才是缩进过深的原因
      className={`${child ? STEP_ROW_CHILD : STEP_ROW} ${step.empty ? STEP_EMPTY_DIM : ''}`}
      data-kind={step.kind ?? step.icon}
      // "还在跑"在这一行上留一笔：外观上靠那枚转圈，用例与无障碍靠它
      data-running={running ? '' : undefined}
    >
      {child ? (
        <span
          className="relative z-[1] mt-[var(--space-2)] h-[5px] w-[5px] shrink-0 rounded-[var(--radius-pill)] bg-[var(--border-strong)]"
          aria-hidden
        />
      ) : (
        <span className={stepIconClass(step.icon)}>
          <StepIcon icon={step.icon} />
          {running ? <StepSpinner /> : null}
        </span>
      )}

      <div className={STEP_BODY}>
        {/*
          第一行：标签/箭头 + 结论。展开的原文是它的**下一块**——两者并排时长结论
          一换行就被「入参/返回」压住，而且原文占满整列宽度之后 JSON 与网页正文都读得顺。
        */}
        <div className={child ? 'flex items-start gap-[var(--space-1)]' : 'min-w-0'}>
          {/*
            **组内的一次调用不再重复工具名**：外面那一行已经写着「联网搜索 8 次」，
            里面八行各再写一遍只是把同一个词印八次。这里直接给结果本身。
            只有连结论都没有的那些（如"组织回答"）才退回写工具名，否则那一行会是空的。
          */}
          {child ? (
            hasDetail || step.detail ? null : (
              <p className={STEP_LABEL}>{step.label}</p>
            )
          ) : hasDetail ? (
            <button type="button" className={STEP_TOGGLE} aria-expanded={open} onClick={toggle}>
              {step.label}
              <ChevronDown className={caretClass(open)} size={12} />
            </button>
          ) : (
            <p className={STEP_LABEL}>{step.label}</p>
          )}

          {step.detail && !detailIsRawJson(step.detail) ? (
            <LinkText
              className={child ? `${STEP_DETAIL} min-w-0 !mt-0 truncate` : STEP_DETAIL}
              text={step.detail}
            />
          ) : null}

          {/*
            子行的展开箭头**排在结论之后**（v0.55）。
            为什么不放在前面：它是一颗 18px 的按钮，加上 4px 间距就是 22px，
            排在文字前等于给子行又加一笔缩进，而子行的首个字形至多只能比父行文字
            再往里 ~10px（用户原话："可以有一点缩进 但是不能太多"）。
            放到后面之后，这个 22px 落在文字右侧，不再参与缩进；父行那一行仍是
            「标签 + 箭头」的老样子（就是上面那个 `STEP_TOGGLE`）。
          */}
          {hasDetail && child ? (
            <button
              type="button"
              className="inline-flex shrink-0 items-center justify-center w-[18px] h-[18px] p-0 rounded-[var(--radius-control)] cursor-pointer [transition:var(--transition-ui)] hover:bg-[var(--bg-hover)]"
              aria-expanded={open}
              aria-label={`${step.label}的原文`}
              onClick={toggle}
            >
              <ChevronDown className={caretClass(open)} size={12} />
            </button>
          ) : null}
        </div>

        {/* 这一步自己的思考（v0.54）：折叠入口那一行 + 展开后的按段正文。
            位置刻意在**标签之下、入参/返回之上**——它讲的是"这次调用是怎么想出来的"，
            顺序上先有想法才有调用；而标签仍然是这一行的头一句，所以它看上去仍是一次工具调用。

            入口那一行上还带一句**跑了多久**（Qwen 的 "Thought for 3.2s"）：思考正文
            答完就自动折起，用户能看见的只剩这一行，而"想了 3 秒还是 3 分钟"是它
            唯一还说得出的读数。时长**只有当场看着它跑的那一轮才有**（`step.durationMs`，
            见 `liveTurn.observeStep`）——历史、刷新、补发都没有，于是这一句就不出现，
            绝不拿一个猜的数顶上。 */}
        {thinking.trim() ? (
          <div className="mt-[var(--space-1)]">
            <button
              type="button"
              className={STEP_TOGGLE}
              aria-expanded={thinkingOpen}
              aria-label="这一步的思考"
              onClick={() => setThinkingChose(!thinkingOpen)}
            >
              思考
              {step.durationMs === undefined ? null : (
                <span
                  className="tabular text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]"
                  data-testid="step-elapsed"
                >
                  {formatElapsed(step.durationMs)}
                </span>
              )}
              <span className="tabular text-[length:var(--text-micro-size)] text-[var(--text-quaternary)]">
                {formatCount(thinking.length)} 字
              </span>
              <ChevronDown className={caretClass(thinkingOpen)} size={12} />
            </button>
            {thinkingOpen ? (
              <div className={THINK_BLOCK} data-testid="step-thinking">
                {thinkingParagraphs(thinking).map((paragraph, index) => (
                  // 段落是同一段文本按空行切出来的，没有稳定 id；下标即位置
                  <LinkText key={index} className={THINK_PARAGRAPH} text={paragraph} />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 入参与返回是**原始载荷**（JSON / 工具正文），走等宽 `<pre>`，里面网址同样要能点 */}
        {hasDetail && open ? (
          <div className="mt-[var(--space-1)]">
            {step.args ? (
              <>
                <p className={RAW_LABEL}>入参</p>
                <pre className={RAW_BODY}>
                  {/* 入参里的 `art_*` 缀上文件名（D19）：key 保留，用户看得懂那是什么 */}
                  <LinkText text={humanizeArtifactKeys(step.args, names ?? EMPTY_NAMES)} />
                </pre>
              </>
            ) : null}
            {step.result ? (
              <>
                <p className={RAW_LABEL}>
                  返回
                  {/*
                    只给了预览时**如实标出来**：不标的话，用户会以为这就是工具返回的全部，
                    而截断处常在他要的那一段之前
                  */}
                  {preview !== null ? (
                    <span className={`${RAW_NOTE} tabular`}>
                      仅预览 {formatCount(preview.length)} / {formatCount(step.result.length)} 字
                    </span>
                  ) : null}
                </p>
                <pre className={RAW_BODY}>
                  <LinkText text={shownResult} />
                </pre>
                {preview !== null ? (
                  <button
                    type="button"
                    className={RAW_MORE}
                    onClick={() => setFullResult((value) => !value)}
                  >
                    {fullResult
                      ? '收起，只看预览'
                      : `加载全部（${formatCount(step.result.length)} 字）`}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  )
}
