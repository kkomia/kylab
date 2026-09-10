/**
 * 后端接口封装（与 /api/v1 对齐，工程规范 §4.1）。
 * 组件不直接发请求，一律经本目录。
 */

export const API_BASE = '/api/v1'

export interface ApiErrorBody {
  code: string
  message: string
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
    throw new Error(detail)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** 带统一错误处理的 JSON 请求。 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return unwrap<T>(
    await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      ...init,
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
  return unwrap<T>(await fetch(`${API_BASE}${path}`, { method: 'POST', body: form }))
}
