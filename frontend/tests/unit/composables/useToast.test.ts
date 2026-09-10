import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resetToasts, useToast } from '@/composables/useToast'

describe('useToast', () => {
  beforeEach(() => {
    resetToasts()
    vi.useFakeTimers()
  })

  it('推入的通知按顺序保留', () => {
    const { toasts, notifySuccess, notifyError } = useToast()

    notifySuccess('已提交')
    notifyError('上传失败')

    expect(toasts.value.map((toast) => toast.message)).toEqual(['已提交', '上传失败'])
    expect(toasts.value.map((toast) => toast.tone)).toEqual(['success', 'danger'])
  })

  it('3 秒后自动消失', () => {
    const { toasts, notify } = useToast()

    notify('正在处理')
    expect(toasts.value).toHaveLength(1)

    vi.advanceTimersByTime(3000)
    expect(toasts.value).toHaveLength(0)
  })

  it('可以手动提前关掉某一条', () => {
    const { toasts, notify, dismiss } = useToast()

    const first = notify('第一条')
    notify('第二条')
    dismiss(first)

    expect(toasts.value.map((toast) => toast.message)).toEqual(['第二条'])
  })
})
