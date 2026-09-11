import { beforeEach, describe, expect, it } from 'vitest'

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

  it('只有会话令牌算凭据', () => {
    // v0.11 起模型身份与控制台凭据都收口到账号：没有第二种凭据可以冒充"已登录"。
    // 这条用例的意义是防止将来又冒出一条隐式凭据通道（那正是被取消的那套）。
    expect(hasCredential()).toBe(false)

    setSessionToken('kylab_st_abc')
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
