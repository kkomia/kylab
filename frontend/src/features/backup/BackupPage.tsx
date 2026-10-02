/**
 * 「备份」页（M5 阶段 7）——**本机档**的一页，四块内容。
 *
 * ## 四块（顺序就是用户要看的三件事 + 一个动作）
 *
 * 1. **状态块**：提供者三态 + 原因 + **能力集** + 上次确认 + 「立即重探」，
 *    外加四个可改项（地址 / 远端开关 / 自动间隔 / 含工作区）与只读的凭据那一行；
 * 2. **队列块**：还有几份没备上去、一共丢过几份、每份传到哪一步了、为什么没成，
 *    外加「立即备份」。**提供者不可用时这一块照常显示、照常能打**——备份是本地动作
 *    （打快照、排队都在本机），"NAS 断着"正是用户要看这一页的时刻；
 * 3. **恢复点块**：远端清单（设备 / 时间 / 大小 / 额度）+ 删除 + 「恢复到这一份」；
 *    清单**取不到时说的是"看不到"**，不是"一份都没有"；
 * 4. **恢复向导**：由「恢复到这一份」拉起（预演 → 二次确认 → 正式恢复 → 进度 → 报告
 *    与回滚入口），交互全在 `RestoreWizard.tsx`。
 *
 * ## 三件事为什么分成三块（不许合并）
 *
 * `available`（NAS 通不通）、`snapshot_available`（桶建好没有）、`backlog.queued`
 * （本机还有几份没传上去）回答的是三个不同的问题：合并成一句"备份正常/不正常"，
 * 就把"连上了但还收不了快照"与"连不上"说成了同一件事，也把"断网期间照样在打快照"
 * 这一半事实抹掉了。所以状态块与队列块各自成块，判据也各从各的字段来。
 *
 * ## 一次读、两处显示（队列与提供者）
 *
 * 提供者三态与队列读数**在同一个响应里**（`GET /local/backup`），所以这一页只用
 * `useBackupStatus()` 一个订阅（模块级单份：设置里那一节、顶栏那条摘要读的是同一个结论）。
 *
 * ## 四个可改项：三栏**读得回来**（2026-10-02 收口，`f7eb285`）
 *
 * `GET /local/backup` 的 `provider` 块现在带回 `enabled` / `include_workspace` /
 * `every_hours` 三栏（**三态都给**：远端连不上时也能显示当前配置），所以：
 *
 * - 远端开关与「带工作区产物」摆成**真值回填的开关**（当前是哪一态一眼看得出，
 *   拨一下就 `PATCH` 那一个键）；
 * - 间隔输入框**回填当前值**（`0` = 只手动）；
 * - 地址那一格本来就在响应里（`base_url`），照知识库那一节的"输入 + 保存 + 恢复默认"。
 *
 * 这三栏曾经读不回来，界面只好从 `base_url` 是否非空 / `reason` 那句人话里反推开关态
 * ——那套反推已经**删掉**（`copy.ts` 里也没有了），现在一律直接读值。
 */
import { useCallback, useEffect, useState } from 'react'

import {
  createBackupSnapshot,
  deleteBackupPoint,
  getBackupPoints,
  patchLocalBackup,
  pointBytes,
  refreshBackup,
  usablePoints,
  useBackupStatus,
  type BackupPoint,
  type BackupPoints,
  type BackupView,
} from '@/api/backup'
import { credentialLabel } from '@/api/provider'
import { formatRelativeTime } from '@/lib/format'

import {
  ConfirmDialog,
  ErrorLine,
  PageShell,
  SkeletonBlock,
  StatusTag,
} from '@/features/misc/shared/composites'
import { notifyError, notifySuccess } from '@/features/misc/shared/toast'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Switch } from '@/ui/switch'

import { RestoreWizard, type RestoreTarget } from './RestoreWizard'
import {
  CREDENTIAL_NOTE,
  ENABLED_NOTE,
  EVERY_HOURS_NOTE,
  INCLUDE_WORKSPACE_NOTE,
  NO_POINTS_TEXT,
  backlogText,
  backupStateLabel,
  capabilityLines,
  deletedText,
  deleteMissingText,
  enabledLabel,
  everyHoursNowText,
  everyHoursText,
  includeWorkspaceLabel,
  pointLine,
  pointsUnavailableText,
  queueKindLabel,
  queueRowLine,
  queueStateLabel,
  quotaText,
  snapshotCapabilityText,
  snapshotCreatedText,
} from './copy'

/** 队列那五档对应的标签色（`uploaded` 才是好结局，`discarded` 是"确实没备上去"）。 */
const QUEUE_TONES: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  pending: 'neutral',
  uploading: 'info',
  uploaded: 'success',
  failed: 'danger',
  discarded: 'warning',
}

export function BackupPage() {
  const view = useBackupStatus()
  const [wizard, setWizard] = useState<RestoreTarget | null>(null)
  /** 恢复点清单的重读门牌号（恢复 / 回滚之后本机那一半也变了）。 */
  const [pointsNonce, setPointsNonce] = useState(0)

  /**
   * 恢复 / 回滚之后：队列与恢复点都得重读（两边的账都动了）。
   *
   * 依赖表是空的（用的是模块函数与 `setState`）：这个回调会进向导那条**轮询 effect**
   * 的依赖里，身份每次渲染都变的话会把计时器反复推倒重来。
   */
  const settled = useCallback((): void => {
    void refreshBackup()
    setPointsNonce((value) => value + 1)
  }, [])

  if (!view.gate) {
    // 服务器档 / 浏览器档：那一档的备份就是它自己，没有"排队往别处传"这回事。
    // 这一支只会在直接敲地址进来时走到（导航里那一项本来就不显）。
    return (
      <PageShell title="备份">
        <p className="m-row-note">
          「备份」只有本机档（桌面壳）才有：这一档的数据在这台机器上，备份的目的地是别处。
        </p>
      </PageShell>
    )
  }

  return (
    <PageShell
      title="备份"
      actions={
        <Button disabled={view.loading} onClick={() => void view.refresh()}>
          {view.loading ? '重探中…' : '立即重探'}
        </Button>
      }
    >
      {!view.settled ? <SkeletonBlock variant="text" rows={3} /> : null}
      {view.error && view.data !== null ? (
        <ErrorLine>备份状态读不到：{view.error}</ErrorLine>
      ) : null}

      <StatusBlock view={view} />
      <QueueBlock view={view} />
      <PointsBlock nonce={pointsNonce} onRestore={setWizard} />
      {wizard ? (
        <RestoreWizard target={wizard} onClose={() => setWizard(null)} onSettled={settled} />
      ) : null}
    </PageShell>
  )
}

/* ------------------------------------------------------------------ ① 状态块 */

function StatusBlock({ view }: { view: BackupView }) {
  const provider = view.provider
  /** 地址那一格：`null` = 还没动过，跟着后端解析后的地址走（保存后回到这个状态）。 */
  const [draft, setDraft] = useState<string | null>(null)
  /** 间隔那一格：同上——`null` = 还没动过，**默认回填后端给的那个值**。 */
  const [hours, setHours] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const resolved = provider?.base_url ?? ''
  const address = draft ?? resolved
  const edited = draft !== null && draft.trim() !== resolved
  /**
   * 间隔：**回填当前值**（后端给的就是"现在生效的那个数"）；只在动过之后才允许保存。
   *
   * `every_hours` 认不出来时（界面比边车新）输入框留空、提示里说"读不到"——
   * 填一个数照样能保存，但不假装知道现在是多少。
   */
  const currentHours = provider?.every_hours
  const filledHours = typeof currentHours === 'number' ? String(currentHours) : ''
  const hoursText = hours ?? filledHours
  const hoursEdited = hours !== null && hours.trim() !== filledHours
  const caps = provider ? capabilityLines(provider) : []

  /** 四个可改项共用同一条 PATCH；后端写完会立刻重探并把最新整包回给我们。 */
  async function patch(body: Parameters<typeof patchLocalBackup>[0], done: string): Promise<void> {
    setSaving(true)
    try {
      const next = await patchLocalBackup(body)
      setDraft(null)
      setHours(null)
      notifySuccess(
        next.provider.available
          ? `${done}（已重探：${backupStateLabel(next.provider.state)}）`
          : `${done}；当前的结论是${backupStateLabel(next.provider.state)}：` +
              `${next.provider.reason || '原因见上面'}`,
      )
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h3 className="m-section-title">备份提供者</h3>

      {!provider ? (
        <p className="m-row-note">{view.error ? `读不到：${view.error}` : '正在确认备份提供者…'}</p>
      ) : (
        <>
          {/* -------------------------------------------------- 三态 + 原因 */}
          <div className="m-row" data-testid="backup-provider-state">
            <div className="m-row-main">
              <span className="m-row-label">连接</span>
              <span className="m-row-value">{backupStateLabel(provider.state)}</span>
            </div>
            <StatusTag
              tone={provider.available ? 'success' : 'warning'}
              label={backupStateLabel(provider.state)}
            />
          </div>
          {/* 不可用时那句原因**原样摆出来**（后端给的是"一句人话 + 下一步"） */}
          {!provider.available ? (
            <ErrorLine>{provider.reason || '（远端没给原因）'}</ErrorLine>
          ) : null}

          {/* ---------------------------------------- 能力集（与"连没连上"分开说） */}
          <div className="m-row" data-testid="backup-snapshot-capability">
            <div className="m-row-main">
              <span className="m-row-label">能不能收快照</span>
              <span className="m-row-value">{snapshotCapabilityText(provider)}</span>
            </div>
            <StatusTag
              tone={provider.snapshot_available ? 'success' : 'warning'}
              label={provider.snapshot_available ? '可以收' : '还收不了'}
            />
          </div>

          {/* -------------------------------------------------- 地址 */}
          <div className="m-row">
            <div className="m-row-main">
              <span className="m-row-label">地址</span>
              <span className="m-row-value">{resolved || '（留空 = 用壳里那台 NAS）'}</span>
            </div>
            <StatusTag
              tone={resolved ? 'neutral' : 'warning'}
              label={resolved ? '已设置' : '继承壳'}
            />
          </div>
          <div className="m-edit-form">
            <label className="m-edit-field">
              <span className="m-edit-label">备份地址（留空 = 恢复默认）</span>
              <Input
                value={address}
                aria-label="备份地址"
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
          </div>
          <div className="m-edit-actions">
            <Button disabled={saving} onClick={() => void patch({ base_url: '' }, '已恢复默认')}>
              恢复默认
            </Button>
            <Button
              disabled={saving || !edited}
              onClick={() => void patch({ base_url: address.trim() }, '地址已保存')}
            >
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>

          {/* -------------------------------------------------- 远端开关 */}
          {/* 当前态**读后端那一栏**（`provider.enabled`）：拨一下就是 `PATCH {enabled}` */}
          <div className="m-row" data-testid="backup-enabled">
            <div className="m-row-main">
              <span className="m-row-label">远端开关</span>
              <span className="m-row-value">{enabledLabel(provider.enabled)}</span>
            </div>
            {/* 读不到当前值时**不摆开关**：摆一个"关着"的开关等于把不知道画成关着 */}
            {provider.enabled === undefined ? null : (
              <Switch
                checked={provider.enabled}
                disabled={saving}
                aria-label="远端开关"
                onCheckedChange={(next) =>
                  void patch({ enabled: next }, next ? '远端开关已打开' : '远端开关已关掉')
                }
              />
            )}
          </div>
          <p className="m-row-note">{ENABLED_NOTE}</p>

          {/* -------------------------------------------------- 自动间隔（回填当前值） */}
          <div className="m-edit-form" data-testid="backup-every-hours">
            <label className="m-edit-field">
              <span className="m-edit-label">每多少小时自动打一份</span>
              <Input
                value={hoursText}
                aria-label="每多少小时自动打一份"
                onChange={(event) => setHours(event.target.value)}
              />
            </label>
            <p className="m-edit-hint">
              {everyHoursNowText(currentHours)}
              {EVERY_HOURS_NOTE}
            </p>
          </div>
          <div className="m-edit-actions">
            <Button
              disabled={saving || !hoursEdited || !/^\d+$/.test(hoursText.trim())}
              onClick={() =>
                void patch(
                  { every_hours: Number(hoursText.trim()) },
                  `已设为${everyHoursText(Number(hoursText.trim()))}`,
                )
              }
            >
              保存间隔
            </Button>
          </div>

          {/* -------------------------------------------------- 含工作区（同样是回填的真值） */}
          <div className="m-row" data-testid="backup-include-workspace">
            <div className="m-row-main">
              <span className="m-row-label">快照带工作区产物</span>
              <span className="m-row-value">
                {includeWorkspaceLabel(provider.include_workspace)}
              </span>
            </div>
            {provider.include_workspace === undefined ? null : (
              <Switch
                checked={provider.include_workspace}
                disabled={saving}
                aria-label="快照带工作区产物"
                onCheckedChange={(next) =>
                  void patch(
                    { include_workspace: next },
                    next ? '快照会带上工作区产物' : '快照不带工作区产物',
                  )
                }
              />
            )}
          </div>
          <p className="m-row-note">{INCLUDE_WORKSPACE_NOTE}</p>

          {/* ---------------------------------------- 凭据（只读，永不回显） */}
          <div className="m-row">
            <div className="m-row-main">
              <span className="m-row-label">凭据</span>
              <span className="m-row-value">
                {credentialLabel(provider.credential ?? 'missing')}
              </span>
            </div>
            <StatusTag
              tone={provider.credential === 'configured' ? 'success' : 'warning'}
              label={provider.credential === 'configured' ? '已配置' : '未配置'}
            />
          </div>
          <p className="m-row-note">{CREDENTIAL_NOTE}</p>

          {/* -------------------------------------------------- 上次确认 + 能力集 */}
          <div className="m-row">
            <div className="m-row-main">
              <span className="m-row-label">上次确认</span>
              <span className="m-row-value">
                {provider.checked_at ? formatRelativeTime(provider.checked_at) : '还没探过'}
              </span>
            </div>
          </div>
          {caps.length > 0 ? (
            <div className="m-row" data-testid="backup-capabilities">
              <div className="m-row-main">
                <span className="m-row-label">这台远端能做</span>
                <span className="m-row-value">{caps.join(' · ')}</span>
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ ② 队列块 */

function QueueBlock({ view }: { view: BackupView }) {
  const [busy, setBusy] = useState(false)
  const backlog = view.backlog

  /** 「立即备份」：本地动作（包先落盘再入队），断网也照打。 */
  async function snapshotNow(): Promise<void> {
    setBusy(true)
    try {
      const result = await createBackupSnapshot()
      notifySuccess(snapshotCreatedText(result.snapshot, result.backlog))
      // 202 之后就刷这一页（那一行的状态与队列读数都是新的）
      void view.refresh()
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : '这一份没打成')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h3 className="m-section-title m-section-gap">待传队列</h3>
      <div className="m-row" data-testid="backup-backlog">
        <div className="m-row-main">
          <span className="m-row-label">还没备上去的</span>
          <span className="m-row-value">{backlog ? backlogText(backlog) : '（还没读到）'}</span>
        </div>
        <Button disabled={busy} onClick={() => void snapshotNow()}>
          {busy ? '正在打…' : '立即备份'}
        </Button>
      </div>
      {/* 队列与提供者状态**分开说**：远端连不上时这一块照旧有账（备份是本地动作） */}
      {backlog?.last_error ? (
        <p className="m-row-note" data-testid="backlog-last-error">
          最近一次没成：{backlog.last_error}
        </p>
      ) : null}

      {view.snapshots.length > 0 ? (
        <ul className="m-user-list" data-testid="backup-queue">
          {view.snapshots.map((row) => (
            <li key={row.id} className="m-user-row">
              <span className="m-user-main">
                <span className="m-user-name">{row.id}</span>
                <span className="m-user-meta">
                  {queueRowLine(row)}
                  {row.last_error ? <span className="sep">·</span> : null}
                  {row.last_error ? row.last_error : null}
                </span>
              </span>
              <StatusTag
                tone={QUEUE_TONES[row.state] ?? 'neutral'}
                label={queueStateLabel(row.state)}
                title={queueKindLabel(row.kind)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-row-note">这台机器上还没有打过快照。</p>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ ③ 恢复点块 */

function PointsBlock({
  nonce,
  onRestore,
}: {
  /** 变一次就重读一遍（恢复 / 回滚之后本机那一半也会变）。 */
  nonce: number
  onRestore: (target: RestoreTarget) => void
}) {
  const [points, setPoints] = useState<BackupPoints | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  /** 要删的那一份（确认弹窗的靶子）。 */
  const [deleting, setDeleting] = useState<BackupPoint | null>(null)
  const [removing, setRemoving] = useState(false)

  const read = useCallback(async (force: boolean): Promise<void> => {
    setLoading(true)
    try {
      setPoints(await getBackupPoints(force))
      setError('')
    } catch (cause) {
      // 清单取不到**不许说成"一份都没有"**：错误是一句话，与空清单分开摆
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // 挂载读一次（不带 force）；门牌号变了就是"恢复 / 回滚之后"，那一下强制重取
    void read(nonce > 0)
  }, [nonce, read])

  async function remove(): Promise<void> {
    const target = deleting
    if (!target) return
    setRemoving(true)
    try {
      const removed = await deleteBackupPoint(target.device_id, target.snapshot_id)
      notifySuccess(deletedText(removed))
      void read(true)
    } catch (cause) {
      const failure = cause as Error & { status?: number }
      // **404 如实说"本来就没有"**：那一份不在这儿，值得知道（与后端那条端点的判断一致）
      notifyError(
        failure?.status === 404
          ? deleteMissingText(target.device_id, target.snapshot_id)
          : failure.message || '没删掉',
      )
    } finally {
      setRemoving(false)
      setDeleting(null)
    }
  }

  const rows = usablePoints(points?.items)

  return (
    <>
      <h3 className="m-section-title m-section-gap">恢复点</h3>
      <div className="m-row" data-testid="backup-points-summary">
        <div className="m-row-main">
          <span className="m-row-label">远端上有什么</span>
          <span className="m-row-value">
            {points?.available
              ? quotaText(points.quota, points.total)
              : points
                ? pointsUnavailableText(points.reason)
                : loading
                  ? '正在读…'
                  : '（还没读到）'}
          </span>
        </div>
        <Button
          disabled={loading || refreshing}
          onClick={() => {
            setRefreshing(true)
            void read(true).finally(() => setRefreshing(false))
          }}
        >
          {refreshing ? '刷新中…' : '刷新'}
        </Button>
      </div>

      {error ? <ErrorLine>恢复点读不到：{error}</ErrorLine> : null}

      {points?.available && rows.length === 0 ? (
        <p className="m-row-note">{NO_POINTS_TEXT}</p>
      ) : null}

      {points?.available && rows.length > 0 ? (
        <ul className="m-user-list" data-testid="backup-points">
          {rows.map((point) => (
            <li key={`${point.device_id}/${point.snapshot_id}`} className="m-user-row">
              <span className="m-user-main">
                <span className="m-user-name">{pointLine(point, pointBytes(point))}</span>
                <span className="m-user-meta">{point.snapshot_id}</span>
              </span>
              <Button onClick={() => setDeleting(point)}>删除</Button>
              <Button
                onClick={() =>
                  onRestore({
                    deviceId: point.device_id,
                    snapshotId: point.snapshot_id,
                    label: pointLine(point, pointBytes(point)),
                  })
                }
              >
                恢复到这一份
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title="删掉这份恢复点"
        lead="确认删掉远端上这一份？删掉之后这一份就恢复不了了（本机队列里那一行不动）。"
        note={deleting ? `${deleting.device_id}/${deleting.snapshot_id}` : undefined}
        confirmLabel="删掉"
        busyLabel="正在删…"
        busy={removing}
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(null)}
      />
    </>
  )
}
