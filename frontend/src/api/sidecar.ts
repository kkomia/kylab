/**
 * 对话轮次的**基址分派**（P4 第 2 片）：对话轮次走**本地边车**，其余接口照旧走**服务器**。
 *
 * ## TODO（P4-2b，服务器侧）：缺"记录一轮"的端点
 *
 * 会话是**服务器权威**：一轮的落库长在 chat 处理链里（`api/v1/chat.py` 的 `start_turn` /
 * `close_turn`），而 `api/v1/conversations.py` **没有**任何"追加/写入一轮"的端点
 * （只有新建 / 改标题 / 回退 / 分叉 / 文件那几条）。
 * 所以：**若边车跑完这一轮而没人写回服务器，用户刷新一下这轮就没了** —— 那是数据丢失，
 * 比"慢一点"严重得多。因此本片把接线放在 `VITE_SIDECAR_TURNS` 这个**显式开关**后面、
 * **默认关**；开关状态由 `sidecarStatus()` 暴露，界面能看出当前走哪条链。
 *
 * P4-2b 加上"记录一轮"的端点之后，应当由**边车自己**在跑完后写回服务器
 * （它有用户令牌，且本来就在跟服务器说话）：跑在本机、账在服务器。**写入失败要如实报**，
 * 不许当成功。那时这个开关才能默认开。
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
 * 边车没起来（或探测失败）时回退到服务器那条链，但回退是**显式**的：
 * `resolveTurnTarget()` 返回 `fallback: true` 与 `reason`，同时 `console.warn` 一条；
 * 开关没开时同样给 `reason`，并 `console.info` 一条（这是默认状态，用 info 不用 warn）。
 */

import { API_BASE } from './client'

/** 边车默认地址（可被构建期 `VITE_SIDECAR_URL` 覆盖）。 */
export const DEFAULT_SIDECAR_BASE = 'http://127.0.0.1:8765'

/** 这一片**唯一**归边车的接口类别：对话轮次的流式端点。 */
export const SIDECAR_TURN_PATH = '/chat/stream'

/** 边车那一侧对应的路径（`remote_clients.py` 打的就是这个）。 */
export const SIDECAR_STREAM_PATH = '/turn/stream'

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
 * 对话轮次**走边车**这个开关（默认关，见文件头 TODO）。
 *
 * 只认 `VITE_SIDECAR_TURNS` 的明确真值：`1` / `true` / `yes`（大小写不敏感）。
 * 别的值（含空）一律当关 —— **默认必须是关**：缺"记录一轮"端点时走边车会丢这一轮。
 */
export function sidecarTurnsEnabled(): boolean {
  if (turnsOverride !== undefined) return turnsOverride
  const raw = (env().VITE_SIDECAR_TURNS ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
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
  /** 给人看的原因（回退或开关没开时**必须有**，不许空着）。 */
  reason: string
}

interface ProbeState {
  available: boolean | null
  reason: string
  at: number
}

const probe: ProbeState = { available: null, reason: '', at: 0 }

/** 给界面读的状态位（走哪条链不是静默的）。 */
export function sidecarStatus(): {
  base: string
  available: boolean | null
  reason: string
  enabled: boolean
} {
  return {
    base: sidecarBase(),
    available: probe.available,
    reason: probe.reason,
    enabled: sidecarTurnsEnabled(),
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
    // **开关没开不是失败**，但也绝不静默（用户/排障都要能看出"这一轮走的是服务器"）
    const reason = '边车对话轮次开关未启用（VITE_SIDECAR_TURNS），走服务器那条链'
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
}

/**
 * 服务器请求体 → 边车请求体（`sidecar.TurnIn`：`message` / `kb_ids` / `history`）。
 *
 * 只挑边车认识的字段：其余（`conversation_id`、`mode`、`permission`、附件……）边车这一侧
 * 没有对应语义，硬塞过去只会被忽略（或更糟：让人以为它们生效了）。
 * `workspace` 由边车自己按启动参数定 —— 前端不指定，避免"浏览器决定本机路径"这种危险默认。
 *
 * **历史带上**（最近 `MAX_HISTORY_MESSAGES` 条）：不带就是失忆的一轮。
 */
export function toSidecarTurnBody(payload: ServerTurnPayload): Record<string, unknown> {
  // `query` → `message`：**字段名的适配只在这一处**（服务器叫 query、边车叫 message）
  const body: Record<string, unknown> = { message: payload.query }
  if (payload.kb_ids?.length) body.kb_ids = payload.kb_ids
  const history = (payload.history ?? [])
    .filter((item) => item.role === 'user' || item.role === 'assistant')
    .filter((item) => typeof item.content === 'string' && item.content.trim().length > 0)
    .slice(-MAX_HISTORY_MESSAGES)
  if (history.length) body.history = history
  return body
}
