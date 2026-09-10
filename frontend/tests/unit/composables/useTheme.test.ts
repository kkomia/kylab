import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  THEME_STORAGE_KEY,
  applyTheme,
  initTheme,
  toggleTheme,
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
