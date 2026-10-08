/**
 * 「恢复到这一份」的向导（M5 阶段 7 的重点那一步）。
 *
 * ## 四步，顺序不能省
 *
 * ```
 * ① 预演设置（勾"记忆也覆盖"这个选项不存在时也说清默认是什么）
 *    → POST /local/backup/restore { dry_run: true }（同步回报告，一个字节都不写本机）
 * ② 把报告摆出来（会新建哪些 / 哪些跳过及原因 / 哪些产物没进包 / 要重配的凭据）
 *    → 用户看完点「开始恢复」→ **二次确认**
 * ③ POST /local/backup/restore（202 + 批次 id）→ 轮询 GET /local/import/{id}
 * ④ 完成：报告 + **回滚入口**（POST /local/import/{id}/rollback，同样要二次确认）
 * ```
 *
 * 为什么预演不能省：报告里那三个清单（新建 / 替换 / 跳过）回答的是"我按下去会发生什么"，
 * 而跳过那三档（已经导过 / 本机这条更新 / 本机那条不是从备份来的）正是"我的东西会不会
 * 被盖掉"的全部答案。把它省掉、直接问"确定吗"，用户只能用猜的。
 *
 * ## 二次确认那两句话（措辞是要紧的）
 *
 * 恢复与回滚都是**不可逆**动作，两次确认的措辞都在 `copy.ts` 里写死，而且都带那句最要紧的
 * 话：**默认只补不覆盖，本机改过的那几条保留**（后端那两条路都是这么办的：记忆只补
 * 本机没有的、会话按台账比对、本机改过的一律保留）。
 *
 * ## 轮询的三条纪律
 *
 * 1. **标签页隐藏时暂停**（后台标签页不该一直打接口）；
 * 2. **上一次还没回来就不发下一次**（慢请求不叠成雪崩）；
 * 3. **卸载即停表**（关掉向导之后不再打接口）。
 *
 * 进度那条端点是**既有的** `GET /local/import/{batch_id}`：恢复实质上是"用快照当来源的
 * 一次导入"，所以进度、台账、回滚三件事与 CLI 在另一个进程里开的批次**同源**。
 */
import { useEffect, useRef, useState } from 'react'

import {
  restoreBackupPoint,
  restoreCountsOf,
  type BackupRestoreReceipt,
  type RestorePlan,
  type RestorePlanItem,
} from '@/api/backup'
import { getImportBatch, rollbackImportBatch, type ImportBatch } from '@/api/local'
import {
  CheckRow,
  ConfirmDialog,
  ErrorLine,
  Modal,
  StatusTag,
} from '@/features/misc/shared/composites'
import { notifyError, notifySuccess } from '@/features/misc/shared/toast'
import { Button } from '@/ui/button'

import {
  CREDENTIALS_HEADING,
  RESTORE_CONFIRM_LEAD,
  RESTORE_PREVIEW_NOTE,
  ROLLBACK_CONFIRM_LEAD,
  artifactsText,
  credentialsEmptyText,
  memoryText,
  moreItemsText,
  planCountsText,
  planItemLine,
  restoreProgressText,
  restoreReportLines,
  rollbackText,
  settingsText,
  skippedItemLine,
} from './copy'

/** 轮询间隔（恢复是几十秒到几分钟的事，2 秒一次的粗粒度数字够用）。 */
export const IMPORT_POLL_MS = 2_000

/** 批次跑到这三个状态就是**终态**（`rolled_back` 是回滚之后那一档）。 */
const TERMINAL_STATES = new Set(['done', 'failed', 'rolled_back'])

/** 向导要恢复哪一份（页面上那一行给的坐标）。 */
export interface RestoreTarget {
  deviceId: string
  snapshotId: string
  label: string
}

/** 清单里最多列几条（几百条会话不该把弹窗撑爆；剩下的报个数）。 */
const MAX_LISTED = 10

/** 报告缺了那几段时说的话（会话那一步就失败时后端只写了一句 `skipped`）。 */
export const NO_REPORT_TEXT = '这一次没有带回来那几段报告（会话那一步就停了）。'

export function RestoreWizard({
  target,
  onClose,
  onSettled,
}: {
  target: RestoreTarget
  /** 关掉向导（恢复与回滚都改过本机，所以关之前会先让调用方重读一遍）。 */
  onClose: () => void
  /** 恢复 / 回滚之后：让调用方重读队列与恢复点。 */
  onSettled: () => void
}) {
  /** `preview` → `plan` → `running` → `report`（顺序就是上面那四步）。 */
  const [step, setStep] = useState<'preview' | 'plan' | 'running' | 'report'>('preview')
  const [overwriteMemory, setOverwriteMemory] = useState(false)
  const [plan, setPlan] = useState<RestorePlan | null>(null)
  const [receipt, setReceipt] = useState<BackupRestoreReceipt | null>(null)
  const [batch, setBatch] = useState<ImportBatch | null>(null)
  const [rolledBack, setRolledBack] = useState<ImportBatch | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** 两颗二次确认弹窗各自的开关。 */
  const [confirming, setConfirming] = useState(false)
  const [confirmingRollback, setConfirmingRollback] = useState(false)

  const batchId = receipt?.batch_id ?? ''

  /**
   * `onSettled` 走 ref：调用方每次渲染都会给一个新函数，
   * 把它放进依赖表会把计时器反复推倒重来。
   */
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled

  /** 进度轮询（三条纪律见文件头）。终态一到就停表，并把报告摆出来。 */
  useEffect(() => {
    if (!batchId || step !== 'running') return undefined
    let alive = true
    let flying = false
    const tick = async (): Promise<void> => {
      if (flying) return
      if (typeof document !== 'undefined' && document.hidden) return
      flying = true
      try {
        const next = await getImportBatch(batchId)
        if (!alive) return
        setBatch(next)
        if (TERMINAL_STATES.has(next.state)) {
          setStep('report')
          settledRef.current()
        }
      } catch (cause) {
        // 进度读不到**不当成失败**：恢复还在后台跑，下一次 tick 会再问。
        // 但要说出来——静默停表会让用户以为"卡住了却没人管"。
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        flying = false
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), IMPORT_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [batchId, step])

  /** 第一步：预演（同步回报告，本机一个字节都不动）。 */
  async function preview(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const result = await restoreBackupPoint({
        device_id: target.deviceId,
        snapshot_id: target.snapshotId,
        dry_run: true,
        overwrite_memory: overwriteMemory,
      })
      setPlan(result.plan)
      setStep('plan')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '预演没跑起来'
      setError(message)
      notifyError(message)
    } finally {
      setBusy(false)
    }
  }

  /** 第二步之后：正式恢复（202 + 批次 id，进度从那一刻起靠轮询）。 */
  async function start(): Promise<void> {
    setConfirming(false)
    setBusy(true)
    setError('')
    try {
      const result = await restoreBackupPoint({
        device_id: target.deviceId,
        snapshot_id: target.snapshotId,
        dry_run: false,
        overwrite_memory: overwriteMemory,
      })
      setReceipt(result)
      setStep('running')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '恢复没跑起来'
      setError(message)
      notifyError(message)
    } finally {
      setBusy(false)
    }
  }

  /** 最后一步：回滚（同步返回结论；本机改过的那几条保留）。 */
  async function rollback(): Promise<void> {
    setConfirmingRollback(false)
    setBusy(true)
    try {
      const result = await rollbackImportBatch(batchId)
      setRolledBack(result)
      notifySuccess(`已回滚：${rollbackText(result)}`)
      onSettled()
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : '回滚没跑起来')
    } finally {
      setBusy(false)
    }
  }

  /** 重新预演一次（报告看过了、改了"记忆也覆盖"想再看一眼）。 */
  function restart(): void {
    setPlan(null)
    setReceipt(null)
    setBatch(null)
    setRolledBack(null)
    setError('')
    setStep('preview')
  }

  return (
    <Modal
      open
      size="wide"
      title="恢复到这一份"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          {step === 'plan' ? (
            <Button disabled={busy} onClick={() => setConfirming(true)}>
              开始恢复
            </Button>
          ) : null}
        </>
      }
    >
      {/* 恢复的是哪一份（坐标 + 人话标签）：全程留在屏幕上，别让人对错 */}
      <div className="m-row" data-testid="restore-target">
        <div className="m-row-main">
          <span className="m-row-label">这一份</span>
          <span className="m-row-value">{target.label}</span>
        </div>
        <StatusTag tone="neutral" label={target.deviceId} title={target.snapshotId} />
      </div>

      {error ? <ErrorLine>{error}</ErrorLine> : null}

      {step === 'preview' ? (
        <>
          <p className="m-row-note">{RESTORE_PREVIEW_NOTE}</p>
          <CheckRow checked={overwriteMemory} onCheckedChange={setOverwriteMemory}>
            记忆也覆盖（默认只补本机没有的那几份）
          </CheckRow>
          <div className="m-edit-actions">
            <Button disabled={busy} onClick={() => void preview()}>
              {busy ? '预演中…' : '开始预演'}
            </Button>
          </div>
        </>
      ) : null}

      {step === 'plan' && plan ? <PlanReport plan={plan} /> : null}

      {step === 'running' ? (
        <>
          <p className="m-row-note" data-testid="restore-running">
            {batch ? restoreProgressText(batch) : '已经开始了，正在等第一份进度…'}
          </p>
          <p className="m-row-note">跑起来之后可以关掉这个窗口，进度在后台继续。</p>
        </>
      ) : null}

      {step === 'report' && batch ? (
        <>
          <div className="m-row" data-testid="restore-report">
            <div className="m-row-main">
              <span className="m-row-label">结果</span>
              <span className="m-row-value">{restoreProgressText(batch)}</span>
            </div>
            <StatusTag
              tone={batch.state === 'done' ? 'success' : 'danger'}
              label={batch.state === 'done' ? '已完成' : '失败'}
            />
          </div>
          <ReportLines batch={batch} />
          {/* 失败那一趟同样是可回滚的：跑了一半的那些会话按台账撤（本机改过的保留） */}
          {(batch.state === 'done' || batch.state === 'failed') && !rolledBack ? (
            <div className="m-edit-actions">
              <Button disabled={busy} onClick={() => setConfirmingRollback(true)}>
                回滚这一次恢复
              </Button>
            </div>
          ) : null}
          {rolledBack ? (
            <p className="m-row-note" data-testid="restore-rolled-back">
              已回滚：{rollbackText(rolledBack)}
            </p>
          ) : null}
          <div className="m-edit-actions">
            <Button onClick={restart}>再预演一次</Button>
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title="开始恢复"
        lead={RESTORE_CONFIRM_LEAD}
        note="按下去之前会先在本机打一份兜底快照。"
        confirmLabel="确认恢复"
        busyLabel="正在开始…"
        busy={busy}
        onConfirm={() => void start()}
        onCancel={() => setConfirming(false)}
      />
      <ConfirmDialog
        open={confirmingRollback}
        title="回滚这一次恢复"
        lead={ROLLBACK_CONFIRM_LEAD}
        busyLabel="正在回滚…"
        busy={busy}
        onConfirm={() => void rollback()}
        onCancel={() => setConfirmingRollback(false)}
      />
    </Modal>
  )
}

/** 预演报告那一段（四块清单 + 要重配的凭据）。 */
function PlanReport({ plan }: { plan: RestorePlan }) {
  const created = plan.created ?? []
  const replaced = plan.replaced ?? []
  const skipped = plan.skipped ?? []
  const credentials = plan.credentials_to_configure ?? []
  return (
    <>
      <h3 className="m-section-title">预演结果</h3>
      <div className="m-row" data-testid="plan-counts">
        <div className="m-row-main">
          <span className="m-row-label">会怎么处理</span>
          <span className="m-row-value">{planCountsText(plan)}</span>
        </div>
      </div>

      <PlanList label="会新建" items={created} testId="plan-created" />
      <PlanList label="会替换" items={replaced} testId="plan-replaced" />
      {skipped.length > 0 ? (
        <PlanList label="会跳过" items={skipped} skipped testId="plan-skipped" />
      ) : null}

      <div className="m-row">
        <div className="m-row-main">
          <span className="m-row-label">产物</span>
          <span className="m-row-value">{artifactsText(plan.artifacts)}</span>
        </div>
      </div>
      <div className="m-row">
        <div className="m-row-main">
          <span className="m-row-label">记忆</span>
          <span className="m-row-value">{memoryText(plan.memory)}</span>
        </div>
      </div>
      <div className="m-row">
        <div className="m-row-main">
          <span className="m-row-label">设置</span>
          <span className="m-row-value">{settingsText(plan.settings)}</span>
        </div>
      </div>

      {/* 要重配的凭据**必须显示**（R13：不说，用户会以为恢复失败了） */}
      <h3 className="m-section-title m-section-gap">{CREDENTIALS_HEADING}</h3>
      <CredentialsList items={credentials} />
    </>
  )
}

/** 一份清单（新建 / 替换 / 跳过）：列前几条 + "还有 N 条没列出来"。 */
function PlanList({
  label,
  items,
  skipped = false,
  testId,
}: {
  label: string
  items: RestorePlanItem[]
  skipped?: boolean
  testId: string
}) {
  if (items.length === 0) return null
  const shown = items.slice(0, MAX_LISTED)
  return (
    <div className="m-row" data-testid={testId}>
      <div className="m-row-main">
        <span className="m-row-label">
          {label}（{items.length}）
        </span>
        <span className="m-row-value">
          <span className="flex flex-col gap-0.5">
            {shown.map((item) => (
              <span key={item.conversation_id}>
                {skipped ? skippedItemLine(item) : planItemLine(item)}
              </span>
            ))}
            {items.length > shown.length ? (
              <span>{moreItemsText(items.length - shown.length)}</span>
            ) : null}
          </span>
        </span>
      </div>
    </div>
  )
}

/** 报告里那几行（记忆 / 设置 / 产物 / 兜底 / 用时）+ 要重配的凭据。 */
function ReportLines({ batch }: { batch: ImportBatch }) {
  const counts = restoreCountsOf(batch.counts)
  if (!counts) {
    // 会话那一步就失败时后端只写了一句 `skipped`，那几段**确实没有**——如实说，
    // 不摆一串 0（那会被读成"什么都没动"，与事实相反）
    return <p className="m-row-note">{NO_REPORT_TEXT}</p>
  }
  const lines = restoreReportLines(counts)
  const credentials = counts.credentials_to_configure ?? []
  return (
    <>
      {lines.length > 0 ? (
        <div className="m-row" data-testid="restore-counts">
          <div className="m-row-main">
            <span className="m-row-label">这一趟做了什么</span>
            <span className="m-row-value">
              <span className="flex flex-col gap-0.5">
                {lines.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </span>
            </span>
          </div>
        </div>
      ) : null}
      <h3 className="m-section-title m-section-gap">{CREDENTIALS_HEADING}</h3>
      <CredentialsList items={credentials} />
    </>
  )
}

/** 要重配的凭据清单（后端拼好的那几句原话，原样显示）。 */
function CredentialsList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return (
      <p className="m-row-note" data-testid="restore-credentials-empty">
        {credentialsEmptyText()}
      </p>
    )
  }
  return (
    <ul className="m-user-list" data-testid="restore-credentials">
      {items.map((item) => (
        <li key={item} className="m-user-row">
          <span className="m-user-main">
            <span className="m-user-name">{item}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}
