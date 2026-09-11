import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { request } from '@/api/client'
import {
  clearSessionToken,
  sessionToken,
  setSessionToken,
  useReloginPrompt,
} from '@/composables/useSessionToken'

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
    const reloginBefore = useReloginPrompt().reloginCount.value

    const failure = await request('/knowledge-bases').catch((error: unknown) => error)

    expect((failure as Error).message).toContain('重新登录')
    expect((failure as Error & { status?: number }).status).toBe(401)
    expect(sessionToken()).toBe('')
    expect(useReloginPrompt().reloginCount.value).toBe(reloginBefore + 1)
  })

  it('非 401 的错误保留后端文案，也不触发重新登录', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(409, { code: 'CONFLICT', message: '内容不符' })),
    )
    const before = useReloginPrompt().reloginCount.value

    const failure = await request('/knowledge-bases').catch((error: unknown) => error)

    expect((failure as Error).message).toBe('内容不符')
    expect(useReloginPrompt().reloginCount.value).toBe(before)
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
