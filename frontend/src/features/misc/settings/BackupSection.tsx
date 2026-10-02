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
 * - 这一节：四项配置 + 队列摘要 + 「立即备份」；
 * - 备份页：状态、能力集、队列明细、恢复点、恢复向导。
 *
 * 措辞全部从 `features/backup/copy.ts` 出（那一份是这条界面的唯一文案出口）。
 *
 * ## 那三个"读不回来"的键
 *
 * `BackupProviderOut` 只回地址（`base_url`），`enabled` / `every_hours` /
 * `include_workspace` 三栏读不回来——所以这里与备份页一样，摆的是**动作**
 * （打开 / 关掉 / 带上 / 不带 / 保存间隔）而不是可能摆错的开关，见 `copy.ts` 那段说明。
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
  queueSummaryText,
  remoteSwitchLabel,
  remoteSwitchVerdict,
  snapshotCreatedText,
} from '@/features/backup/copy'

import { ErrorLine, SkeletonBlock, StatusTag } from '../shared/composites'
import { notifyError, notifySuccess } from '../shared/toast'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'

export function BackupSection() {
  const backup = useBackupStatus()
  const provider = backup.provider
  /** 地址那一格：`null` = 还没动过（保存后回到这个状态）。 */
  const [draft, setDraft] = useState<string | null>(null)
  const [hours, setHours] = useState('')
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)

  const resolved = provider?.base_url ?? ''
  const address = draft ?? resolved
  const edited = draft !== null && draft.trim() !== resolved
  const verdict = remoteSwitchVerdict(provider)

  /** 四个可改项共用同一条 PATCH（后端写完立刻重探并把最新整包回给我们）。 */
  async function patch(body: Parameters<typeof patchLocalBackup>[0], done: string): Promise<void> {
    setSaving(true)
    try {
      const next = await patchLocalBackup(body)
      setDraft(null)
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

              {/* ------------------------------------------------ 远端开关 */}
              <div className="m-row" data-testid="settings-backup-enabled">
                <div className="m-row-main">
                  <span className="m-row-label">远端开关</span>
                  <span className="m-row-value">{remoteSwitchLabel(verdict)}</span>
                </div>
                <Button
                  disabled={saving}
                  onClick={() => void patch({ enabled: true }, '远端开关已打开')}
                >
                  打开
                </Button>
                <Button
                  disabled={saving}
                  onClick={() => void patch({ enabled: false }, '远端开关已关掉')}
                >
                  关掉
                </Button>
              </div>
              <p className="m-row-note">{ENABLED_NOTE}</p>

              {/* ------------------------------------------------ 自动间隔 */}
              <div className="m-edit-form" data-testid="settings-backup-every-hours">
                <label className="m-edit-field">
                  <span className="m-edit-label">每多少小时自动打一份</span>
                  <Input
                    value={hours}
                    aria-label="每多少小时自动打一份"
                    onChange={(event) => setHours(event.target.value)}
                  />
                </label>
                <p className="m-edit-hint">{EVERY_HOURS_NOTE}</p>
              </div>
              <div className="m-edit-actions">
                <Button
                  disabled={saving || !/^\d+$/.test(hours.trim())}
                  onClick={() =>
                    void patch(
                      { every_hours: Number(hours.trim()) },
                      `已设为每 ${hours.trim()} 小时自动打一份`,
                    )
                  }
                >
                  保存间隔
                </Button>
              </div>

              {/* ------------------------------------------------ 含工作区 */}
              <div className="m-row" data-testid="settings-backup-include-workspace">
                <div className="m-row-main">
                  <span className="m-row-label">快照带工作区产物</span>
                  <span className="m-row-value">{INCLUDE_WORKSPACE_NOTE}</span>
                </div>
                <Button
                  disabled={saving}
                  onClick={() => void patch({ include_workspace: true }, '快照会带上工作区产物')}
                >
                  带上
                </Button>
                <Button
                  disabled={saving}
                  onClick={() => void patch({ include_workspace: false }, '快照不带工作区产物')}
                >
                  不带
                </Button>
              </div>

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
          <p className="m-row-note">明细与恢复点在「备份」那一页。</p>
        </>
      )}
    </>
  )
}
