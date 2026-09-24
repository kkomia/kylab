/**
 * 「这条命令要执行，你同意吗」——输入框上方那一条（旧 `components/chat/ApprovalBar.vue`）。
 *
 * 为什么是**一条确认条**而不是弹窗：后端此刻停在等待上，用户要做的是"看一眼命令、
 * 点一下"，而不是被打断去处理一个模态框——弹窗还会把对话内容整块盖住，
 * 而他要核对的恰恰是"这条命令配不配得上刚才那句话"。
 *
 * 三个按钮对应后端 `ChatApprovalIn` 的三个取值，一个不多：**允许一次**、
 * **这类都允许**（顺手写进放行清单）、**拒绝**。第二个必须把要写下的那行规则
 * **先摆出来**——不摆就是让用户盲签一张"以后都放行"的空白支票。
 *
 * **拒绝理由**：拒绝时能补一句给模型的话（可空）。这一句的价值在下一轮：
 * 只有"被拒了"，模型多半换个说法再试一次同一条命令；带上"为什么不行"，
 * 它才知道该往哪走。所以输入框就摆在这一条上，而**只跟着「拒绝」发出去**。
 *
 * 决定**自己 POST**（与旧组件同一个取舍）：这个组件只做一件事，让调用方喂数据
 * 会变成"每个宿主都要记得替它发请求"。点完立刻 `settled`，让宿主把确认条收起来：
 * **POST 失败时也要收**——后端那一头等的是它自己的超时，摆着一条点不动的确认
 * 只会让人以为还有机会。
 */
import { useEffect, useState } from 'react'

import { decideApproval, type ApprovalDecision, type ChatApproval } from '@/api/chat'

import { notifyError } from '../runtime/notify'

const BUTTON =
  'inline-flex h-[var(--control-height)] cursor-pointer items-center justify-center rounded-[var(--radius-control)] px-[var(--space-3)] text-[length:var(--text-meta-size)] disabled:opacity-60'
const BUTTON_PRIMARY = `${BUTTON} bg-[var(--accent)] text-[var(--Always-White)]`
const BUTTON_PLAIN = `${BUTTON} border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]`
const BUTTON_DANGER = `${BUTTON} border border-[var(--status-danger)] text-[var(--status-danger)] hover:bg-[var(--status-danger-soft)]`

/** 倒计时用一位小数没有意义：秒级提示读的是"还剩多久"，不是精确到 0.1 秒。 */
function waitHint(seconds: number): string {
  const value = Math.round(seconds)
  return value > 0 ? `${value} 秒内不回应，这一轮会按「拒绝」继续` : ''
}

export function ApprovalBar({
  approval,
  onSettled,
}: {
  approval: ChatApproval
  onSettled: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  /** 秒表：从收到这条确认开始往下走（旧组件的倒计时口径一致）。 */
  const [left, setLeft] = useState(approval.timeout_seconds)

  const rule = approval.rule.trim()
  const hint = waitHint(left)

  // 倒计时用一个 1 秒的定时器：它只是给用户一个"还剩多久"的量感，
  // 真正的超时判定在后端（它到点会按拒绝继续），所以这里停在哪都不影响结果
  useEffect(() => {
    const timer = window.setInterval(() => {
      setLeft((value) => (value > 0 ? Math.max(0, value - 1) : 0))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  async function decide(decision: ApprovalDecision): Promise<void> {
    if (busy) return
    setBusy(true)
    const text = reason.trim()
    try {
      // **没写理由时调用形状与以前逐字相同**（两个参数）：这样"不填"那条路上
      // 请求体一个字都不变
      if (decision === 'deny' && text) {
        await decideApproval(approval.approval_id, decision, text)
      } else {
        await decideApproval(approval.approval_id, decision)
      }
    } catch (cause) {
      // 409（已经超时/点过一次）也走这里：**如实说**，不谎报"已执行"
      notifyError(cause)
    } finally {
      setBusy(false)
      onSettled()
    }
  }

  return (
    <div
      data-testid="approval-bar"
      className="mx-auto mb-[var(--space-2)] flex w-full max-w-[var(--chat-measure)] flex-col gap-[var(--space-2)] rounded-[var(--radius-panel)] border border-[var(--border-strong)] bg-[var(--bg-subtle)] px-[var(--space-4)] py-[var(--space-3)]"
    >
      <div className="flex flex-wrap items-baseline gap-[var(--space-3)]">
        <span className="text-[length:var(--text-meta-size)] font-semibold text-[var(--text-primary)]">
          {approval.label || '要执行一个动作'}
        </span>
        {/* 命令原文用等宽字体、可以横向滚：它是给人**核对**的，不能被省略号截掉中间那段 */}
        <code className="max-w-full overflow-x-auto rounded-[var(--radius-control)] bg-[var(--bg-surface)] px-[var(--space-2)] py-[2px] font-mono text-[length:var(--text-meta-size)] text-[var(--text-primary)]">
          {approval.args}
        </code>
      </div>

      {approval.detail ? (
        <p className="m-0 text-[length:var(--text-micro-size)] text-[var(--text-secondary)]">
          {approval.detail}
        </p>
      ) : null}

      {rule ? (
        <p className="m-0 text-[length:var(--text-micro-size)] text-[var(--text-secondary)]">
          「这类都允许」会往放行清单加一行 <code className="font-mono">{rule}</code>
        </p>
      ) : null}

      <div className="flex flex-col gap-[var(--space-1)]">
        <input
          id="kylab-approval-reason"
          className="h-[var(--control-height)] rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--bg-surface)] px-[var(--space-3)] text-[length:var(--text-meta-size)] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)]"
          value={reason}
          disabled={busy}
          placeholder="拒绝时补一句理由，例如「这条别动生产库」（可空）"
          // 上限与后端一致（500 字）：界面先挡住，用户不必靠报错才知道写超了
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          /*
            回车就等于点「拒绝」——写理由的人下一句要做的就是拒绝，不必再挪手去点。
          */
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void decide('deny')
            }
          }}
        />
        {/*
          输入框下面原来还跟着一句"这句话会随拒绝一起告诉模型，它据此换个做法"：
          它在解释这一句去哪儿了、会起什么作用。占位符（"拒绝时补一句理由"）已经把
          该写什么说清，2026-09-24 按用户要求删。
        */}
      </div>

      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        <button
          type="button"
          className={BUTTON_PRIMARY}
          disabled={busy}
          onClick={() => void decide('allow_once')}
        >
          允许一次
        </button>
        <button
          type="button"
          className={BUTTON_PLAIN}
          disabled={busy}
          onClick={() => void decide('allow_always')}
        >
          这类都允许
        </button>
        <button
          type="button"
          className={BUTTON_DANGER}
          disabled={busy}
          onClick={() => void decide('deny')}
        >
          拒绝
        </button>
        {hint ? (
          <span className="text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
            {hint}
          </span>
        ) : null}
      </div>
    </div>
  )
}
