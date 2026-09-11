import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  THEME_STORAGE_KEY,
  applyTheme,
  initTheme,
  setTheme,
  toggleTheme,
  themeMode,
  useTheme,
} from '@/composables/useTheme'

/** jsdom 未实现 matchMedia，这里按需打桩。 */
function stubMatchMedia(matches: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

describe('useTheme', () => {
  beforeEach(() => {
    window.localStorage.clear()
    delete document.documentElement.dataset.theme
    stubMatchMedia(false)
  })

  it('无用户选择时跟随系统偏好', () => {
    stubMatchMedia(true)

    expect(initTheme()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('优先使用用户已保存的选择', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    stubMatchMedia(true)

    expect(initTheme()).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('toggleTheme 翻转主题、写根节点并落盘', () => {
    applyTheme('light')

    expect(toggleTheme()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(useTheme().theme.value).toBe('dark')
  })
})

describe('useTheme.setTheme', () => {
  beforeEach(() => {
    window.localStorage.clear()
    stubMatchMedia(false)
  })

  it('显式选择会落盘并即时生效', () => {
    setTheme('dark')

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(themeMode.value).toBe('dark')
  })

  it('跟随系统要清掉本地选择，且按系统偏好生效', () => {
    // 不清本地选择的话，下一次 initTheme 会读到旧值，"跟随系统"看起来没生效
    setTheme('dark')
    stubMatchMedia(true)

    setTheme('system')

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    expect(themeMode.value).toBe('system')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
