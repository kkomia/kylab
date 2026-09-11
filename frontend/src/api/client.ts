/**
 * 后端接口封装（与 /api/v1 对齐，工程规范 §4.1）。
 * 组件不直接发请求，一律经本目录。
 */

import { consoleToken, requestConsoleToken } from '@/composables/useConsoleToken'
import { operatorHeaders } from '@/composables/useOperator'
import { clearSessionToken, requestRelogin, sessionToken } from '@/composables/useSessionToken'

export const API_BASE = '/api/v1'

export interface ApiErrorBody {
  code: string
  message: string
}

/**
 * 401 的处理策略：
 * - `redirect`（默认）：业务请求凭据失效 → 清会话令牌并请求重新登录（或提示填控制台令牌）；
 * - `throw`：认证端点自身的 401（密码错、初始化已关闭、`/auth/me` 探测）。
 *   这些不该触发"重新登录"——用户本来就在登录页，触发只会造成跳转循环。
 */
export interface RequestOptions {
  authFailure?: 'redirect' | 'throw'
}

/**
 * 带上控制台凭据。
 *
 * **每个请求都现取，而不是在模块加载时读一次**：用户在设置里刚填完令牌、
 * 或刚登录拿到会话，下一次请求就该生效，不能要求刷新页面。两种凭据都不带时
 * 不加这个头——本机开发（未启用鉴权）连头都不该出现。
 *
 * **登录会话优先于控制台令牌**：账号体系是主路径，控制台令牌是恢复钥匙；
 * 两者同时存在时用会话，这样"退出登录"能立即生效而不是退回令牌身份。
 */
function authHeaders(): Record<string, string> {
  const token = sessionToken() || consoleToken()
  // 操作者归属（G6）随**每个**请求带：它要出现在所有写操作上（上传、建库、删块……），
  // 逐个接口加字段既啰嗦又容易漏。值必须是 id——HTTP 头只能是 ASCII，
  // 而使用者名字可能是中文（实测会抛 UnicodeEncodeError）
  const headers: Record<string, string> = { ...operatorHeaders() }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/** 把响应翻成结果或抛出带后端文案的错误（错误信封见后端 core/exceptions.py）。 */
async function unwrap<T>(response: Response, options: RequestOptions): Promise<T> {
  if (!response.ok) {
    let detail = `请求失败（HTTP ${response.status}）`
    try {
      const body = (await response.json()) as ApiErrorBody
      if (body?.message) detail = body.message
    } catch {
      // 非 JSON 错误体：保留默认文案
    }
    // 401 在错误对象上标一个记号：界面据此重新登录或弹"填令牌"，
    // 而不是把后端原文（"请在请求头带上 Authorization: Bearer …"）甩给用户。
    // 用 Error 的自定义属性而不是新异常类，是为了让所有既有 catch 继续工作。
    if (response.status === 401 && options.authFailure !== 'throw') {
      if (sessionToken()) {
        // 登录过但会话失效（过期/被吊销/改密）：清掉本地令牌，请用户重新登录
        clearSessionToken()
        requestRelogin()
        detail = '登录已过期，请重新登录'
      } else {
        // 没登录过、也没会话令牌：控制台令牌通道的恢复入口
        requestConsoleToken()
        detail = '需要控制台令牌：请在「设置 → 系统与安全」粘贴令牌后重试'
      }
    }
    const error = new Error(detail) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** 带统一错误处理的 JSON 请求。 */
export async function request<T>(
  path: string,
  init?: RequestInit,
  options: RequestOptions = {},
): Promise<T> {
  return unwrap<T>(
    await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
        ...(init?.headers ?? {}),
      },
    }),
    options,
  )
}

/**
 * 上传文件。
 *
 * 单独一个函数而不是复用 ``request``：上传必须让浏览器自己带
 * ``multipart/form-data; boundary=...``，手写 Content-Type 会把 boundary 弄丢，
 * 后端直接解析失败。
 */
export async function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData()
  form.append('file', file)
  return unwrap<T>(
    await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      body: form,
      headers: authHeaders(),
    }),
    {},
  )
}
