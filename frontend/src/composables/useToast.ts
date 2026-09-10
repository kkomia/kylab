/**
 * 顶部细条通知（《前端设计规范 v0.3》§7：语义色图标 + 文字，3 秒自消）。
 *
 * 状态模块级单例：任何组件都能推一条，`AppShell` 负责渲染。
 * 不用 emoji，图标由渲染方按 `tone` 选（§8 状态必须图标 + 文字双编码）。
 */

import { readonly, ref } from 'vue'

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface Toast {
  id: number
  tone: ToastTone
  message: string
}

const AUTO_DISMISS_MS = 3000

const toasts = ref<Toast[]>([])
let nextId = 1

function push(tone: ToastTone, message: string): number {
  const id = nextId++
  toasts.value = [...toasts.value, { id, tone, message }]
  setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
  return id
}

function dismiss(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id)
}

export function useToast() {
  return {
    toasts: readonly(toasts),
    notify: (message: string) => push('info', message),
    notifySuccess: (message: string) => push('success', message),
    notifyWarning: (message: string) => push('warning', message),
    notifyError: (message: string) => push('danger', message),
    dismiss,
  }
}

/** 供测试清空全局状态，避免用例之间相互污染。 */
export function resetToasts(): void {
  toasts.value = []
}
