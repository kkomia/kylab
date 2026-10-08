/**
 * 侧栏折叠的三档偏好与窄屏默认（D29，2026-09-28 走查）。
 *
 * 走查实测：420px 下侧栏 240px、内容区只剩 **180px**、每行 **4.53 个字**，输入框那一行
 * 还会溢出（发送键落到视口外）。折叠成图标栏（60px）之后内容区有 360px——那正是用户
 * 自己会去点的那一下，所以**窄屏且用户没表过态**时把它当默认。
 *
 * 为什么要有"没表过态"这一档：旧实现里"展开"就是**删键**，于是"用户说过要展开"与
 * "用户从没管过"是同一件事——那窄屏默认就没法只在后者上生效（用户点开侧栏之后
 * 会被下一次渲染收回去）。键变成 `'1'` / `'0'` / 不存在三档之后才分得开。
 *
 * 这一份只钉这几条纯判定（读偏好 / 点开关 / 快捷键两路），**不渲染组件**：
 * 侧栏导航项的用例在 `tests/layout-shell.test.tsx`（那要整壳），
 * 而原先这里后半段的"知识库组三态"随那一组一起删掉了（2026-10-08，
 * 知识库界面搬去 kybase，见 `app/App.tsx` 的文件头）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toggleSidebarPreference } from '@/features/chat/runtime/shortcutPrefs'
import {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  isSidebarCollapsed,
  toggleSidebar,
  useSidebarStore,
} from '@/features/layout/useSidebar'

/** 让 `matchMedia` 对这条 query 回一个固定答案（其余 query 一律 false）。 */
function stubViewport(narrow: boolean, query = '(max-width: 760px)'): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((q: string) => ({
      matches: q === query ? narrow : false,
      media: q,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}

beforeEach(() => {
  window.localStorage.clear()
  // 模块级单例：用例之间必须自己复位（键不存在 = 没表过态）
  useSidebarStore.setState({ collapsed: null })
})

describe('侧栏折叠：窄屏默认（D29）', () => {
  it('宽屏 + 没表过态 → 展开（旧行为一字不变）', () => {
    stubViewport(false)
    expect(isSidebarCollapsed()).toBe(false)
  })

  it('窄屏 + 没表过态 → **折叠**（420px 下内容区因此有 360px，而不是 180px）', () => {
    stubViewport(true)
    expect(isSidebarCollapsed()).toBe(true)
  })

  it('窄屏但用户明确展开过（`0`）→ 尊重用户，保持展开', () => {
    stubViewport(true)
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '0')
    useSidebarStore.setState({ collapsed: false })
    expect(isSidebarCollapsed()).toBe(false)
  })

  it('窄屏没表态时点一下开关 → 展开，并把 `0` **写下去**（删键会被下一次渲染收回去）', () => {
    stubViewport(true)
    toggleSidebar()
    expect(isSidebarCollapsed()).toBe(false)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('0')
  })

  it('快捷键那一路（Ctrl+B）用同一条口径：窄屏没表态时是"展开"', () => {
    stubViewport(true)
    expect(toggleSidebarPreference()).toBe(false)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('0')
  })

  it('快捷键：宽屏没表态时是"折叠"（与旧行为一致）', () => {
    stubViewport(false)
    expect(toggleSidebarPreference()).toBe(true)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('1')
  })
})
