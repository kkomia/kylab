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

import { resultPreview, type TraceStep } from '@/features/chat/model/turns'
import { formatCount } from '@/lib/format'

import { LinkText } from './LinkText'
import { StepIcon } from './stepIcons'
import {
  STEP_BODY,
  STEP_DETAIL,
  STEP_EMPTY_DIM,
  STEP_LABEL,
  STEP_ROW,
  STEP_TOGGLE,
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
 * "被拦下 / 在等确认"的那几个摘要（二：这一行**默认展开**）。
 *
 * 判据只能是这句话本身：`StepEvent` 没有"成功/失败"这一维度，
 * 拦下与跑完都是 `status: done`。所以按**执行器写死的句式**认——
 * `agent_exec._refused` / `_awaiting` 与 `tool_loop._blocked_by_mode` 的摘要
 * 都是「没有执行（…拦下）」「等待确认」，还有权限与隔离那两条
 * （「…不能执行命令」「…拒绝执行」）。老快照里的措辞（"计划档拦下"）也在词表里，
 * 因为它就躺在用户正打开的那些会话里。
 *
 * 为什么值得默认展开：用户问"它怎么没做成这件事"时，答案就在这一行下面
 * （被哪条规则拦的、等的是哪一次确认、原文是什么）。折起来等于把答案藏在一次点击后面，
 * 而"这一行说的不是成功，是拦截"恰恰是最需要一眼看见的一句。
 */
const REFUSAL_MARKS = ['没有执行', '等待确认', '拒绝执行', '不能执行命令']

export function isRefusalDetail(detail: string): boolean {
  return REFUSAL_MARKS.some((mark) => detail.includes(mark))
}

export function TraceStepRow({
  step,
  open: hostOpen,
  onToggle,
  variant = 'plain',
}: {
  step: TraceStep
  /** 原文（入参 / 返回）是否展开。由宿主持有——它才管得住"哪几行开着"。 */
  open: boolean
  onToggle: () => void
  /** `child` = 某一组展开后的一次调用：缩进一档、图标位换成小圆点。 */
  variant?: 'plain' | 'child'
}) {
  /** 展开入口只在真有原文时给：没有原文却画个能点的箭头，点了什么都不变。 */
  const hasDetail = Boolean(step.args || step.result)

  /**
   * **用户的点击压过默认值**（`null` = 他还没点过）。
   *
   * 拦下的行默认展开，但**不能变成折不起来**：点一下就该收起。
   * 所以真正的取值是"他选了就听他的，否则看默认值"，而宿主那份状态照样同步
   * （`onToggle`）——两处一起更新，下一次重渲染才不会把用户刚收起的那一行弹回去。
   */
  const [userChose, setUserChose] = useState<boolean | null>(null)
  const refusal = isRefusalDetail(step.detail)
  const open = userChose ?? (hostOpen || refusal)
  const toggle = () => {
    setUserChose(!open)
    onToggle()
  }

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

  return (
    <li
      className={`${STEP_ROW} ${step.empty ? STEP_EMPTY_DIM : ''} ${
        child ? 'pl-[var(--space-4)]' : ''
      }`}
      data-kind={step.kind ?? step.icon}
    >
      {child ? (
        <span
          className="relative z-[1] mt-[8px] mx-[8px] mb-0 h-[5px] w-[5px] shrink-0 rounded-[var(--radius-pill)] bg-[var(--border-strong)]"
          aria-hidden
        />
      ) : (
        <span className={stepIconClass(step.icon)}>
          <StepIcon icon={step.icon} />
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
          ) : hasDetail ? (
            <button type="button" className={STEP_TOGGLE} aria-expanded={open} onClick={toggle}>
              {step.label}
              <ChevronDown className={caretClass(open)} size={12} />
            </button>
          ) : child && step.detail ? null : (
            <p className={STEP_LABEL}>{step.label}</p>
          )}

          {step.detail && !detailIsRawJson(step.detail) ? (
            <LinkText
              className={child ? `${STEP_DETAIL} flex-1 min-w-0 !mt-0 truncate` : STEP_DETAIL}
              text={step.detail}
            />
          ) : null}
        </div>

        {/* 入参与返回是**原始载荷**（JSON / 工具正文），走等宽 `<pre>`，里面网址同样要能点 */}
        {hasDetail && open ? (
          <div className="mt-[var(--space-1)]">
            {step.args ? (
              <>
                <p className={RAW_LABEL}>入参</p>
                <pre className={RAW_BODY}>
                  <LinkText text={step.args} />
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
