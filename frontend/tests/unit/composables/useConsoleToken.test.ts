import { beforeEach, describe, expect, it } from 'vitest'

import {
  CONSOLE_TOKEN_STORAGE_KEY,
  clearConsoleToken,
  consoleToken,
  requestConsoleToken,
  setConsoleToken,
  useConsoleToken,
  useConsoleTokenPrompt,
} from '@/composables/useConsoleToken'

describe('useConsoleToken', () => {
  beforeEach(() => {
    window.localStorage.clear()
    clearConsoleToken()
  })

  it('默认没有令牌', () => {
    expect(consoleToken()).toBe('')
  })

  it('保存后落盘，并且每次读取都取得到', () => {
    setConsoleToken('kylab_console_abc')

    expect(consoleToken()).toBe('kylab_console_abc')
    expect(window.localStorage.getItem(CONSOLE_TOKEN_STORAGE_KEY)).toBe('kylab_console_abc')
    expect(useConsoleToken().token.value).toBe('kylab_console_abc')
  })

  it('两端的空白会被清掉', () => {
    // 用户从终端或文档里复制令牌，常带着换行或空格——不 trim 会一直在服务端比对失败
    setConsoleToken('  kylab_console_abc\n')

    expect(consoleToken()).toBe('kylab_console_abc')
  })

  it('清除后存储与内存都为空', () => {
    setConsoleToken('kylab_console_abc')
    clearConsoleToken()

    expect(consoleToken()).toBe('')
    expect(window.localStorage.getItem(CONSOLE_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('存空字符串等于清除，不会留下空值', () => {
    setConsoleToken('kylab_console_abc')
    setConsoleToken('')

    expect(window.localStorage.getItem(CONSOLE_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('401 提示信号是递增计数：连续触发多次 watch 都能收到', () => {
    const before = useConsoleTokenPrompt().promptCount.value

    requestConsoleToken()
    requestConsoleToken()

    expect(useConsoleTokenPrompt().promptCount.value).toBe(before + 2)
  })
})
