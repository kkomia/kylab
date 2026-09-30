/**
 * 对话轮次的**基址分派**（P4 第 2 片）：对话轮次走**本地边车**，其余接口照旧走**服务器**。
 *
 * ## 已完成（P4-2b，2026-09-29）：开关**默认开**
 *
 * 原先这里是 TODO：`api/v1/conversations.py` **没有**任何"追加/写入一轮"的端点 ✗，
 * 而会话是**服务器权威** —— 边车跑完这一轮若没人写回，用户刷新一下这轮就没了 ✗
 * （数据丢失，比"慢一点"严重得多 ✓），所以那时接线放在 `VITE_SIDECAR_TURNS` 后面、
 * **默认关** ✓。现在那两件事都入库并验通了 ✓：
 *
 * 1. **记录一轮的端点**（`f921f8e` ✓）：`POST /api/v1/chat/turns/record` ✓ ——
 *    401 / 422 / 幂等 `recorded=false` / 回读 `message_count: 2` 都实测过 ✓；
 * 2. **边车跑完写回**（`f7b9a2f` ✓）：真机端到端物证 `turn_id: e590b199…` +
 *    `recorded: true` ✓（`.shots/e2e-turn.json` ✓）
 *    → "**跑在本机、账在服务器**"成立 ✓，"丢这一轮"的风险不再存在 ✓。
 *
 * 于是本片翻成 **默认开** ✓：不设 `VITE_SIDECAR_TURNS` 就走边车 ✓。
 *
 * ## 显式关 = 逃生门（保留，不许删）
 *
 * 只有**明确的假值**才关 ✗：`0` / `false` / `no` / `off`（大小写不敏感 ✓）。
 * 这不是历史包袱 ✓：默认开是产品行为 ✓，而"改一个环境变量就能回退服务器那条链" ✗
 * 是万一边车出问题时的**逃生门** ✓ —— 回退不用改代码、不用重新发版 ✓。
 * 被显式关掉时同样**不静默** ✓（`reason` + `console.info` ✓）。
 *
 * ## 为什么分派落在"接口类别"这一层
 *
 * 已定的分界是 **API 层**（不是数据库）：**对话轮次 → 本地边车**，**账号 / 知识库 / 记忆 /
 * 会话列表 / 设置 → 服务器**（权威数据）。判定只有这一处，其余模块不许自己拼基址。
 *
 * ## 只有对话轮次归边车（多一个都要有理由）
 *
 * | 归边车的路径 | 理由 |
 * | --- | --- |
 * | `POST /chat/stream` → 边车 `POST /turn/stream` | 一轮对话：模型调用 + 工具在本机执行 + SSE |
 *
 * **明确不归边车的**：
 * - `POST /chat`（非流式）：边车 `/turn` 的响应是 `answer/steps/notes`，与服务器那套不同，
 *   这一片不换解析口径；
 * - `/chat/turns/{id}/live`（重连补发）：**边车没有会话事件日志**，它只在服务器上存在；
 * - `/chat/approvals/{id}`、`/conversations/*`、`/auth/*`、`/knowledge-bases/*`、`/memory`、
 *   `/settings`：账号与权威数据都在服务器。
 *
 * ## 回退必须可见，不许静默
 *
 * 三种状态都要看得出来 ✓：**走边车** / **被显式关掉**（逃生门 ✓）/ **边车没起来、已回退** ✓。
 * - 回退：`resolveTurnTarget()` 返回 `fallback: true` 与 `reason`，同时 `console.warn` 一条 ✓；
 * - 显式关：同样给 `reason`，并 `console.info` 一条 ✓ —— 那是**主动选择**、不是异常 ✓，
 *   所以用 info 不用 warn ✓；
 * - 走边车：`sidecarStatus().reason` 也说清"打的是哪个基址" ✓（只给一个布尔值的话，
 *   排障时说不出"这一轮到底走的哪条链" ✗）。
 */

import { API_BASE } from './client'

/** 边车默认地址（可被构建期 `VITE_SIDECAR_URL` 覆盖）。 */
export const DEFAULT_SIDECAR_BASE = 'http://127.0.0.1:8765'

/** 这一片**唯一**归边车的接口类别：对话轮次的流式端点。 */
export const SIDECAR_TURN_PATH = '/chat/stream'

/** 边车那一侧对应的路径（`remote_clients.py` 打的就是这个）。 */
export const SIDECAR_STREAM_PATH = '/turn/stream'

/**
 * 边车那台的**审批决定**端点（`app/sidecar.py` 的 `POST /turn/approvals/{id}`，
 * 与服务器 `/chat/approvals/{id}` 同形）。挂 `SIDECAR_STREAM_PATH` 的兄弟位置，
 * 是因为两者服务的是同一条轮次：流停在边车的 `wait` 上，决定就必须送回**那台**。
 */
export const SIDECAR_APPROVAL_PATH = '/turn/approvals'

/** 探测结果的缓存时长：太短会每轮都探、太长会让"边车刚起来"要等。 */
export const PROBE_TTL_MS = 5_000

/**
 * 历史条数的前端上限（与边车 `MAX_HISTORY_MESSAGES` 同一口径）。
 *
 * 为什么要带历史：服务器那条链以**库里的历史**为准；边车这一侧没有库，
 * 不带历史就是**失忆的一轮**（用户立刻感觉到"它忘了上文"，界面还看不出来）。
 * 上限是**提示词预算**：别把整个会话灌进去。
 */
export const MAX_HISTORY_MESSAGES = 20

function env(): Record<string, string | undefined> {
  return (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}
}

/**
 * 用例用的开关覆盖（`undefined` = 不覆盖，按 env 判）。
 *
 * 为什么不靠 `vi.stubEnv`：它只改**测试文件自己**那份 `import.meta.env`，
 * 改不到本模块读的那一份（实测：开了 stub 仍然读到空值）。给一个显式的窄接口更老实，
 * 也让人一眼看出"这是给用例开的门"。
 */
let turnsOverride: boolean | undefined

/** 用例用：强制开关值（传 `undefined` 恢复按 env 判）。 */
export function setSidecarTurnsForTest(value: boolean | undefined): void {
  turnsOverride = value
}

/** 边车基址：去尾斜杠（拼路径时统一由这里保证只有一层斜杠）。 */
export function sidecarBase(): string {
  return (env().VITE_SIDECAR_URL || DEFAULT_SIDECAR_BASE).replace(/\/+$/, '')
}

/**
 * 开关的字面量判定：**默认开** ✓，只有明确的假值才关 ✗。
 *
 * 为什么单独抽成纯函数（而不是把 `env()` 读在里头）：判据是这一片最容易写错的一位 ✓
 * ——`1/true/yes` 那套是"默认关"时代的写法 ✗（只认真值、其余全关 ✗），
 * 现在要求的是**反过来**：`0` / `false` / `no` / `off`（大小写不敏感 ✓、前后空白忽略 ✓）
 * 才关 ✓，**别的值（含不设、含空）一律走边车** ✓。抽出来之后用例能逐个字面量钉住它 ✓，
 * 不必去动构建期的环境变量 ✗（`vi.stubEnv` 改不到本模块读的那一份，见下面那个窄接口 ✓）。
 */
export function sidecarTurnsEnabledFrom(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off')
}

/**
 * 对话轮次**走边车**这个开关（**默认开** ✓，见文件头"已完成"那一段）。
 *
 * 不设 `VITE_SIDECAR_TURNS` → 走边车 ✓；要回退服务器那条链就**显式关** ✓
 * （逃生门：改一个环境变量即可，不必改代码/发版 ✓）。
 */
export function sidecarTurnsEnabled(): boolean {
  if (turnsOverride !== undefined) return turnsOverride
  return sidecarTurnsEnabledFrom(env().VITE_SIDECAR_TURNS)
}

/** 被显式关掉时把用户写的那个值带出来 ✓（`reason` 里要说清是**哪一种**关法 ✓）。 */
function explicitOffReason(): string {
  const raw = env().VITE_SIDECAR_TURNS
  const shown = raw === undefined || raw.trim() === '' ? '' : `=${raw.trim()}`
  return (
    `边车对话轮次被显式关掉（VITE_SIDECAR_TURNS${shown}）` +
    '，走服务器那条链（逃生门；删掉这个变量就回到边车）'
  )
}

/** 这个路径归边车吗？（判定只有这一处） */
export function isSidecarPath(path: string): boolean {
  const clean = path.split('?')[0].replace(/\/+$/, '')
  return clean === SIDECAR_TURN_PATH
}

/** 这个路径该打的基址（对话轮次且开关开着 → 边车，其余 → 服务器）。 */
export function baseForPath(path: string): string {
  return isSidecarPath(path) && sidecarTurnsEnabled() ? sidecarBase() : API_BASE
}

export interface TurnTarget {
  kind: 'sidecar' | 'server'
  /** 实际要打的基址。 */
  base: string
  /** 实际要打的完整 URL。 */
  url: string
  /** 是不是**回退**（边车不可用 → 用服务器那条链）。 */
  fallback: boolean
  /** 给人看的原因（回退或被显式关掉时**必须有** ✓，不许空着 ✗）。 */
  reason: string
}

interface ProbeState {
  available: boolean | null
  reason: string
  at: number
}

const probe: ProbeState = { available: null, reason: '', at: 0 }

/**
 * 给界面读的状态位（走哪条链不是静默的）。
 *
 * `reason` 现在**三种状态都说得清** ✓（默认开之后，"开关未启用"那句话只覆盖"显式关" ✓，
 * 所以不能再用它当默认文案 ✗）：
 *
 * 1. **走边车** ✓ —— 说打的是哪个基址 ✓；
 * 2. **被显式关掉** ✓ —— 逃生门，说清是哪个变量 + 删掉它就能回边车 ✓；
 * 3. **边车没起来、已回退** ✓ —— 带上探测给的原因 ✓。
 *
 * 还没探过就返回第 4 种（`available: null`）：**不猜**边车是好是坏 ✗，
 * 只说"还没探过、默认会先试边车" ✓。
 */
export function sidecarStatus(): {
  base: string
  available: boolean | null
  reason: string
  enabled: boolean
} {
  const base = sidecarBase()
  const enabled = sidecarTurnsEnabled()
  if (!enabled) {
    return { base, available: probe.available, reason: explicitOffReason(), enabled: false }
  }
  if (probe.available === true) {
    return {
      base,
      available: true,
      reason: `走边车：对话轮次打 ${base}${SIDECAR_STREAM_PATH}`,
      enabled: true,
    }
  }
  if (probe.available === false) {
    return {
      base,
      available: false,
      reason: `${probe.reason || '边车不可用'}；已回退到服务器 ${API_BASE}（这条链仍然可用）`,
      enabled: true,
    }
  }
  return {
    base,
    available: null,
    reason: `还没探过边车（默认先试 ${base}，不可用就回退服务器 ${API_BASE}）`,
    enabled: true,
  }
}

/** 用例用：清掉探测缓存（不然几条断言会互相影响）。 */
export function resetSidecarProbe(): void {
  probe.available = null
  probe.reason = ''
  probe.at = 0
}

/**
 * 边车活着吗（`GET /health`，5 秒超时）。
 *
 * 用 `AbortSignal.timeout` 而不是让它慢慢连：不可达时 TCP 连接可能挂很久，
 * 而这里要的是**快速回退**（用户点一下对话，不该先等 3 秒超时）。
 */
export async function sidecarAvailable(options: { force?: boolean } = {}): Promise<boolean> {
  const now = Date.now()
  if (!options.force && probe.available !== null && now - probe.at < PROBE_TTL_MS) {
    return probe.available
  }
  const base = sidecarBase()
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) })
    probe.available = response.ok
    probe.reason = response.ok ? '' : `边车 /health 返回 HTTP ${response.status}`
  } catch (error) {
    probe.available = false
    probe.reason = `边车不可达（${base}）：${error instanceof Error ? error.message : String(error)}`
  }
  probe.at = Date.now()
  return probe.available
}

/**
 * 这一轮对话该打哪里（异步：先看开关、再探边车）。
 *
 * 返回的 `fallback` / `reason` 就是"走哪条链可见"的落点：调用方要把 `reason` 显示或记日志。
 */
export async function resolveTurnTarget(): Promise<TurnTarget> {
  const server: TurnTarget = {
    kind: 'server',
    base: API_BASE,
    url: `${API_BASE}${SIDECAR_TURN_PATH}`,
    fallback: true,
    reason: '',
  }
  if (!sidecarTurnsEnabled()) {
    // **显式关不是失败** ✓，但也绝不静默 ✓（排障要能一眼看出"这一轮走的是服务器、而且是被关掉的"）
    const reason = explicitOffReason()
    console.info(`[sidecar] ${reason}`)
    return { ...server, reason }
  }
  const base = sidecarBase()
  if (await sidecarAvailable()) {
    return {
      kind: 'sidecar',
      base,
      url: `${base}${SIDECAR_STREAM_PATH}`,
      fallback: false,
      reason: '',
    }
  }
  const reason = `${probe.reason || '边车不可用'}；已回退到服务器 ${API_BASE}（这条链仍然可用）`
  console.warn(`[sidecar] ${reason}`)
  return { ...server, reason }
}

/**
 * 审批决定该打到哪边——**与 `resolveTurnTarget` 同一套选址**（边车可用 → 边车；
 * 被显式关/不可用 → 服务器）。
 *
 * 为什么要这一条（交接文档点名的缺口）：流在边车那台停在 `wait` 上等这一下，
 * 而 `decideApproval` 原先写死 `/chat/approvals/{id}` 打服务器——桌面壳（边车模式）
 * 里点「允许一次」，服务器根本不知道这个 id（404），那一轮只能等超时按拒绝走。
 */
export async function resolveApprovalTarget(approvalId: string): Promise<TurnTarget> {
  const encoded = encodeURIComponent(approvalId)
  const server: TurnTarget = {
    kind: 'server',
    base: API_BASE,
    url: `${API_BASE}/chat/approvals/${encoded}`,
    fallback: true,
    reason: '',
  }
  if (!sidecarTurnsEnabled()) {
    return { ...server, reason: explicitOffReason() }
  }
  const base = sidecarBase()
  if (await sidecarAvailable()) {
    return {
      kind: 'sidecar',
      base,
      url: `${base}${SIDECAR_APPROVAL_PATH}/${encoded}`,
      fallback: false,
      reason: '',
    }
  }
  return { ...server, reason: `${probe.reason || '边车不可用'}；已回退到服务器 ${API_BASE}` }
}

/**
 * 服务器那条 `/chat/stream` 的请求体里**边车会用到的那几个字段**（`ChatPayload` 的子集）。
 *
 * 刻意**不加索引签名** `[key: string]: unknown`：加了之后 `ChatPayload` 反而不满足它
 * （TS 要求源类型也有索引签名）→ 调用点会报"missing index signature"。
 * 用"子集 + 结构化类型"就是对的：`ChatPayload` 有 `query` 就够了，多余字段本来就要被丢掉。
 */
export interface ServerTurnPayload {
  /** 用户这一句（服务器那边叫 `query`，边车那边叫 `message` —— 适配就在这一处做）。 */
  query: string
  kb_ids?: string[]
  history?: { role: 'user' | 'assistant'; content: string }[]
  /**
   * 这一轮归属的会话。**必须带**（2026-09-30 修的真 bug）：边车拿它写回服务器
   * （`POST /api/v1/chat/turns/record`）；不带 = 这一轮**不入库**——刷新就没了，
   * 界面上只多一行"未写回"的小字，用户基本不会注意到。
   */
  conversation_id?: string
}

/**
 * 服务器请求体 → 边车请求体（`sidecar.TurnIn`：`message` / `kb_ids` / `history` / `conversation_id`）。
 *
 * 只挑边车认识的字段：其余（`mode`、`permission`、附件……）边车这一侧没有对应语义，
 * 硬塞过去只会被忽略（或更糟：让人以为它们生效了）。
 * ⚠️ **`conversation_id` 不属于"其余"那一类**：边车的 `TurnIn` 有它，写回那一环全靠它——
 * 之前漏在门外，实测表现是每一轮的 note 都写着"未带会话 id，本轮未写回服务器"（真丢数据）。
 * `workspace` 由边车自己按启动参数定 —— 前端不指定，避免"浏览器决定本机路径"这种危险默认。
 *
 * **历史带上**（最近 `MAX_HISTORY_MESSAGES` 条）：不带就是失忆的一轮。
 */
export function toSidecarTurnBody(payload: ServerTurnPayload): Record<string, unknown> {
  // `query` → `message`：**字段名的适配只在这一处**（服务器叫 query、边车叫 message）
  const body: Record<string, unknown> = { message: payload.query }
  if (payload.kb_ids?.length) body.kb_ids = payload.kb_ids
  // 会话 id 照传：边车用它写回服务器（不带就静默丢这一轮，见上面的说明）
  if (payload.conversation_id) body.conversation_id = payload.conversation_id
  const history = (payload.history ?? [])
    .filter((item) => item.role === 'user' || item.role === 'assistant')
    .filter((item) => typeof item.content === 'string' && item.content.trim().length > 0)
    .slice(-MAX_HISTORY_MESSAGES)
  if (history.length) body.history = history
  return body
}
