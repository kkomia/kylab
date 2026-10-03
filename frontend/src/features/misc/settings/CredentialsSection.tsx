/**
 * 设置 ·「凭据」一节（M5 阶段 7）——**本机档才渲染**。
 *
 * ## 它说什么（**只说处数，不回显任何秘密**）
 *
 * 本机库里可能还留着几处**明文凭据**（模型供应商那把钥匙、联网搜索的 key、
 * 几个带密钥的设置项）。M5 起这些位置都改成往**系统钥匙串**里放，迁移完成前
 * "库里有值、钥匙串没有"是唯一允许的中间态——而它必须**看得见**：
 * 这一节显示 `GET /local/secrets` 回的 `{store, pending_migration}`，
 * 并给一颗「迁进系统钥匙串」（`POST /local/secrets/migrate`）。
 *
 * 三条纪律：
 *
 * 1. **不静默迁移**（方案 §4.2 的原话）：搬到哪儿去是用户的存储位置，要点一下才动；
 * 2. **永不回显秘密**：这一节认得的只有"几处"与"钥匙串能不能写"两个数（连"哪几处"
 *    都只说处数），所以这里没有输入框，也不打算有；
 * 3. **三种读法各说各的话**（`SecretsRead`）：读到了 / 这一版还没有这一项（404）/
 *    读不到（边车没起来、形状不认识）——第三种**不许显示成"0 处"**。
 */
import { useCallback, useEffect, useState } from 'react'

import { getLocalSecrets, migrateLocalSecrets, type SecretsRead } from '@/api/secrets'

import { ErrorLine, SkeletonBlock, StatusTag } from '../shared/composites'
import { notifyError, notifySuccess } from '../shared/toast'
import { Button } from '@/ui/button'

/** 钥匙串那一档的人话（认不出来原样返回：后端加了新状态界面不该崩）。 */
const STORE_LABELS: Record<string, string> = {
  available: '可用',
  unavailable: '不可用',
}

export function CredentialsSection() {
  const [read, setRead] = useState<SecretsRead | null>(null)
  const [migrating, setMigrating] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setRead(await getLocalSecrets())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 一键迁移：**不静默**（这是用户点的动作）。结论用**报告里那个数**（跑完之后还剩几处
   * ——后端给的就是这个数，不必再读一趟），那三个列表只用来数个数（项名是本机库里的键名，
   * 不上屏幕）。
   */
  async function migrate(): Promise<void> {
    setMigrating(true)
    try {
      const report = await migrateLocalSecrets()
      setRead({
        kind: 'ok',
        data: { store: report.store, pending_migration: report.pending_migration },
      })
      const moved = report.migrated?.length ?? 0
      const failed = report.failed?.length ?? 0
      if (failed > 0) {
        notifyError(`迁了 ${moved} 处，还有 ${failed} 处没迁成（明文还在库里，可以再点一次）`)
      } else if (report.pending_migration === 0) {
        notifySuccess(moved > 0 ? `已经迁了 ${moved} 处，都收好了` : '本来就没有要迁的')
      } else {
        notifySuccess(`还差 ${report.pending_migration} 处没迁进去`)
      }
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : '没迁成')
    } finally {
      setMigrating(false)
    }
  }

  const data = read?.kind === 'ok' ? read.data : null
  const pending = data?.pending_migration ?? 0

  return (
    <>
      <h3 className="m-section-title">凭据</h3>

      {read === null ? (
        <SkeletonBlock variant="text" rows={2} />
      ) : read.kind === 'unsupported' ? (
        <p className="m-row-note" data-testid="secrets-unsupported">
          这一版还没有这一项。
        </p>
      ) : read.kind === 'error' ? (
        <ErrorLine>读不到：{read.message}</ErrorLine>
      ) : (
        <>
          <div className="m-row" data-testid="secrets-pending">
            <div className="m-row-main">
              <span className="m-row-label">库里的明文凭据</span>
              <span className="m-row-value">
                {pending > 0 ? `${pending} 处明文凭据在库里，可以迁进系统钥匙串` : '没有，都收好了'}
              </span>
            </div>
            <StatusTag
              tone={pending > 0 ? 'warning' : 'success'}
              label={pending > 0 ? `${pending} 处` : '已收好'}
            />
          </div>
          <div className="m-row" data-testid="secrets-store">
            <div className="m-row-main">
              <span className="m-row-label">系统钥匙串</span>
              <span className="m-row-value">
                {STORE_LABELS[data?.store ?? ''] ?? data?.store ?? '（后端没给这一栏）'}
              </span>
            </div>
            {/* `unavailable` 是一种**结论**（这台机器没有可用的钥匙串），不是"读不到" */}
            <StatusTag
              tone={data?.store === 'available' ? 'success' : 'warning'}
              label={
                data?.store === 'available'
                  ? '可用'
                  : data?.store === 'unavailable'
                    ? '不可用'
                    : '读不到'
              }
            />
          </div>
          <div className="m-edit-actions">
            <Button
              disabled={migrating || pending === 0 || data?.store === 'unavailable'}
              onClick={() => void migrate()}
            >
              {migrating ? '迁移中…' : '迁进系统钥匙串'}
            </Button>
          </div>
          {data?.store === 'unavailable' ? (
            <p className="m-row-note">系统钥匙串现在用不了，先不能迁。</p>
          ) : null}
        </>
      )}
    </>
  )
}
