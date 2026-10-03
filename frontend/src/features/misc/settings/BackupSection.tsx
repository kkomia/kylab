/**
 * 设置 ·「备份」一节（M5 阶段 7）——**本机档才渲染**（照「知识库连接」那一节的先例）。
 *
 * ## 为什么设置里也要有一节
 *
 * 备份页是"看账 + 动手"的地方，而设置是"改配置"的地方：地址、远端开关、自动间隔、
 * 含工作区这四项属于配置，用户会先到设置里找。两处读的是**同一份状态**
 * （`api/backup.ts` 的模块级单份 + 订阅），所以在这里改完，备份页与顶栏那一行同时改口。
 *
 * ## 与备份页的分工（不让两处各长一套）
 *
 * - 这一节：四项配置 + 队列摘要 + 「立即备份」+ **去备份页的入口**（R5）；
 * - 备份页：状态、能力集、队列明细、恢复点、恢复向导。
 *
 * ## 那一条入口是**唯一入口**（R5）
 *
 * 侧栏那一组「备份」与顶栏那条状态条（连同它的入口）都在 R5 删掉了，所以这一节
 * 尾部那颗按钮是 `/backup` 唯一的入口。动作由宿主给（`onOpenPage`）：设置是浮层，
 * 跳走之前得先关掉它——`SettingsModal` 里那一下 `onClose()` + `navigate('/backup')`。
 *
 * 措辞全部从 `features/backup/copy.ts` 出（那一份是这条界面的唯一文案出口）。
 *
 * ## 那三栏现在**读得回来**（M5 收口，`f7eb285`）
 *
 * `BackupProviderOut` 补上了 `enabled` / `include_workspace` / `every_hours`
 * （**三态都给**：远端连不上时照样回当前配置），所以这里与备份页一样直接读值：
 * 两栏开关**真值回填**（拨一下就是 `PATCH` 那一个键），间隔输入框回填当前值。
 * 从 `base_url` / `reason` 那句人话反推开关态的那套已经删掉。
 */
import { useState } from 'react'

import { createBackupSnapshot, patchLocalBackup, useBackupStatus } from '@/api/backup'
import { credentialLabel } from '@/api/provider'
import {
  CREDENTIAL_NOTE,
  ENABLED_NOTE,
  EVERY_HOURS_NOTE,
  INCLUDE_WORKSPACE_NOTE,
  backupStateLabel,
  enabledLabel,
  everyHoursNowText,
  everyHoursText,
  includeWorkspaceLabel,
  queueSummaryText,
  snapshotCreatedText,
} from '@/features/backup/copy'

import { ErrorLine, SkeletonBlock, StatusTag } from '../shared/composites'
import { notifyError, notifySuccess } from '../shared/toast'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Switch } from '@/ui/switch'

export function BackupSection({ onOpenPage }: { onOpenPage: () => void }) {
  const backup = useBackupStatus()
  const provider = backup.provider
  /** 地址那一格：`null` = 还没动过（保存后回到这个状态）。 */
  const [draft, setDraft] = useState<string | null>(null)
  /** 间隔那一格：同上——`null` = 还没动过，输入框里就是后端给的那个值。 */
  const [hours, setHours] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)

  const resolved = provider?.base_url ?? ''
  const address = draft ?? resolved
  const edited = draft !== null && draft.trim() !== resolved
  const currentHours = provider?.every_hours
  const filledHours = typeof currentHours === 'number' ? String(currentHours) : ''
  const hoursText = hours ?? filledHours
  const hoursEdited = hours !== null && hours.trim() !== filledHours

  /** 四个可改项共用同一条 PATCH（后端写完立刻重探并把最新整包回给我们）。 */
  async function patch(body: Parameters<typeof patchLocalBackup>[0], done: string): Promise<void> {
    setSaving(true)
    try {
      const next = await patchLocalBackup(body)
      setDraft(null)
      setHours(null)
      notifySuccess(
        next.provider.available
          ? `${done}（已重探：${backupStateLabel(next.provider.state)}）`
          : `${done}；当前的结论是${backupStateLabel(next.provider.state)}`,
      )
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  /** 「立即备份」：本地动作，远端连不上也照打（与备份页那一颗同一个调用）。 */
  async function snapshotNow(): Promise<void> {
    setBusy(true)
    try {
      const result = await createBackupSnapshot()
      notifySuccess(snapshotCreatedText(result.snapshot, result.backlog))
      void backup.refresh()
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : '这一份没打成')
    } finally {
      setBusy(false)
    }
  }

  // 防御性的一层：服务器档里这一节不该被渲染（菜单也不会给它入口）。
  // 真被渲染了也要**说清为什么**，而不是摆一堆读不到的字段。
  if (!backup.gate) {
    return (
      <>
        <h3 className="m-section-title">备份</h3>
        <p className="m-row-note">
          「备份」只有本机档（桌面壳）才有：这一档的数据在这台机器上，备份的目的地是别处。
        </p>
      </>
    )
  }

  return (
    <>
      <h3 className="m-section-title">备份</h3>

      {!backup.settled ? (
        <SkeletonBlock variant="text" rows={2} />
      ) : (
        <>
          {!provider ? (
            <ErrorLine>读不到：{backup.error || '本机后端没给出原因'}</ErrorLine>
          ) : (
            <>
              {/* ------------------------------------------------ 状态（只报，不解释） */}
              <div className="m-row" data-testid="settings-backup-state">
                <div className="m-row-main">
                  <span className="m-row-label">连接</span>
                  <span className="m-row-value">{backupStateLabel(provider.state)}</span>
                </div>
                <StatusTag
                  tone={provider.available ? 'success' : 'warning'}
                  label={backupStateLabel(provider.state)}
                />
              </div>
              {!provider.available ? (
                <ErrorLine>{provider.reason || '（远端没给原因）'}</ErrorLine>
              ) : null}

              {/* ------------------------------------------------ 地址 */}
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
                <Button
                  disabled={saving}
                  onClick={() => void patch({ base_url: '' }, '已恢复默认')}
                >
                  恢复默认
                </Button>
                <Button
                  disabled={saving || !edited}
                  onClick={() => void patch({ base_url: address.trim() }, '地址已保存')}
                >
                  保存
                </Button>
              </div>

              {/* ------------------------------------------------ 远端开关（读回来的真值） */}
              <div className="m-row" data-testid="settings-backup-enabled">
                <div className="m-row-main">
                  <span className="m-row-label">远端开关</span>
                  <span className="m-row-value">{enabledLabel(provider.enabled)}</span>
                </div>
                {/* 读不到当前值时**不摆开关**（摆一个"关着"的等于把不知道画成关着） */}
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

              {/* ------------------------------------------------ 自动间隔（回填当前值） */}
              <div className="m-edit-form" data-testid="settings-backup-every-hours">
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

              {/* ------------------------------------------------ 含工作区（同样回填） */}
              <div className="m-row" data-testid="settings-backup-include-workspace">
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

              {/* ------------------------------------------------ 凭据（只读） */}
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
            </>
          )}

          {/* ------------------------------------------------ 队列 + 立即备份 */}
          <h3 className="m-section-title m-section-gap">待传队列</h3>
          <div className="m-row" data-testid="settings-backup-backlog">
            <div className="m-row-main">
              <span className="m-row-label">还没备上去的</span>
              <span className="m-row-value">{queueSummaryText(backup.backlog)}</span>
            </div>
            <Button disabled={busy} onClick={() => void snapshotNow()}>
              {busy ? '正在打…' : '立即备份'}
            </Button>
          </div>
          {/*
            去备份页的入口（R5）：侧栏那一组「备份」删掉之后，**这里是唯一入口**
            （顶栏那条状态条也连同它的入口一起删了）。动作由宿主给：
            设置是浮层，跳走之前得先把它关掉（`SettingsModal` 里那一下 onClose + navigate）。
          */}
          <div className="m-edit-actions">
            <Button variant="outline" onClick={onOpenPage}>
              备份与恢复（明细与恢复点）→
            </Button>
          </div>
        </>
      )}
    </>
  )
}
