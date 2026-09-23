/**
 * 侧栏折叠（本地偏好）——与旧前端 `composables/useSidebar.ts` 逐条对应。
 *
 * 与主题、字号是同一类东西：**"这台机器怎么显示"**，所以落在 `localStorage`，
 * 不进后端 `app_settings`——换台机器该重新选，它也不是知识库配置。
 *
 * 折叠态做成"图标栏"（60px）而不是整条隐藏：导航还在，只是省掉文字与会话列表。
 * 整条隐藏会把"回到对话/概览"变成一次额外的展开动作，省下的横向空间并不值这个价。
 *
 * ## 契约（与 chat 域共用，键名与事件名一字不差）
 *
 * 对话页的快捷键把折叠偏好翻过来之后会**广播 `kylab:sidebar-toggle`**
 * （`chat/runtime/shortcutPrefs.ts` 模块头写的那两条约定）——所以侧栏不只是“自己记着”，
 * 还要**听着**：`storage` 事件只在别的标签页之间派发，本页自己改的不算，
 * 缺了这条监听就会出现"按了 Ctrl+B，偏好翻了、侧栏没动"。
 *
 * 用 zustand 而不是 React Context：侧栏与历史会话面板（都在壳这一层）要读同一份状态，
 * 而且它是**模块级单例**——与旧版那个 `ref` 的地位一致。
 */
import { useEffect } from 'react'
import { create } from 'zustand'

/** 折叠态的存储键（与旧 `useSidebar` 和 chat 域的 `shortcutPrefs` 共用）。 */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'kylab-sidebar-collapsed'

/** 折叠态变化的广播事件（`detail.collapsed`）。 */
export const SIDEBAR_TOGGLE_EVENT = 'kylab:sidebar-toggle'

function readStored(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    // 隐私模式下 localStorage 不可读：退化成"展开"
    return false
  }
}

function writeStored(next: boolean): void {
  try {
    if (next) window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '1')
    else window.localStorage.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
  } catch {
    // 存不上就只在本次会话生效
  }
}

interface SidebarState {
  collapsed: boolean
  setCollapsed: (next: boolean) => void
  toggle: () => void
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  collapsed: typeof window === 'undefined' ? false : readStored(),
  setCollapsed: (next) => {
    writeStored(next)
    set({ collapsed: next })
  },
  toggle: () => get().setCollapsed(!get().collapsed),
}))

/** 设置折叠态（落盘 + 上屏）。**不广播**：广播是快捷键那一侧的事。 */
export function setSidebarCollapsed(next: boolean): void {
  useSidebarStore.getState().setCollapsed(next)
}

export function toggleSidebar(): void {
  useSidebarStore.getState().toggle()
}

/** 当前折叠态（非组件代码用）。 */
export function isSidebarCollapsed(): boolean {
  return useSidebarStore.getState().collapsed
}

/**
 * 侧栏现在的宽度（CSS 值）。
 *
 * 盖住内容区的那些浮层（历史会话面板）要靠它算"左边让给侧栏多少"：
 * 固定写 `--sidebar-width` 的话，折叠之后会在两者之间留一条 180px 的内容区。
 */
export function resolveSidebarWidth(collapsed = isSidebarCollapsed()): string {
  return collapsed ? 'var(--sidebar-collapsed-width)' : 'var(--sidebar-width)'
}

/**
 * 订阅外部来的折叠信号（快捷键广播 / 别的标签页改动）。
 *
 * 细节：`storage` 事件只在**别的标签页**写这个键时触发，本页自己写的不会回环——
 * 所以两条监听互不重复。
 */
export function useSidebar() {
  const collapsed = useSidebarStore((state) => state.collapsed)

  useEffect(() => {
    const onToggle = (event: Event): void => {
      const detail = (event as CustomEvent<{ collapsed?: boolean }>).detail
      // detail 里带着目标状态就用它；没带（第三方广播）就翻一下
      setSidebarCollapsed(detail?.collapsed ?? !isSidebarCollapsed())
    }
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== SIDEBAR_COLLAPSED_STORAGE_KEY) return
      useSidebarStore.setState({ collapsed: readStored() })
    }
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, onToggle)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(SIDEBAR_TOGGLE_EVENT, onToggle)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  return { collapsed, toggleSidebar, setSidebarCollapsed }
}
