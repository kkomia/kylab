import { beforeEach, describe, expect, it } from 'vitest'

import { setConsoleToken } from '@/composables/useConsoleToken'
import {
  SESSION_TOKEN_STORAGE_KEY,
  authStatus,
  clearSessionToken,
  currentUser,
  hasCredential,
  requestRelogin,
  sessionToken,
  setSessionToken,
  useReloginPrompt,
} from '@/composables/useSessionToken'

describe('useSessionToken', () => {
  beforeEach(() => {
    window.localStorage.clear()
    clearSessionToken()
    authStatus.value = null
    setConsoleToken('')
  })

  it('默认没有会话', () => {
    expect(sessionToken()).toBe('')
    expect(currentUser.value).toBeNull()
    expect(hasCredential()).toBe(false)
  })

  it('保存后落盘，且两端空白被清掉', () => {
    setSessionToken('  kylab_st_abc\n')

    expect(sessionToken()).toBe('kylab_st_abc')
    expect(window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY)).toBe('kylab_st_abc')
  })

  it('持有控制台令牌也算有凭据', () => {
    // 账号体系之前的老部署只有控制台令牌：它必须仍被认作"有凭据"，
    // 否则升级后会被守卫挡在登录页，而令牌本身是应急恢复钥匙
    setConsoleToken('kylab_console_abc')

    expect(hasCredential()).toBe(true)
  })

  it('清除会话会同时清掉当前账号', () => {
    setSessionToken('kylab_st_abc')
    currentUser.value = { id: 'user_1', username: 'admin', name: '管理员', role: 'admin' }

    clearSessionToken()

    expect(sessionToken()).toBe('')
    expect(currentUser.value).toBeNull()
    expect(window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('重新登录信号是递增计数：连续触发多次 watch 都能收到', () => {
    const before = useReloginPrompt().reloginCount.value

    requestRelogin()
    requestRelogin()

    expect(useReloginPrompt().reloginCount.value).toBe(before + 2)
  })
})
