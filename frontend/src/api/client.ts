/**
 * 后端接口封装（与 /api/v1 对齐，工程规范 §4.1）。
 * 组件不直接发请求，一律经本目录。
 */

import { consoleToken } from '@/composables/useConsoleToken'
import { operatorHeaders } from '@/composables/useOperator'

export const API_BASE = '/api/v1'

export interface ApiErrorBody {
  code: string
  message: string
}

/**
 * 带上控制台凭据。
 *
 * **每个请求都现取，而不是在模块加载时读一次**：用户在设置里刚填完令牌，
 * 下一次请求就该生效，不能要求刷新页面。令牌为空时不加这个头——
 * 本机开发（未启用鉴权）连头都不该出现。
 */
function authHeaders(): Record<string, string> {
  const token = consoleToken()
  // 操作者归属（G6）随**每个**请求带：它要出现在所有写操作上（上传、建库、删块……），
  // 逐个接口加字段既啰嗦又容易漏。值必须是 id——HTTP 头只能是 ASCII，
  // 而使用者名字可能是中文（实测会抛 UnicodeEncodeError）
  const headers: Record<string, string> = { ...operatorHeaders() }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/** 把响应翻成结果或抛出带后端文案的错误（错误信封见后端 core/exceptions.py）。 */
async function unwrap<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `请求失败（HTTP ${response.status}）`
    try {
      const body = (await response.json()) as ApiErrorBody
      if (body?.message) detail = body.message
    } catch {
      // 非 JSON 错误体：保留默认文案
    }
    // 401 在错误对象上标一个记号：界面据此弹"填令牌"，而不是把原始文案甩给用户。
    // 用 Error 的自定义属性而不是新异常类，是为了让所有既有 catch 继续工作。
    const error = new Error(detail) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** 带统一错误处理的 JSON 请求。 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return unwrap<T>(
    await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
        ...(init?.headers ?? {}),
      },
    }),
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
  )
}
