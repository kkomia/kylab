/**
 * 本机档的**导入账**（`GET /api/v1/local/status`，M2 阶段 6 接线）。
 *
 * ## 为什么类型是**手写**的（不读 `schema.d.ts`）
 *
 * `/local/*` 这一族端点**不进服务器档的 OpenAPI**：它们是"只在本机档成立"的东西
 * （`local_router` 挂在边车上，而 `gen_api_types.py` 生成的是那一份服务器档的契约，
 * 生成物里没有它们）。阶段 5 已经把这件事登记过，这里照那条登记办——
 * **手写 + 写清出处**，别再promote成"没人维护的第二份契约"：
 * 字段名逐条对着 `backend/app/api/v1/local.py::LocalStatusOut` 抄，
 * 改了后端就回来改这里（`tests/unit/api/local.test.ts` 钉住要用的那三项）。
 *
 * ## 只用得着那三项里的两笔账（其余留给排障）
 *
 * 界面要的是**如实可见**（阶段 6 的施工口径）：
 *
 * | 字段 | 界面上的话 |
 * | --- | --- |
 * | `imports` | 最近几批导入：各是 `done` / `failed` / `rolled_back`、新建了多少条 |
 * | `unfinished_imports` | 有几笔导入**没跑完**（`planned`/`running`）：重跑同一来源即可续上 |
 * | `unimported_file_references` | 最近一批里**没随导入过来**的文件引用数（产物 + 消息附件） |
 *
 * 其余字段（`data_dir` / `database` / `database_bytes`…）也一并声明：
 * 状态条把库路径写进 `title`，排障第一眼要看的正是它。
 */

import { requestLocal } from './client'

/** 一个导入批次的摘要（`LocalStatusOut.imports[]`，字段与后端同形）。 */
export interface LocalImportBatch {
  batch_id: string
  /** `planned` / `running` / `done` / `failed` / `rolled_back`。 */
  state: string
  source: string
  /** 逐型计数：`created` / `skipped` / `messages` / `file_references`…（形状由后端定）。 */
  counts: Record<string, number | unknown>
  error: string
  updated_at: string | null
}

/** `/local/status` 的响应（本机档运行态，只读）。 */
export interface LocalStatus {
  deployment: string
  data_dir: string
  database: string
  database_exists: boolean
  database_bytes: number
  database_wal_bytes: number
  server_url: string | null
  imports: LocalImportBatch[]
  unfinished_imports: number
  unimported_file_references: number
  note: string
}

/**
 * 读一次本机档状态。
 *
 * 走 `requestLocal`（不是裸 `fetch`）：基址判定只有一处（`sidecar.ts`），
 * 而且**本机后端没起来时它抛 `LocalUnavailableError`** —— 那条纪律在这儿同样成立：
 * 会话数据的账在本机，读不到就该如实报，不许静默换源。
 *
 * 响应过一道**形状检查**（`imports` 必须是数组）：类型是手写的（没有生成物替我们守契约），
 * 而这条链上有真实的版本错配可能（界面比边车新）。不检查的代价是把"版本对不上"变成
 * 界面上一行 `Cannot read properties of undefined`——那是崩溃，不是交代。
 * 检查失败就抛，调用方（顶栏那条状态条）会把它写成"本机状态读不到：…"。
 */
export async function getLocalStatus(): Promise<LocalStatus> {
  const payload = await requestLocal<LocalStatus>('/local/status')
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.imports)) {
    throw new Error('本机状态响应不认识（没有 imports 这一项：是不是本机后端比界面老？）')
  }
  return payload
}

/** 批次状态的人话名字（认不出来就原样返回：后端加了新状态时界面不该崩）。 */
const BATCH_STATES: Record<string, string> = {
  planned: '已计划',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  rolled_back: '已回滚',
}

export function batchStateLabel(state: string): string {
  return BATCH_STATES[state] ?? state
}

/**
 * 一段给人看摘要（`imports` / `unfinished_imports` / `unimported_file_references` 三笔账）。
 *
 * 抽成纯函数是为了能逐字钉住（`tests/unit/api/local.test.ts`）：
 * 这三句话是"数据在哪"的全部交代，写在组件里就只能靠渲染快照去验了。
 * **空库 / 没导过**时也要说得清（"还没导过"不是"导了 0 条"）。
 */
export function importAccountsText(status: LocalStatus): string {
  const parts: string[] = []
  const latest = status.imports[0]
  if (latest) {
    const created = Number(latest.counts.created ?? 0)
    const skipped = Number(latest.counts.skipped ?? 0)
    parts.push(
      `导入 ${status.imports.length} 批，最近一批${batchStateLabel(latest.state)}` +
        `（新建 ${created} / 跳过 ${skipped}）`,
    )
  } else {
    parts.push('还没导过旧会话')
  }
  parts.push(
    status.unfinished_imports > 0
      ? `${status.unfinished_imports} 批没跑完（重跑同一来源即可续上）`
      : '没有没跑完的批次',
  )
  parts.push(
    status.unimported_file_references > 0
      ? `${status.unimported_file_references} 个文件引用没随导入（文件还在来源服务器上）`
      : '没有未随导入的文件引用',
  )
  return parts.join(' · ')
}
