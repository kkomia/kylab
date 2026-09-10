/**
 * 主题切换（《前端设计规范 v0.1》§2、§8）。
 *
 * 约定：
 * - 主题落在 `document.documentElement.dataset.theme`，与 index.html 的首屏脚本共用 localStorage 键；
 * - 未手动选择时跟随系统，手动选择后以用户选择为准；
 * - 切换只改 CSS 变量，无过渡动画（§8：切换无闪烁）。
 */

import { readonly, ref } from 'vue'

export type ThemeName = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'kylab-theme'

function systemTheme(): ThemeName {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readStoredTheme(): ThemeName | null {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
    return saved === 'light' || saved === 'dark' ? saved : null
  } catch {
    return null
  }
}

const theme = ref<ThemeName>('light')

/** 把主题写到根节点，CSS 变量随之整体切换。 */
export function applyTheme(next: ThemeName): void {
  theme.value = next
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = next
  }
}

/** 应用启动时调用一次：优先用户选择，其次系统偏好。 */
export function initTheme(): ThemeName {
  const initial = readStoredTheme() ?? systemTheme()
  applyTheme(initial)

  if (typeof window !== 'undefined' && window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
      if (readStoredTheme() === null) applyTheme(event.matches ? 'dark' : 'light')
    })
  }

  return initial
}

/** 手动切换并记忆用户选择。 */
export function toggleTheme(): ThemeName {
  const next: ThemeName = theme.value === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next)
  } catch {
    // 隐私模式下 localStorage 不可写：不记忆即可，不影响本次会话
  }
  return next
}

export function useTheme() {
  return {
    theme: readonly(theme),
    applyTheme,
    toggleTheme,
  }
}
