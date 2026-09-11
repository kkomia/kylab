/**
 * 主题（《前端设计规范》§2、§8）。
 *
 * 约定：
 * - 主题落在 `document.documentElement.dataset.theme`，与 index.html 的首屏脚本共用 localStorage 键；
 * - 未手动选择时跟随系统，手动选择后以用户选择为准；
 * - 切换只改 CSS 变量，无过渡动画（§8：切换无闪烁）。
 *
 * 第二轮评审批注 2 把主题从侧栏移进「设置 → 外观」，因此这里多了一个显式的
 * 三档选择 `setTheme('light' | 'dark' | 'system')`——"跟随系统"必须是**可选项**，
 * 而它只能靠"清掉本地选择"表达（见 setTheme 的注释）。
 */

import { readonly, ref } from 'vue'

export type ThemeName = 'light' | 'dark'

/** 用户可选的三档：显式浅色 / 显式深色 / 跟随系统。 */
export type ThemeMode = ThemeName | 'system'

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

/** 用户当前的档位；`system` = 没有本地选择、跟随系统（与首屏脚本同一判定）。 */
export const themeMode = ref<ThemeMode>('system')

/** 把主题写到根节点，CSS 变量随之整体切换。 */
export function applyTheme(next: ThemeName): void {
  theme.value = next
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = next
  }
}

/** 应用启动时调用一次：优先用户选择，其次系统偏好。 */
export function initTheme(): ThemeName {
  const stored = readStoredTheme()
  themeMode.value = stored ?? 'system'
  const initial = stored ?? systemTheme()
  applyTheme(initial)

  if (typeof window !== 'undefined' && window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
      if (readStoredTheme() === null) applyTheme(event.matches ? 'dark' : 'light')
    })
  }

  return initial
}

/**
 * 选择主题档位（设置 → 外观）。
 *
 * `system` 要**清掉本地选择**而不只是当前生效——否则"跟随系统"会被下一次
 * `initTheme` 读到的旧值覆盖，看起来像没生效。
 */
export function setTheme(mode: ThemeMode): void {
  themeMode.value = mode
  try {
    if (mode === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY)
    else window.localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // 隐私模式下不可写：不记忆即可，本次会话仍然即时生效
  }
  applyTheme(mode === 'system' ? systemTheme() : mode)
}

/** 手动切换并记忆用户选择。 */
export function toggleTheme(): ThemeName {
  const next: ThemeName = theme.value === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  themeMode.value = next
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
    themeMode: readonly(themeMode),
    applyTheme,
    setTheme,
    toggleTheme,
  }
}
