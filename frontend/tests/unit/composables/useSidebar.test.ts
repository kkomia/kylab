import { beforeEach, describe, expect, it } from 'vitest'

import {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  setSidebarCollapsed,
  toggleSidebar,
  useSidebar,
} from '@/composables/useSidebar'

describe('useSidebar', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setSidebarCollapsed(false)
  })

  it('默认展开', () => {
    expect(useSidebar().collapsed.value).toBe(false)
  })

  it('toggle 翻转并落盘', () => {
    toggleSidebar()
    expect(useSidebar().collapsed.value).toBe(true)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('1')

    toggleSidebar()
    expect(useSidebar().collapsed.value).toBe(false)
    // 展开时**删键**而不是写 '0'：默认值不该在存储里留痕
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBeNull()
  })

  it('setSidebarCollapsed 幂等', () => {
    setSidebarCollapsed(true)
    setSidebarCollapsed(true)
    expect(useSidebar().collapsed.value).toBe(true)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('1')
  })
})
