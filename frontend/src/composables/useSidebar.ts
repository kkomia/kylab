/**
 * 侧栏折叠（本地偏好）。
 *
 * 与主题、字号是同一类东西：**"这台机器怎么显示"**，所以落在 `localStorage`，
 * 不进后端 `app_settings`——换台机器该重新选，它也不是知识库配置。
 *
 * 折叠态做成"图标栏"而不是整条隐藏：导航还在，只是省掉文字与会话列表。
 * 整条隐藏会把"回到对话/概览"变成一次额外的展开动作，省下的横向空间并不值这个价。
 */

import { readonly, ref } from 'vue'

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'kylab-sidebar-collapsed'

function readStored(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    // 隐私模式下 localStorage 不可读：退化成"展开"
    return false
  }
}

const collapsed = ref(typeof window === 'undefined' ? false : readStored())

export function setSidebarCollapsed(next: boolean): void {
  collapsed.value = next
  try {
    if (next) window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '1')
    else window.localStorage.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
  } catch {
    // 存不上就只在本次会话生效
  }
}

export function toggleSidebar(): void {
  setSidebarCollapsed(!collapsed.value)
}

export function useSidebar() {
  return { collapsed: readonly(collapsed), toggleSidebar, setSidebarCollapsed }
}
