import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { request } from '@/api/client'
import {
  clearConsoleToken,
  setConsoleToken,
  useConsoleTokenPrompt,
} from '@/composables/useConsoleToken'
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
    clearConsoleToken()
    clearSessionToken()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('带会话令牌的 401 清掉会话并请求重新登录，不提示填令牌', async () => {
    // 账号体系下会话过期是常态（7 天 / 改密 / 被吊销）。此时该做的是回登录页，
    // 而不是弹"去设置里粘贴控制台令牌"——用户根本没有令牌
    setSessionToken('kylab_st_expired')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { code: 'UNAUTHORIZED', message: '会话已失效' })),
    )
    const reloginBefore = useReloginPrompt().reloginCount.value
    const tokenPromptBefore = useConsoleTokenPrompt().promptCount.value

    const failure = await request('/knowledge-bases').catch((error: unknown) => error)

    expect((failure as Error).message).toContain('重新登录')
    expect(sessionToken()).toBe('')
    expect(useReloginPrompt().reloginCount.value).toBe(reloginBefore + 1)
    expect(useConsoleTokenPrompt().promptCount.value).toBe(tokenPromptBefore)
  })

  it('会话令牌优先于控制台令牌：同时存在时用它', async () => {
    setSessionToken('kylab_st_primary')
    setConsoleToken('kylab_console_backup')
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse(200, { ok: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await request('/knowledge-bases')

    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBe('Bearer kylab_st_primary')
  })

  it('401 时触发"填令牌"信号，并把后端原文换成操作指引', async () => {
    // 后端原文（"请在请求头带上 Authorization: Bearer …"）是给 API 调用者看的，
    // 控制台用户需要知道去哪填——这条就是防"每个页面甩一句缺少凭据却没有恢复入口"
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(401, {
          code: 'UNAUTHORIZED',
          message: '缺少凭据：请在请求头带上 Authorization',
        }),
      ),
    )
    const before = useConsoleTokenPrompt().promptCount.value

    const failure = await request('/knowledge-bases').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('设置')
    expect((failure as Error).message).not.toContain('Authorization')
    expect((failure as Error & { status?: number }).status).toBe(401)
    expect(useConsoleTokenPrompt().promptCount.value).toBe(before + 1)
  })

  it('非 401 的错误保留后端文案，也不触发"填令牌"信号', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(409, { code: 'CONFLICT', message: '内容不符' })),
    )
    const before = useConsoleTokenPrompt().promptCount.value

    const failure = await request('/knowledge-bases').catch((error: unknown) => error)

    expect((failure as Error).message).toBe('内容不符')
    expect(useConsoleTokenPrompt().promptCount.value).toBe(before)
  })

  it('填过令牌后请求会带上 Authorization 头', async () => {
    setConsoleToken('kylab_console_abc')
    // 泛型给出 fetch 的签名，实现里就不必写用不到的形参（eslint 不许下划线占位）
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse(200, { ok: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await request('/knowledge-bases')

    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBe('Bearer kylab_console_abc')
  })

  it('没填令牌时不加 Authorization 头', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse(200, { ok: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await request('/knowledge-bases')

    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })
})
