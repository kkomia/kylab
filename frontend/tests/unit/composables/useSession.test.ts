import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setConsoleToken } from '@/composables/useConsoleToken'
import { ensureAuthStatus, login, logout, restoreSession, setup } from '@/composables/useSession'
import {
  authStatus,
  clearSessionToken,
  currentUser,
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

const ACCOUNT = { id: 'user_1', username: 'admin', name: '管理员', role: 'admin' }

describe('useSession', () => {
  beforeEach(() => {
    window.localStorage.clear()
    clearSessionToken()
    authStatus.value = null
    setConsoleToken('')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('引导状态只请求一次，force 才重取', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { needs_token: false, auth_enabled: true, needs_setup: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await ensureAuthStatus()
    await ensureAuthStatus()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(authStatus.value?.needs_setup).toBe(true)

    await ensureAuthStatus(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('引导状态拿不到时返回 null 而不是抛：守卫不能因此死循环', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await expect(ensureAuthStatus()).resolves.toBeNull()
  })

  it('登录成功后持有令牌与账号', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/auth/login')) {
          return jsonResponse(200, { token: 'kylab_st_new', user: ACCOUNT })
        }
        return jsonResponse(200, { needs_token: false, auth_enabled: true, needs_setup: false })
      }),
    )

    const result = await login('admin', 'password-123')

    expect(result.user.name).toBe('管理员')
    expect(sessionToken()).toBe('kylab_st_new')
    expect(currentUser.value?.role).toBe('admin')
  })

  it('登录失败（401）不触发"重新登录"信号——用户本来就在登录页', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { code: 'UNAUTHORIZED', message: '用户名或密码不正确' })),
    )
    const before = useReloginPrompt().reloginCount.value

    const failure = await login('admin', 'wrong').catch((error: unknown) => error)

    expect((failure as Error).message).toBe('用户名或密码不正确')
    expect(useReloginPrompt().reloginCount.value).toBe(before)
    expect(sessionToken()).toBe('')
  })

  it('首次初始化与登录同构：成功即进入', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/auth/setup')) {
          return jsonResponse(200, { token: 'kylab_st_first', user: ACCOUNT })
        }
        return jsonResponse(200, { needs_token: false, auth_enabled: true, needs_setup: false })
      }),
    )

    await setup('admin', 'password-123', '管理员')

    expect(sessionToken()).toBe('kylab_st_first')
    expect(currentUser.value?.username).toBe('admin')
  })

  it('退出登录：即使服务端调用失败也清掉本地令牌', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/auth/login')) {
          return jsonResponse(200, { token: 'kylab_st_x', user: ACCOUNT })
        }
        if (url.includes('/auth/logout')) {
          return jsonResponse(500, { code: 'INTERNAL', message: '服务端异常' })
        }
        return jsonResponse(200, { needs_token: false, auth_enabled: true, needs_setup: false })
      }),
    )
    await login('admin', 'password-123')

    await logout()

    expect(sessionToken()).toBe('')
    expect(currentUser.value).toBeNull()
  })

  it('restoreSession：令牌失效时清掉本地令牌', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { message: '会话已失效' })),
    )
    setSessionToken('kylab_st_expired')

    await expect(restoreSession()).resolves.toBe(false)
    expect(sessionToken()).toBe('')
  })

  it('restoreSession：没有令牌时直接返回 false，不发请求', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, ACCOUNT))
    vi.stubGlobal('fetch', fetchMock)

    await expect(restoreSession()).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
