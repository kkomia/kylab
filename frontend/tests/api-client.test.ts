/**
 * 会话令牌与 401（`api/client.ts`）——**从旧 Vue 版 `tests/unit/api/client.test.ts` 整份搬来的**
 * （实现同一份代码，只把会话令牌的 import 路径换到 `@/lib/session`）。
 *
 * 新前端的其它用例都把这层 mock 掉了，这一份是**真发请求、真解析响应**的那条链路。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { request } from '@/api/client'
import { useSessionStore } from '@/lib/session'
import { clearSessionToken, sessionToken, setSessionToken } from '@/lib/session'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('api/client', () => {
  beforeEach(() => {
    window.localStorage.clear()
    clearSessionToken()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('401 清掉会话并请求重新登录（唯一的恢复路径）', async () => {
    // 会话过期是常态（滑动续期到期 / 改密 / 被吊销）。此时该做的就是回登录页。
    setSessionToken('kylab_st_expired')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { code: 'UNAUTHORIZED', message: '会话已失效' })),
    )
    const reloginBefore = useSessionStore.getState().reloginCount

    const failure = await request('/knowledge-bases').catch((error: unknown) => error)

    expect((failure as Error).message).toContain('重新登录')
    expect((failure as Error & { status?: number }).status).toBe(401)
    expect(sessionToken()).toBe('')
    expect(useSessionStore.getState().reloginCount).toBe(reloginBefore + 1)
  })

  it('非 401 的错误保留后端文案，也不触发重新登录', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(409, { code: 'CONFLICT', message: '内容不符' })),
    )
    const before = useSessionStore.getState().reloginCount

    const failure = await request('/knowledge-bases').catch((error: unknown) => error)

    expect((failure as Error).message).toBe('内容不符')
    expect(useSessionStore.getState().reloginCount).toBe(before)
  })

  it('带上会话令牌后会加 Authorization 头', async () => {
    setSessionToken('kylab_st_abc')
    // 泛型给出 fetch 的签名，实现里就不必写用不到的形参（eslint 不许下划线占位）
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse(200, { ok: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await request('/knowledge-bases')

    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBe('Bearer kylab_st_abc')
  })

  it('**FormData 请求不自己写 Content-Type**（上传全靠这一条）', async () => {
    // 手写 `application/json` 会让后端解析不出任何字段——实测的表现是
    // `422 {"message": "file: Field required"}`，看着像"请求里没带文件"。
    // 浏览器的规矩：`FormData` 的 Content-Type（带 boundary）只能由它自己写，
    // 而**作者显式设过的那个头它不会覆盖**。
    const calls: RequestInit[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init)
        return jsonResponse(200, { ok: true })
      }),
    )

    const form = new FormData()
    form.append('file', new Blob(['x']), 'a.png')
    await request('/auth/avatar', { method: 'POST', body: form })
    await request('/auth/login', { method: 'POST', body: JSON.stringify({}) })

    const headersOf = (init: RequestInit) => (init.headers ?? {}) as Record<string, string>
    expect(headersOf(calls[0])['Content-Type']).toBeUndefined()
    // JSON 那条路照旧带上（后端也靠它认 body）
    expect(headersOf(calls[1])['Content-Type']).toBe('application/json')
  })

  it('没有令牌时不加 Authorization 头', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse(200, { ok: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await request('/knowledge-bases')

    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })
})
