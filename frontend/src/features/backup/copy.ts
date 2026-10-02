/**
 * 「备份」这一页的**界面文案唯一出口**（M5 阶段 7）。
 *
 * ## 为什么单开一个文件
 *
 * 与 `features/knowledge/snapshot.ts` 同一条纪律：界面上说的每一句话都在一处拼出来，
 * 于是（一）两个地方说同一件事时不会漂开，（二）**实现语汇上不了屏幕**——用户要知道的是
 * "还有几份没传上去、什么时候丢过、恢复之后要重配什么"，不是这东西在本机怎么放
 * （`scripts/check_layering.py` 的 U2 是硬门禁，`缓存` / `幂等` 那一类词一个都不许进串）。
 *
 * ## 四条措辞纪律（都写在下面每个函数上）
 *
 * 1. **两件事不许合并**：`available`（NAS 通不通）与 `snapshot_available`（桶建好没有）
 *    分开说——"连上了但还收不了快照"正是最容易被说错的那一档；
 * 2. **队列与提供者状态分开说**：连不上时队列照常显示、照常能打（备份是本地动作）；
 * 3. **不许把"看不到"说成"没有"**：恢复点取不到时说的是"看不到"，不是"一份都没有"；
 * 4. 认不出来的东西（新状态、新原因码）**原样透传**，不编一句好听的话。
 */
import type {
  BackupBacklog,
  BackupPoint,
  BackupProviderStatus,
  BackupQuota,
  BackupQueueRow,
  RestoreCounts,
  RestorePlan,
  RestorePlanArtifacts,
  RestorePlanItem,
  RestorePlanMemory,
  RestorePlanSettings,
  RestoreSkipReason,
} from '@/api/backup'
import type { ImportBatch } from '@/api/local'
import { batchStateLabel } from '@/api/local'
import { providerStateLabel } from '@/api/provider'
import { formatBytes, formatCount, formatRelativeTime } from '@/lib/format'

/* ------------------------------------------------------------------ 提供者那一段 */

/** 三态的人话（与知识库那一节**同一份措辞**：同一个后端给的三态，不该有两种说法）。 */
export function backupStateLabel(state: string): string {
  return state ? providerStateLabel(state) : '读不到'
}

/**
 * 「远端开关」现在是什么状态（`on` / `off` / `unknown`）。
 *
 * ## 为什么是"推"出来的，而不是读来的
 *
 * `BackupProviderOut` **没有回**那三个运行期键（开关 / 间隔 / 含工作区）——它们只写得进
 * 去、读不回来。所以这一行**不摆一个可能摆错的开关**，而是：
 *
 * 1. `base_url` 非空 → **打开**。这条判据来自后端自己的解析顺序
 *    （`resolve_backup_target`：关掉时**连地址都不再解析**，`base_url` 必为空），
 *    所以"地址非空"反过来就证明它是开着的；
 * 2. 地址空、但原因里带着"被关掉"那句 → **关掉了**（后端为这一档单独写了一句人话）；
 * 3. 两种情况都不是 → **读不到**（"没填地址"与"被关掉"在响应里长得一样）。
 *
 * 第 2 条读的是后端那句人话，所以它是**耦合**的：那句话改了，这一行退化成"读不到"
 * ——**不会错报成"打开"**，这是这条推断里唯一不能让步的一点（界面说错比说不知道坏得多）。
 * 后端哪天把这三个键回出来，这里就换成直接读值（阶段 8 登记）。
 */
export type RemoteSwitchVerdict = 'on' | 'off' | 'unknown'

/** 后端那句"被关掉了"里一定出现的那半句（见 `remoteSwitchVerdict` 第 2 条）。 */
const DISABLED_MARKER = '被关掉'

export function remoteSwitchVerdict(provider: BackupProviderStatus | null): RemoteSwitchVerdict {
  if (!provider) return 'unknown'
  if (provider.base_url) return 'on'
  if (provider.reason?.includes(DISABLED_MARKER)) return 'off'
  return 'unknown'
}

export function remoteSwitchLabel(verdict: RemoteSwitchVerdict): string {
  if (verdict === 'on') return '打开'
  if (verdict === 'off') return '关掉了'
  return '读不到'
}

/** 那三个读不回来的运行期键各自的一句说明（改动立刻生效，所以不说"保存后重启"这类话）。 */
export const ENABLED_NOTE = '关掉之后快照照旧在本机打，但不往远端传。'
export const EVERY_HOURS_NOTE = '填 0 = 只手动打。改了立刻生效。'
export const INCLUDE_WORKSPACE_NOTE = '默认不带：工作区里是你自己的项目文件。'
export const CREDENTIAL_NOTE = '凭据只从桌面壳那侧来，本机库里没有它。'

/**
 * 「这台提供者现在能不能收快照」那一句（R5 的**分开显示**就落在这里）。
 *
 * - 端点族都不通 → 说的是"远端现在收不了"，而不是把桶那一位搬出来（那是第二件事）；
 * - 通了、桶没建 → **原样带上服务端给的那句下一步**（`snapshot_reason`）；
 * - 都通了 → 一句"远端可以收快照"。
 */
export function snapshotCapabilityText(provider: BackupProviderStatus): string {
  if (!provider.available) {
    return `远端现在收不了快照：${provider.reason || '（对面没给原因）'}`
  }
  if (provider.snapshot_available) return '远端可以收快照'
  // "连上了但桶还没建好"这一档：原因那句话是服务端给的下一步，照着念
  return `远端还收不了快照：${provider.snapshot_reason || '（对面没给下一步）'}`
}

/** 能力集那几行（能看到"对面能做什么"就够，认不出来的键一个字都不猜）。 */
export function capabilityLines(provider: BackupProviderStatus): string[] {
  const lines: string[] = []
  const caps = provider.capabilities
  const maxBytes = caps?.snapshot?.max_blob_bytes
  if (typeof maxBytes === 'number' && maxBytes > 0) lines.push(`单份上限 ${formatBytes(maxBytes)}`)
  const retention = caps?.retention
  if (retention?.keep) {
    lines.push(
      `保留最近 ${formatCount(retention.keep)} 份${retention.policy ? `（${retention.policy}）` : ''}`,
    )
  } else if (retention?.policy) {
    lines.push(`保留策略 ${retention.policy}`)
  }
  if (typeof retention?.quota_bytes === 'number' && retention.quota_bytes > 0) {
    lines.push(`远端额度 ${formatBytes(retention.quota_bytes)}`)
  }
  if (provider.protocol_version != null) {
    lines.push(
      `协议版本 ${provider.protocol_version}${provider.app_version ? `（对面 ${provider.app_version}）` : ''}`,
    )
  }
  if (provider.devices?.length) lines.push(`看得见的设备 ${provider.devices.length} 台`)
  return lines
}

/* ------------------------------------------------------------------ 队列那一段 */

/** 队列五档的人话（认不出来原样返回：后端加了新状态界面不该崩）。 */
const QUEUE_STATES: Record<string, string> = {
  pending: '排队中',
  uploading: '传输中',
  uploaded: '已备上去',
  failed: '没传上去',
  discarded: '被丢掉',
}

export function queueStateLabel(state: string): string {
  return QUEUE_STATES[state] ?? state
}

/** 一份快照是怎么打出来的（`kind` 三档）。 */
const QUEUE_KINDS: Record<string, string> = {
  manual: '手动',
  auto: '自动',
  pre_restore: '恢复前兜底',
}

export function queueKindLabel(kind: string): string {
  return QUEUE_KINDS[kind] ?? kind
}

/**
 * 「还有几份没备上去」那一句（**如实报，不静默**）。
 *
 * `failed` 是"其中试过没成的"，`discarded` 是"被本地上限丢掉的"——两者都不许并进
 * `queued` 里含糊过去：丢掉的份数**确实没备上去**，而原因不是网络。
 */
export function backlogText(backlog: BackupBacklog): string {
  const parts: string[] = [
    backlog.queued > 0 ? `还有 ${formatCount(backlog.queued)} 份没备上去` : '没有没备上去的',
  ]
  if (backlog.queued > 0 && backlog.bytes > 0) parts.push(`（${formatBytes(backlog.bytes)}）`)
  if (backlog.failed > 0) parts.push(`其中 ${formatCount(backlog.failed)} 份没传上去`)
  parts.push(backlog.discarded > 0 ? `一共丢过 ${formatCount(backlog.discarded)} 份` : '没有丢过')
  return parts.join(' · ')
}

/**
 * 队列一行的那几句话：时间 / 类型 / 大小 / 试过几次 / 下次什么时候再试 / 最近一次的原因。
 *
 * `last_error` 是**后端原样给的那句话**——它是排障的第一手信息，照实显示，不改写。
 */
export function queueRowLine(row: BackupQueueRow): string {
  const parts: string[] = []
  if (row.created_at) parts.push(formatRelativeTime(row.created_at))
  parts.push(queueKindLabel(row.kind))
  if (row.blob_bytes > 0) parts.push(formatBytes(row.blob_bytes))
  if (row.attempts > 0) parts.push(`试过 ${row.attempts} 次`)
  if (row.state !== 'uploaded' && row.state !== 'discarded' && row.next_attempt_at) {
    parts.push(`下次 ${formatRelativeTime(row.next_attempt_at)} 再试`)
  }
  if (row.uploaded_at) parts.push(`${formatRelativeTime(row.uploaded_at)} 传上去的`)
  return parts.join(' · ')
}

/** 「立即备份」之后那一句回执：**两档都算成功**（入队成功，传没传上去是下一件事）。 */
export function snapshotCreatedText(row: BackupQueueRow, backlog: BackupBacklog): string {
  if (row.state === 'uploaded') return `这一份已经备上去了（${backlogText(backlog)}）`
  return (
    `这一份已经打在盘上、排进队列了（${backlogText(backlog)}）` +
    `${row.last_error ? `：${row.last_error}` : ''}`
  )
}

/* ------------------------------------------------------------------ 恢复点那一段 */

/** 额度那一段：配了多少 / 用了多少 / 清单里几份。 */
export function quotaText(quota: BackupQuota | undefined, total: number): string {
  const parts: string[] = []
  if (
    typeof quota?.used_bytes === 'number' &&
    typeof quota?.quota_bytes === 'number' &&
    quota.quota_bytes > 0
  ) {
    parts.push(`已用 ${formatBytes(quota.used_bytes)} / ${formatBytes(quota.quota_bytes)}`)
  }
  if (quota?.keep) parts.push(`保留最近 ${formatCount(quota.keep)} 份`)
  parts.push(`共 ${formatCount(total)} 份`)
  return parts.join(' · ')
}

/** 一份恢复点的那一行：设备 / 时间 / 大小 / 类型。 */
export function pointLine(point: BackupPoint, size: number | null): string {
  const parts: string[] = []
  parts.push(point.device_name || point.device_id)
  if (point.created_at) parts.push(formatRelativeTime(point.created_at))
  parts.push(size === null ? '（没有大小这一栏）' : formatBytes(size))
  if (point.kind) parts.push(queueKindLabel(point.kind))
  return parts.join(' · ')
}

/**
 * 恢复点清单**取不到**时那一句。
 *
 * 判据是 `available` + `reason`（后端那条端点的契约）：**不许把空清单说成"还没备过"**
 * ——"看不到"与"一份都没有"的下一步完全不同。
 */
export function pointsUnavailableText(reason: string): string {
  return `看不到恢复点：${reason || '对面没给原因'}`
}

/** 恢复点清单取到了、但一份都没有：这时才是"还没备过"。 */
export const NO_POINTS_TEXT = '这台远端上还没有任何恢复点'

/** 删除的三种结论，各说各的话（**404 如实说"本来就没有"**）。 */
export function deletedText(removed: number): string {
  return removed > 0 ? `已删掉这一份恢复点（${removed} 个对象）` : '本来就没有这一份'
}

export function deleteMissingText(deviceId: string, snapshotId: string): string {
  return `远端本来就没有这一份恢复点（${deviceId}/${snapshotId}）`
}

/* ------------------------------------------------------------------ 恢复向导 */

/** 恢复前的**二次确认**那句话（动手之前必须知道的事：默认只补不覆盖）。 */
export const RESTORE_CONFIRM_LEAD =
  '确认开始恢复？默认只补不覆盖：本机已有的记忆与设置保留原样，本机改过的会话也保留。'

/** 预演那一步的一句话（它不写本机：用户要知道这一下是安全的）。 */
export const RESTORE_PREVIEW_NOTE = '预演只读一遍包里有什么、会怎么处理，不动本机的数据。'

/** 跳过那三档的人话（后端的取值，认不出来原样返回）。 */
const SKIP_REASONS: Record<string, string> = {
  already_imported: '这一版已经导过一次',
  local_newer: '本机这条更新',
  not_ours: '本机那条不是从备份来的',
}

export function skipReasonLabel(reason: string): string {
  return SKIP_REASONS[reason as RestoreSkipReason] ?? (reason || '没给原因')
}

/** 一条会话的摘要（会话名 + 条数），`title` 为空时说"未命名对话"）。 */
export function planItemLine(item: RestorePlanItem): string {
  const title = item.title || '未命名对话'
  const bits = [`${formatCount(item.messages)} 条消息`]
  if (item.artifacts) bits.push(`${formatCount(item.artifacts)} 个产物`)
  if (item.detail) bits.push(item.detail)
  return `${title}（${bits.join(' · ')}）`
}

/** 预演的计数那一行。 */
export function planCountsText(plan: RestorePlan): string {
  const created = plan.created?.length ?? plan.counts?.created ?? 0
  const replaced = plan.replaced?.length ?? plan.counts?.replaced ?? 0
  const skipped = plan.skipped?.length ?? plan.counts?.skipped ?? 0
  return `会新建 ${formatCount(created)} · 会替换 ${formatCount(replaced)} · 会跳过 ${formatCount(skipped)}`
}

/** 一份报告里某一段名单还有多少条没列出来（几百条会话不该把弹窗撑爆）。 */
export function moreItemsText(rest: number): string {
  return `还有 ${formatCount(rest)} 条没列出来`
}

/** 「会跳过哪些、为什么」那一段（原因逐条给，不许只说个数字）。 */
export function skippedItemLine(item: RestorePlanItem): string {
  return `${planItemLine(item)}——${skipReasonLabel(item.reason)}`
}

/** 产物那一段（包里有几份、对象档几份、工作区档几份、哪些没进包）。 */
export function artifactsText(artifacts: RestorePlanArtifacts | undefined): string {
  if (!artifacts) return '包里没有产物这一栏'
  const parts = [
    `包里 ${formatCount(artifacts.in_package ?? 0)} 份`,
    `其中对象档 ${formatCount(artifacts.object ?? 0)} 份`,
    `工作区档 ${formatCount(artifacts.workspace ?? 0)} 份`,
  ]
  const missing = artifacts.missing_from_package?.length ?? 0
  parts.push(missing > 0 ? `${formatCount(missing)} 份没进包` : '没有没进包的')
  return parts.join(' · ')
}

/** 记忆那一段（包里有几份、本机已有几份、这次会补几份）。 */
export function memoryText(memory: RestorePlanMemory | undefined): string {
  if (!memory) return '包里没有记忆这一栏'
  return (
    `包里 ${formatCount(memory.in_package ?? 0)} 份 · 本机已有 ${formatCount(memory.already_here ?? 0)} 份 · ` +
    `这次补 ${formatCount(memory.will_copy ?? 0)} 份`
  )
}

/** 设置那一段（会补哪几个键、哪几个本机已有、哪几个不恢复）。 */
export function settingsText(settings: RestorePlanSettings | undefined): string {
  if (!settings) return '包里没有设置这一栏'
  const fill = settings.will_fill?.length ?? 0
  const here = settings.already_here?.length ?? 0
  const excluded = settings.excluded?.length ?? 0
  return `会补 ${formatCount(fill)} 个键 · 本机已有 ${formatCount(here)} 个 · 不恢复 ${formatCount(excluded)} 个`
}

/** 恢复进度那一行（批次状态 + 已经落位的几笔账）。 */
export function restoreProgressText(batch: ImportBatch): string {
  const created = Number(batch.counts.created ?? 0)
  const replaced = Number(batch.counts.replaced ?? 0)
  const skipped = Number(batch.counts.skipped ?? 0)
  const lead = `${batchStateLabel(batch.state)}`
  if (batch.state === 'failed') return `${lead}：${batch.error || '对面没给原因'}`
  return `${lead}：新建 ${formatCount(created)} · 替换 ${formatCount(replaced)} · 跳过 ${formatCount(skipped)}`
}

/** 恢复完成之后的那几行报告（**记忆 / 设置 / 产物各一段，外加要重配的凭据**）。 */
export function restoreReportLines(counts: RestoreCounts): string[] {
  const lines: string[] = []
  const memory = counts.memory
  if (memory) {
    lines.push(
      `记忆：补上 ${formatCount(memory.copied ?? 0)} 份` +
        `，本机已有的 ${formatCount(memory.skipped_existing ?? 0)} 份没动`,
    )
  }
  const settings = counts.settings
  if (settings) {
    lines.push(
      `设置：补上 ${formatCount(settings.filled?.length ?? 0)} 个键` +
        `，本机已有的 ${formatCount(settings.kept_local?.length ?? 0)} 个没动`,
    )
  }
  const artifacts = counts.artifacts
  if (artifacts) {
    lines.push(
      `产物：落位 ${formatCount(artifacts.restored ?? 0)} 份` +
        `，内容相同的 ${formatCount(artifacts.identical ?? 0)} 份没动` +
        `，本机内容不同的 ${formatCount(artifacts.conflicts ?? 0)} 份没动`,
    )
    if (artifacts.workspace_not_placed) {
      lines.push(
        `工作区产物 ${formatCount(artifacts.workspace_not_placed)} 份没有落位（它们原本在你的项目目录里）`,
      )
    }
  }
  if (counts.pre_restore_snapshot) {
    lines.push(`恢复前那份本地兜底：${counts.pre_restore_snapshot}`)
  }
  if (typeof counts.seconds === 'number') lines.push(`用时 ${counts.seconds} 秒`)
  if (counts.skipped) lines.push(counts.skipped)
  if (counts.error) lines.push(counts.error)
  return lines
}

/**
 * "恢复之后要重新配的凭据"那一段（R13）。
 *
 * 列表里那几句是**后端拼好的原话**（带具体名字：哪几个模型凭据、哪几个设置项、
 * 以及"这台机器要重新登录一次"）——原样显示，不改写、不合并。空列表是**正常情况**，
 * 但**不显示成"没有要重配的"**之外还要说清它为什么空（包里没有需要重配的东西）。
 */
export const CREDENTIALS_HEADING = '恢复之后要重新配的凭据'

export function credentialsEmptyText(): string {
  return '这一份里没有需要重配的凭据'
}

/** 回滚的结论（删了几条 / 恢复几条 / 保留几条）。 */
export function rollbackText(batch: ImportBatch): string {
  const counts = batch.counts
  const deleted = Number(counts.deleted ?? 0)
  const restored = Number(counts.restored ?? 0)
  const kept = Number(counts.kept ?? 0)
  const missing = Number(counts.missing ?? 0)
  const noSnapshot = Number(counts.no_snapshot ?? 0)
  const parts = [
    `删掉 ${formatCount(deleted)} 条`,
    `还原 ${formatCount(restored)} 条`,
    `保留 ${formatCount(kept)} 条`,
  ]
  if (missing) parts.push(`本机已经没有的 ${formatCount(missing)} 条`)
  if (noSnapshot) parts.push(`没有回滚快照的 ${formatCount(noSnapshot)} 条`)
  return parts.join(' · ')
}

/** 回滚那一条**二次确认**的措辞（它同样是不可逆动作）。 */
export const ROLLBACK_CONFIRM_LEAD =
  '确认回滚这一次恢复？新建的会话会删掉、被替换的还原回去；本机改过的那几条保留。'

/* ------------------------------------------------------------------ 设置里那一节 */

/** 「备份」一节里队列那一句（与页面同一份措辞）。 */
export function queueSummaryText(backlog: BackupBacklog | null): string {
  if (!backlog) return '（还没读到）'
  return backlogText(backlog)
}
