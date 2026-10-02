/**
 * 「备份」的状态层（M5 阶段 7）——这一页要看的四件事只从本机后端来。
 *
 * ## 它在回答什么问题
 *
 * 本机档里，备份的去处**在别处**：快照在这台机器上打、排队、找机会传上去，
 * 恢复点是那份包在 NAS 上的样子，恢复则是"把某一份取回来重建本机"。
 * 于是这一页要看的四件事——**提供者三态 / 待传队列 / 恢复点 / 恢复进度**——
 * 全部由本机后端那六条端点回答：
 *
 * | 端点 | 谁用 |
 * | --- | --- |
 * | `GET /local/backup` | 提供者三态 + 队列读数 + 最近几行（一个响应给两半） |
 * | `PATCH /local/backup` | 改四个运行期键；**空 body = 只重探一次** |
 * | `POST /local/backup/snapshots` | 「立即备份」（202，断网也 202） |
 * | `GET /local/backup/points` | 恢复点清单（透传，连不上也是 200） |
 * | `DELETE /local/backup/points/{device}/{id}` | 删一份恢复点 |
 * | `POST /local/backup/restore` | 预演（`dry_run`）与正式恢复 |
 *
 * ## 为什么类型是**手写**的（不读 `schema.d.ts`）
 *
 * `/local/*` 这一族**不进服务器档的 OpenAPI**（`local_router` 只挂在边车那台，而
 * `gen_api_types.py` 生成的是服务器档那份契约），生成物里没有它们。先例与纪律写在
 * `api/local.ts:1-25`：**手写 + 写清出处**。下面每个类型逐字段对着
 * `backend/app/api/v1/local.py` 里那个响应模型抄——
 * `BackupProviderOut` / `BackupQueueRowOut` / `BackupBacklogOut` / `LocalBackupOut` /
 * `BackupPatchIn` / `BackupSnapshotCreatedOut` / `BackupPointsOut` /
 * `BackupPointDeletedOut` / `RestoreRequestIn` / `BackupRestoreOut`；
 * 两处**形状的作者不在协议层**，如实标在各自的类型上：
 * 队列行的每一行是 `_backup_row()`（窄投影，不含 blob 路径），
 * 恢复报告是 `services/backup_restore.RestorePlan.as_dict()` 与 `ImportBatchOut.counts`
 * 里的 `restore` 那一段。改了后端就回来改这里。
 *
 * ## `available` 与 `snapshot_available` 是**两件事**（R5）
 *
 * 「NAS 连上了」与「桶建好了、快照真传得上去」分开报：前者真、后者假正是
 * "连上了但还收不了快照"那一档——界面上**不许把它说成"连不上"**。所以这一层把两位
 * 原样带上来（`ready` / `snapshotReady`），**不替界面合并**，措辞由
 * `features/backup/copy.ts` 一处出。
 *
 * ## 待传队列那半**与提供者状态无关**（这一页的存在理由）
 *
 * 备份是本地动作：打快照与排队都在本机，连不上 NAS 时**照样能打**、队列照样有账
 * （后端一个响应里就把两半给全）。所以这一层一次读拿到两半，而**一次读失败不清掉
 * 上一次的读数**——把队列数字抹成 0 会让用户以为"没有没备上去的"。
 *
 * ## 什么时候重读（四条，照 `api/provider.ts` 那套）
 *
 * 1. 挂载时读一次（TTL 30s 内不重问；组件来来去去不该各打一次）；
 * 2. **提供者非 ready、或队列里还有没传上去的**时每 30s 重读一次
 *    （"联网之后自己补传上去"要看得见）；两边都安顿好了**不轮询**；
 * 3. 窗口重新获得焦点时强制重探一次；
 * 4. 保存设置 / 点「立即重探」/ 点「立即备份」之后当场重读。
 *
 * ## 「立即重探」为什么是 PATCH，不是 GET
 *
 * `GET /local/backup` 读的是服务端那份 30 秒结论（不在渲染路径上等一次 NAS 往返），
 * 它没有 `refresh` 参数；要**强制**再探一次，后端给的入口是 `PATCH /local/backup`
 * 带一个空 body——端点自己的原话就是"一个键都不给（空 body）= 只重探一次"。
 * 所以 `refreshBackup()` 走的是那一条 PATCH，见那个函数。
 *
 * ## 凭据**永不回显**
 *
 * 四个白名单键之外一个都不收（凭据类键会被后端 422 拒掉），响应里凭据只有
 * `configured` / `missing` 这一句话。这一层因此也不给界面任何"读凭据"的入口。
 */
import { useEffect, useState } from 'react'

import { requestLocal } from './client'
import { inDesktopShell, localDataEnabled } from './sidecar'

/* ------------------------------------------------------------------ 类型（手写） */

/**
 * 三态（**没有第四种**）。留 `string` 兜底只为了让"后端加了新状态"时界面不崩
 * （按"不在"处理）——与 `api/provider.ts::ProviderState` 同一条口径。
 */
export type BackupProviderState = 'unconfigured' | 'unavailable' | 'ready'

/** 能力集的三段（`capabilities`，键由 NAS 侧给；这一段只作排障与"能做什么"）。 */
export interface BackupSnapshotCaps {
  /** 桶建好没有（**这一位就是 `snapshot_available` 的来源**）。 */
  available?: boolean
  /** 不能收快照时那句"下一步敲什么"（服务端给的，原样透传）。 */
  unavailable_reason?: string
  max_blob_bytes?: number
  retention_policy?: string
}

export interface BackupRestoreCaps {
  available?: boolean
  download?: boolean
  partial_restore?: boolean
  manifest_listing?: boolean
  point_in_time?: boolean
}

export interface BackupRetentionCaps {
  policy?: string
  keep?: number
  quota_bytes?: number
}

export interface BackupCapabilities {
  snapshot?: BackupSnapshotCaps
  restore?: BackupRestoreCaps
  retention?: BackupRetentionCaps
}

/**
 * 这台提供者看得见的一台设备（`devices[]` 的一段，`BackupProviderOut.devices`）。
 *
 * 它是**排障与"恢复点是谁的"**用的：形状由 NAS 侧给（`dict[str, Any]` 透传），
 * 所以每个键都可选——界面只显示认得的几个，别的一律不猜。
 */
export interface BackupProviderDevice {
  device_id?: string
  device_name?: string
  snapshots?: number
  bytes?: number
  latest_snapshot_id?: string
  latest_created_at?: string
}

/**
 * `GET|PATCH /local/backup` 里的提供者那一段（`BackupProviderOut`，
 * 形状由 `BackupProviderStatus.to_payload()` 拼）。
 *
 * **不 ready 时后四段键都不出现**（响应模型 `exclude_unset`）——所以它们是可选的，
 * 而界面据此**不摆空行**（"没探到"与"真没有"是两件事）。
 */
export interface BackupProviderStatus {
  state: BackupProviderState | string
  /** 端点族通了没有（**不是**「桶能用」，见 `snapshot_available`）。 */
  available: boolean
  /** 不可用时的原因（一句人话 + 下一步）；ready 时为空串。 */
  reason: string
  /** 这个结论是什么时候探的。 */
  checked_at?: string | null
  /** 正在用的地址（未配时为空串；**不是秘密**）。 */
  base_url?: string
  /** `configured` / `missing`——凭据只看有没有，**永不回显**。 */
  credential?: string
  /** 这台提供者现在能不能真收快照（桶建好没有）。**与 `available` 分开显示**。 */
  snapshot_available?: boolean
  /** 不能收快照时那句话（服务端给的下一步）。 */
  snapshot_reason?: string
  protocol_version?: number | null
  app_version?: string
  capabilities?: BackupCapabilities
  devices?: BackupProviderDevice[]
}

/**
 * 本机待传队列的一行（`BackupQueueRowOut`，形状由 `_backup_row()` 给）。
 *
 * `state` 五档：`pending`（还没试过）/ `uploading` / `uploaded` / `failed` /
 * `discarded`（被本地上限丢掉）。`attempts` / `next_attempt_at` / `last_error`
 * 一起回答"传到哪一步了、为什么没成、下次什么时候再试"——**文案由界面组织**。
 */
export interface BackupQueueRow {
  /** 快照 id（`<device>-<ts>-<hash8>`）。 */
  id: string
  created_at: string
  /** `manual` / `auto` / `pre_restore`。 */
  kind: string
  /** `pending` / `uploading` / `uploaded` / `failed` / `discarded`。 */
  state: string
  blob_bytes: number
  attempts: number
  next_attempt_at?: string | null
  last_error: string
  uploaded_at?: string | null
  remote_device_id?: string | null
  remote_snapshot_id?: string | null
}

/**
 * 「有几份没备上去」那一读（`BackupBacklogOut`）。
 *
 * `queued` = pending / uploading / failed 三档之和；`discarded` = 被本地上限丢掉的份数
 * （那几份**确实没备上去**，而原因不是网络）——所以两者都要如实显示，不许合并。
 */
export interface BackupBacklog {
  queued: number
  bytes: number
  failed: number
  discarded: number
  oldest_created_at?: string | null
  last_error: string
}

/** `GET|PATCH /local/backup` 的整包（`LocalBackupOut`）：提供者 + 队列 + 最近几行。 */
export interface LocalBackup {
  provider: BackupProviderStatus
  backlog: BackupBacklog
  /** 队列最近几份（新的在前；后端只回最近 20 行）。 */
  snapshots: BackupQueueRow[]
}

/** `PATCH /local/backup` 的白名单四键（**凭据类键一个都不收**，后端 422 拒）。 */
export interface BackupPatch {
  /** 空串 = 清掉覆盖、回继承（壳里那台 NAS）。 */
  base_url?: string
  /** `false` = 显式关掉（快照照旧在本机打）；`true` = 打开。 */
  enabled?: boolean
  /** 快照里带不带工作区产物。 */
  include_workspace?: boolean
  /** 每多少小时自动打一份（0 = 只手动）。 */
  every_hours?: number
}

/** `POST /local/backup/snapshots` 的 202：那一行 + 最新的队列读数。 */
export interface BackupSnapshotCreated {
  snapshot: BackupQueueRow
  backlog: BackupBacklog
}

/**
 * 一个恢复点（`BackupPointsOut.items[]` 的一行）。
 *
 * 那一族是**透传**：本机后端只加一层三态，行的形状就是 NAS 侧那份清单契约
 * （生产者为 `backend/app/api/v1/backup.py::_snapshot_out`），所以这里逐键照抄它。
 *
 * ⚠️ 一处**实差别**（照实记下，不按方案的写法抄）：方案与施工单把大小那一栏写成
 * `blob_bytes`，而真正发出来的是 `bytes`（`_snapshot_out` 的键）。这一层把两个名字
 * 都声明上，由 `pointBytes()` 一处取值——两边任何一个形状来了都不会被显示成 0 字节。
 */
export interface BackupPoint {
  device_id: string
  snapshot_id: string
  /** 那台设备自己报的名字（可能为空：老清单没有这一栏）。 */
  device_name?: string
  created_at?: string | null
  /** 快照体大小（NAS 侧的键）。 */
  bytes?: number
  /** 兼容别名：另一份形状里叫这个名字。 */
  blob_bytes?: number
  sha256?: string
  kind?: string
  schema_version?: number | null
  app_version?: string
  counts?: Record<string, number>
  /** 打包时没进包的那些项（如实列）。 */
  skipped?: string[]
  encryption?: string
}

/** 额度那一段（`BackupPointsOut.quota`，形状由 NAS 侧的 `_quota()` 给）。 */
export interface BackupQuota {
  policy?: string
  keep?: number
  quota_bytes?: number
  used_bytes?: number
  snapshots?: number
}

/**
 * `GET /local/backup/points` 的响应（`BackupPointsOut`）。
 *
 * **取不到也是 200**：判据是 `available` + `reason`，界面据此说"看不到恢复点"，
 * **不许把空 `items` 当成"一份都没有"**（那两句话的下一步完全不同）。
 */
export interface BackupPoints {
  state: BackupProviderState | string
  available: boolean
  reason: string
  checked_at?: string | null
  items: BackupPoint[]
  /** 这台提供者上共几份（分页之外的总数）。 */
  total: number
  quota: BackupQuota
}

/** `DELETE /local/backup/points/{device}/{id}` 的回执：实际删掉几个对象（正常是 2）。 */
export interface BackupPointDeleted {
  removed: number
}

/** `POST /local/backup/restore` 的请求体（`RestoreRequestIn`）。 */
export interface BackupRestoreRequest {
  device_id: string
  snapshot_id: string
  /** `true` = 只预演（不碰本机库 / 记忆 / 产物）。 */
  dry_run?: boolean
  /** 记忆也覆盖（默认只补本机没有的那几份）。 */
  overwrite_memory?: boolean
}

/**
 * 预演报告里的一条会话（`services/legacy_import.PlanItem.as_dict()`）。
 *
 * 三条清单（`created` / `replaced` / `skipped`）**同一形状**：
 * `reason` 只有跳过那一条非空，取值是三档之一（见 `RESTORE_SKIP_REASONS`）。
 */
export interface RestorePlanItem {
  conversation_id: string
  title: string
  source_updated_at_ms: number
  messages: number
  events: number
  artifacts: number
  reason: string
  detail: string
}

/** 跳过那三档的**取值**（后端 `services/legacy_import` 的常量，界面按它出人话）。 */
export const RESTORE_SKIP_REASONS = ['already_imported', 'local_newer', 'not_ours'] as const

export type RestoreSkipReason = (typeof RESTORE_SKIP_REASONS)[number]

/** 报告里"哪些产物不在包里"那一段（`RestorePlan.artifacts`）。 */
export interface RestorePlanArtifacts {
  in_package?: number
  object?: number
  workspace?: number
  /** 打包时没进包的那些（名字列表）。 */
  missing_from_package?: string[]
}

/** 报告里"记忆会怎么处理"那一段（`RestorePlan.memory`）。 */
export interface RestorePlanMemory {
  in_package?: number
  already_here?: number
  will_copy?: number
  already_here_files?: string[]
}

/** 报告里"设置会怎么处理"那一段（`RestorePlan.settings`）。 */
export interface RestorePlanSettings {
  will_fill?: string[]
  already_here?: string[]
  excluded?: string[]
}

/** 包里有什么（`RestorePlan.package`）。 */
export interface RestorePackageInfo {
  schema_version?: number | null
  counts?: Record<string, number>
  included?: Record<string, number>
  redacted?: { table?: string; key?: string; path?: string }[] | string[]
  skipped?: string[]
}

/**
 * dry-run 的报告（`RestorePlan.as_dict()`，端点在 `BackupRestoreOut.plan` 里回它）。
 *
 * 四段（会新建 / 会替换 / 会跳过（含原因）/ 包里没有的产物）加两个清单：
 * `credentials_to_configure`（**R13：恢复之后要重配的凭据，界面必须显示**）与
 * `counts`。它一个字节都没写本机——预演的结论就只是这一份。
 */
export interface RestorePlan {
  device_id?: string
  snapshot_id?: string
  source?: string
  package?: RestorePackageInfo
  created?: RestorePlanItem[]
  replaced?: RestorePlanItem[]
  skipped?: RestorePlanItem[]
  artifacts?: RestorePlanArtifacts
  memory?: RestorePlanMemory
  settings?: RestorePlanSettings
  credentials_to_configure?: string[]
  counts?: Record<string, number>
}

/** `POST /local/backup/restore` 的回执（`BackupRestoreOut`）：报告或批次 id。 */
export interface BackupRestoreReceipt {
  /** 预演时是空串（它不产批次）。 */
  batch_id: string
  /** `planned`（两个模式都是它）。 */
  state: string
  source: string
  dry_run: boolean
  /** 非预演时是空对象。 */
  plan: RestorePlan
}

/** 恢复进度里那一段（`counts["restore"]`，`RestoreReport` 收尾时写的）。 */
export interface RestoreCounts {
  memory?: {
    copied?: number
    skipped_existing?: number
    copied_files?: string[]
    skipped_files?: string[]
    overwrite?: boolean
  }
  settings?: { filled?: string[]; kept_local?: string[]; excluded?: string[] }
  artifacts?: {
    restored?: number
    /** 本机已有、**字节相同**的那几份（重跑恢复的常态）。 */
    identical?: number
    /** 本机已有、**字节不同**的那几份（如实报冲突，绝不静默覆盖）。 */
    conflicts?: number
    restored_keys?: string[]
    conflict_keys?: string[]
    /** 工作区档那几份**不落位**（它们在原机器上是项目目录里的文件）：只报数。 */
    workspace_not_placed?: number
    workspace_files?: string[]
  }
  credentials_to_configure?: string[]
  /** 恢复前那份本地兜底的 id（**不入队**：它是给"按错了"用的）。 */
  pre_restore_snapshot?: string
  staging?: string
  seconds?: number
  /** 会话那一步就失败时的一句话（后端那一条短路写的）。 */
  skipped?: string
  error?: string
}

/* ------------------------------------------------------------------ 读一次 / 改一次 */

/**
 * 响应过一道**形状检查**：类型是手写的（没有生成物替我们守契约），而这条链上有真实的
 * 版本错配可能（界面比边车新）。不检查的代价是把"版本对不上"变成界面上一行
 * `Cannot read properties of undefined`——那是崩溃，不是交代。
 */
function looksLikeBackup(payload: unknown): payload is LocalBackup {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Partial<LocalBackup>
  return (
    !!record.provider &&
    typeof record.provider === 'object' &&
    !!record.backlog &&
    typeof record.backlog === 'object' &&
    Array.isArray(record.snapshots)
  )
}

/** 读一次备份状态（提供者 + 队列 + 最近几行）。**纯请求**：不写模块状态。 */
export async function getLocalBackup(): Promise<LocalBackup> {
  const payload = await requestLocal<LocalBackup>('/local/backup')
  if (!looksLikeBackup(payload)) {
    throw new Error(
      '备份响应不认识（没有 provider / backlog / snapshots：是不是本机后端比界面老？）',
    )
  }
  return payload
}

/**
 * 改四个运行期键，**并把后端返回的整包写回本模块**（后端写完会立刻重探一次，
 * 所以"保存"这一下同时完成重探与重渲染）。
 *
 * 一个键都不给 = **只重探一次**（后端端点那一条；界面上的「立即重探」走 `refreshBackup`）。
 * **凭据不在这里**：`base_url` / `enabled` / `include_workspace` / `every_hours` 是白名单，
 * `token` 类的键会被后端 422 拒掉。
 */
export async function patchLocalBackup(patch: BackupPatch): Promise<LocalBackup> {
  return run(async (token) => {
    const payload = await requestLocal<LocalBackup>('/local/backup', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
    if (!looksLikeBackup(payload)) {
      throw new Error(
        '备份响应不认识（没有 provider / backlog / snapshots：是不是本机后端比界面老？）',
      )
    }
    apply(token, payload)
    return payload
  }, true)
}

/**
 * 「立即备份」：打包 → 入队 → 立刻试一次上传（后端 202）。
 *
 * 它是**本地动作**：连不上 NAS 时照样回执，那一行多半是 `failed` + 一句 `last_error`
 * ——**那也算入队成功**（包已经在盘上、在队列里，联网后补传会把它送上去）。
 * 没有**设备身份**时后端回 400（"先在桌面壳里登录一次"），那句话由调用方原样说出来。
 *
 * 入队会改队列，所以这里顺手把整包重读一次（不写进模块状态：读的是新的账，
 * 但提供者那半不必被这一下强制重探）。
 */
export async function createBackupSnapshot(): Promise<BackupSnapshotCreated> {
  const payload = await requestLocal<BackupSnapshotCreated>('/local/backup/snapshots', {
    method: 'POST',
  })
  if (!payload || typeof payload !== 'object' || !payload.backlog) {
    throw new Error('「立即备份」的回执不认识（没有 backlog：是不是本机后端比界面老？）')
  }
  return payload
}

/** 恢复点清单（`refresh = true` 时强制重取，用户点「刷新」用）。**取不到也是 200**。 */
export async function getBackupPoints(refresh = false): Promise<BackupPoints> {
  const payload = await requestLocal<BackupPoints>(
    refresh ? '/local/backup/points?refresh=true' : '/local/backup/points',
  )
  if (!payload || typeof payload !== 'object' || typeof payload.available !== 'boolean') {
    throw new Error('恢复点清单不认识（没有 available：是不是本机后端比界面老？）')
  }
  return { ...payload, items: Array.isArray(payload.items) ? payload.items : [] }
}

/**
 * 删一份恢复点（快照体 + 清单一起走）。
 *
 * 两种失败各说各的话，**都由这里原样抛给调用方**：
 * - **404** = 服务端本来就没有这一份（想删的那份不在这儿）；
 * - **502** = 连不上提供者（那时该说的是"换一步再试"）。
 */
export async function deleteBackupPoint(deviceId: string, snapshotId: string): Promise<number> {
  const path = `/local/backup/points/${encodeURIComponent(deviceId)}/${encodeURIComponent(snapshotId)}`
  const payload = await requestLocal<BackupPointDeleted>(path, { method: 'DELETE' })
  return typeof payload?.removed === 'number' ? payload.removed : 0
}

/**
 * 按点恢复：`dry_run = true` 同步回报告，否则 202 + 批次 id（进度走 `/local/import/{id}`）。
 *
 * 两种失败都由调用方说出来：上游取不到清单 / 取不到包 = 502（"上游给的东西用不上"），
 * 提供者拒绝 = 422。**预演不产批次**（`batch_id` 是空串）。
 */
export async function restoreBackupPoint(
  request: BackupRestoreRequest,
): Promise<BackupRestoreReceipt> {
  const payload = await requestLocal<BackupRestoreReceipt>('/local/backup/restore', {
    method: 'POST',
    body: JSON.stringify({
      device_id: request.device_id,
      snapshot_id: request.snapshot_id,
      dry_run: request.dry_run === true,
      overwrite_memory: request.overwrite_memory === true,
    }),
  })
  if (!payload || typeof payload !== 'object') {
    throw new Error('恢复的回执不认识（是不是本机后端比界面老？）')
  }
  return { ...payload, plan: payload.plan ?? {} }
}

/* ------------------------------------------------------------------ 恢复点的一处取值 */

/**
 * 一份恢复点的大小（字节）。**取值只有这一处**：两种名字（`bytes` / `blob_bytes`）
 * 在这里合成一个数，认不出来给 `null`（界面说"（没有这一栏）"，不摆一个 0 字节）。
 */
export function pointBytes(point: BackupPoint): number | null {
  const value = point.bytes ?? point.blob_bytes
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 清单里那些行是不是**拿去删/恢复**用得上的（缺 id 的行不摆按钮，免得点下去 404）。 */
export function usablePoints(items: BackupPoint[] | undefined): BackupPoint[] {
  return (items ?? []).filter((item) => !!item?.device_id && !!item?.snapshot_id)
}

/**
 * 从一个批次里取出**恢复那一段**（`counts["restore"]`，`RestoreReport` 收尾时写的）。
 *
 * 取不到就回 `null`——那时界面上说"这次没有带回来那几段"（会话那一步就失败时后端
 * 只写了一句 `skipped`，`restore` 那一段**确实没有**，不是 0）。
 */
export function restoreCountsOf(counts: Record<string, unknown> | undefined): RestoreCounts | null {
  const section = counts?.restore
  if (!section || typeof section !== 'object') return null
  return section as RestoreCounts
}

/* ------------------------------------------------------------------ 模块级状态 */

/** 结论的保鲜期，与后端那条 30 秒口径同值（进程内那份结论就是 30 秒）。 */
export const BACKUP_TTL_MS = 30_000

/** 非 ready、或队列里还有没传上去的时，每 30 秒重读一次。 */
export const BACKUP_POLL_MS = 30_000

interface BackupStore {
  /** 最后一次读到的整包；`null` = **还没读到**（不猜，界面按缺席渲染）。 */
  data: LocalBackup | null
  /** 有没有过结论（成功、或"这一档没有这个概念"）。守卫靠它决定"等"还是"跳"。 */
  settled: boolean
  /** 这一档**根本没有** `/local/backup`（服务器档 / NAS 网页端）。 */
  unsupported: boolean
  /** 读这一次的失败原因（网络不通 / 边车没起来 / 形状不认识）。没有就为空串。 */
  error: string
  /** 正在飞一次请求（界面据此显示"重探中…"，不参与显隐判定）。 */
  loading: boolean
  /** 上次拿到结论的时刻（毫秒）——TTL 判据用。 */
  fetchedAt: number
}

let store: BackupStore = {
  data: null,
  settled: false,
  unsupported: false,
  error: '',
  loading: false,
  fetchedAt: 0,
}

const listeners = new Set<() => void>()

/** 正在飞的那一次（单飞：并发调用合并成一次，与 `api/provider.ts` 同一写法）。 */
let inflight: Promise<unknown> | null = null
let inflightForced = false
/** 单调递增的请求号：只让**最新**那一次的结论写进状态（旧的晚到不许盖新的）。 */
let newest = 0
let applied = 0

function setStore(patch: Partial<BackupStore>): void {
  store = { ...store, ...patch }
  for (const listener of listeners) listener()
}

/**
 * 单飞执行一次请求（三条搭配的理由与 `api/provider.ts::run` 逐条相同）：
 * 普通读 + 普通读合并；普通读 + 强制重探**不**合并（那一次读可能是改设置之前发出去的）；
 * 强制重探 + 强制重探合并。无论哪种，只有**最新**那一次的结论写进状态。
 */
function run<T>(work: (token: number) => Promise<T>, force = false): Promise<T> {
  if (inflight && (!force || inflightForced)) return inflight as Promise<T>
  const token = ++newest
  const promise = work(token).finally(() => {
    if (token === newest) {
      inflight = null
      inflightForced = false
    }
  })
  inflight = promise
  inflightForced = force
  return promise
}

function apply(token: number, data: LocalBackup): void {
  if (token < applied) return
  applied = token
  store = {
    ...store,
    data,
    settled: true,
    unsupported: false,
    error: '',
    loading: false,
    fetchedAt: Date.now(),
  }
  for (const listener of listeners) listener()
}

function fail(token: number, cause: unknown): void {
  const error = cause as (Error & { status?: number }) | undefined
  // 404 = 这一档**没有**这个端点（服务器档：备份的目的地就是它自己），与"本机档但读不到"
  // 是两件事——后者要让界面如实报"读不到"（不许静默）。
  const unsupported = error?.status === 404
  if (token < applied && !unsupported) return
  applied = token
  store = {
    ...store,
    settled: true,
    unsupported: unsupported || store.unsupported,
    loading: false,
    // 失败也记时刻：组件来来去去不该各失败一次；"恢复了吗"由轮询与焦点那两条
    // **强制**路径负责（它们不看 TTL）。
    fetchedAt: Date.now(),
    // **不清 `data`**：一次读失败不该把上一次的读数抹掉（队列数字会闪成 0）
    error: error instanceof Error && error.message ? error.message : String(cause),
  }
  for (const listener of listeners) listener()
}

function read(token: number): Promise<void> {
  setStore({ loading: true })
  return getLocalBackup().then(
    (data) => apply(token, data),
    (cause: unknown) => fail(token, cause),
  )
}

/** 读一次（TTL 内不重问）。这是"挂载时读一次"用的那一条。 */
export async function loadBackupStatus(): Promise<void> {
  if (store.fetchedAt > 0 && Date.now() - store.fetchedAt < BACKUP_TTL_MS) return
  await run((token) => read(token))
}

/**
 * **强制重探**（「立即重探」/ 焦点回到窗口 / 轮询）：走 `PATCH /local/backup` 带空 body。
 *
 * 为什么不复用 `GET`：`GET /local/backup` 读的是服务端那份 30 秒结论（它没有 `refresh`
 * 参数），而后端给"只重探一次"的入口就是这条 PATCH（端点自己的原话）。那一趟同时回答
 * "NAS 又连上了吗"与"队列动了吗"，所以回来的整包直接写进状态。
 */
export function refreshBackup(): Promise<void> {
  return run(async (token) => {
    setStore({ loading: true })
    try {
      const payload = await requestLocal<LocalBackup>('/local/backup', {
        method: 'PATCH',
        body: '{}',
      })
      if (!looksLikeBackup(payload)) {
        throw new Error(
          '备份响应不认识（没有 provider / backlog / snapshots：是不是本机后端比界面老？）',
        )
      }
      apply(token, payload)
    } catch (cause) {
      fail(token, cause)
    }
  }, true)
}

/* ------------------------------------------------------------------ 一档一判：本机档才看它 */

/**
 * 这一档**要不要**按备份状态显隐（"本机档"的判据）。**不是**"提供者 ready"：
 * 连不上的时候正是要看"有几份没备上去"的时候，所以导航与路由都按这一条判。
 *
 * - 服务器档（浏览器 / NAS 网页端）：**不要**——那一档的备份目的地就是它自己
 *   （进程内那套存储与备份），"快照排队往别处传"没有第二个东西可问；
 * - 本机档：**要**。两种情形认作本机档：① 跑在**桌面壳**里（本机后端由壳拉起）；
 *   ② 这一档**真答过一次** `/local/backup`（开发形态里浏览器直连边车那一条，
 *   顶栏那条状态条先探到 `deployment === 'local'`、页面的读就落在这一支）。
 *   而"服务器档"的特征是那个端点**根本不存在**（404）→ 永远答不上来 → 不显隐。
 *
 * 显式关掉本机数据面（`VITE_LOCAL_DATA=0`，排障用的逃生门）时也**不要**。
 */
export function backupGateApplies(): boolean {
  if (!localDataEnabled()) return false
  if (store.unsupported) return false
  return inDesktopShell() || store.data !== null
}

/* ------------------------------------------------------------------ 给界面读的那一份 */

/** 组件要用的那份（`useBackupStatus` 的返回值）。 */
export interface BackupView {
  /** 最后一次读到的整包；`null` = 还没读到（**不猜**）。 */
  data: LocalBackup | null
  provider: BackupProviderStatus | null
  backlog: BackupBacklog | null
  snapshots: BackupQueueRow[]
  /** 这一档要不要按备份状态显隐（本机档才要，见 `backupGateApplies`）。 */
  gate: boolean
  /** 有过结论（成功或失败）；守卫靠它决定"再等一下"还是"这一档没有这一页"。 */
  settled: boolean
  /** 提供者 endpoint family 通了（`state == ready`）。 */
  ready: boolean
  /** **桶能用**（`snapshot_available`）；`ready` 为真时它也可能是假——两件事。 */
  snapshotReady: boolean
  state: string
  reason: string
  /** 读失败的原因（网络 / 边车没起来 / 形状不认识）；成功时为空串。 */
  error: string
  loading: boolean
  /** 读一次（TTL 内不重问）。与模块函数同一个引用，可以直接放进 effect 依赖。 */
  reload: () => Promise<void>
  /** 强制重探（PATCH 空 body）。 */
  refresh: () => Promise<void>
}

/** 当前快照（订阅之外的地方也能读，比如事件处理里）。 */
export function backupView(): BackupView {
  const data = store.data
  const gate = backupGateApplies()
  return {
    data,
    provider: data?.provider ?? null,
    backlog: data?.backlog ?? null,
    snapshots: data?.snapshots ?? [],
    gate,
    settled: store.settled,
    ready: data?.provider?.available === true,
    snapshotReady: data?.provider?.snapshot_available === true,
    state: data?.provider?.state ?? '',
    reason: data?.provider?.reason ?? '',
    error: store.error,
    loading: store.loading,
    reload: loadBackupStatus,
    refresh: refreshBackup,
  }
}

/* ------------------------------------------------------------------ 订阅、轮询与焦点 */

/** 正在用它的组件数（减到 0 就把计时器与监听摘掉）。 */
let watchers = 0
let timer: number | null = null
let onFocus: (() => void) | null = null

/**
 * 这一轮该不该重读（轮询与焦点共用的判据）。
 *
 * **两边都安顿好了就不问**：提供者 ready、队列里一份没传的都没有——这时重读问不出新
 * 东西。反过来，只要还有一份没传上去（`queued > 0`），就该继续问：联网之后那一轮补传
 * 会把行改掉，而"它自己好了"必须**看得见**。
 */
export function backupNeedsWatching(view: BackupView = backupView()): boolean {
  if (store.unsupported) return false
  if (store.data === null) return true
  if (!view.ready) return true
  return (view.backlog?.queued ?? 0) > 0
}

function startWatch(): void {
  if (typeof window === 'undefined') return
  onFocus = () => {
    if (!backupNeedsWatching()) return
    void refreshBackup()
  }
  window.addEventListener('focus', onFocus)
  timer = window.setInterval(() => {
    if (!backupNeedsWatching()) return
    void refreshBackup()
  }, BACKUP_POLL_MS)
}

function stopWatch(): void {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
  if (onFocus) {
    window.removeEventListener('focus', onFocus)
    onFocus = null
  }
}

/**
 * 订阅备份状态（模块级单份：备份页、顶栏那条摘要、设置里那一节读的是同一个结论）。
 *
 * `enabled = false` 时**不订阅、不读**（顶栏那条靠它做到"非本机档一次都不问"）。
 */
export function useBackupStatus(options: { enabled?: boolean } = {}): BackupView {
  const enabled = options.enabled ?? true
  const [, bump] = useState(0)

  useEffect(() => {
    if (!enabled) return undefined
    const listener = () => bump((value) => value + 1)
    listeners.add(listener)
    watchers += 1
    if (watchers === 1) startWatch()
    // **挂上订阅之后再对一次表**：状态可能在"这次渲染"与"挂上订阅"之间变了，
    // 而那一瞬间的广播没人听见（`useState` + 订阅的经典缺口，M4 在守卫上真机抓到过：
    // 冷启动直接进页面时守卫有时**不挡**，要等下一次广播才纠正）。
    // 这一句等价于 `useSyncExternalStore` 订阅后那次重读。
    bump((value) => value + 1)
    // **首次被问到才读**：已经有结论时这一次是空操作（TTL 判在这里面）
    void loadBackupStatus()
    return () => {
      listeners.delete(listener)
      watchers -= 1
      if (watchers <= 0) {
        watchers = 0
        stopWatch()
      }
    }
  }, [enabled])

  return backupView()
}

/* ------------------------------------------------------------------ 用例用的窄接口 */

/** 用例用：把模块状态清干净（模块级状态必须靠调用方复位，与 `resetProviderStore` 同一条）。 */
export function resetBackupStore(): void {
  store = {
    data: null,
    settled: false,
    unsupported: false,
    error: '',
    loading: false,
    fetchedAt: 0,
  }
  inflight = null
  inflightForced = false
  newest = 0
  applied = 0
  watchers = 0
  stopWatch()
  listeners.clear()
}

/**
 * 用例用：直接摆一份结论（不经过网络）。
 *
 * `fetchedAt` 一并写成"刚刚"：这样挂载时那次 `loadBackupStatus()` 会按 TTL 跳过，
 * 用例里不会因为渲染而多打一条请求。
 */
export function setBackupStatusForTest(
  data: LocalBackup | null,
  options: { unsupported?: boolean; error?: string } = {},
): void {
  store = {
    data,
    settled: options.unsupported === true || data !== null,
    unsupported: options.unsupported === true,
    error: options.error ?? '',
    loading: false,
    fetchedAt: Date.now(),
  }
  for (const listener of listeners) listener()
}
