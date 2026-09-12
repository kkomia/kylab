import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '@/api/stats'
import { useStatsStore } from '@/stores/stats'

const dashboard = { total_documents: 2 } as unknown as api.Dashboard
const usage = { total: { calls: 3 } } as unknown as api.Usage

describe('useStatsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('两个接口并行取：总时长不该等于两者之和', async () => {
    const order: string[] = []
    vi.spyOn(api, 'getDashboard').mockImplementation(async () => {
      order.push('dashboard:start')
      await new Promise((r) => setTimeout(r, 30))
      order.push('dashboard:end')
      return dashboard
    })
    vi.spyOn(api, 'getUsage').mockImplementation(async () => {
      order.push('usage:start')
      await new Promise((r) => setTimeout(r, 30))
      order.push('usage:end')
      return usage
    })
    const store = useStatsStore()

    await store.load()

    // 串行的话 order 会是 dashboard:start,end 然后 usage:start,end
    expect(order.slice(0, 2)).toEqual(['dashboard:start', 'usage:start'])
    expect(store.dashboard).toStrictEqual(dashboard)
    expect(store.usage).toStrictEqual(usage)
    expect(store.loaded).toBe(true)
  })

  it('用量失败不算整体失败：它来自另一张表，只让那一块空着', async () => {
    vi.spyOn(api, 'getDashboard').mockResolvedValue(dashboard)
    vi.spyOn(api, 'getUsage').mockRejectedValue(new Error('用量表不可达'))
    const store = useStatsStore()

    await store.load()

    expect(store.dashboard).toStrictEqual(dashboard)
    expect(store.usage).toBeNull()
    expect(store.error).toBe('')
  })

  it('驾驶舱失败时如实报错，但不阻塞用量', async () => {
    vi.spyOn(api, 'getDashboard').mockRejectedValue(new Error('统计不可达'))
    vi.spyOn(api, 'getUsage').mockResolvedValue(usage)
    const store = useStatsStore()

    await store.load()

    expect(store.error).toBe('统计不可达')
    expect(store.usage).toStrictEqual(usage)
    expect(store.loaded).toBe(false)
  })

  it('并发 load 合并成一次；已有缓存时 prefetch 不再请求', async () => {
    const dash = vi.spyOn(api, 'getDashboard').mockResolvedValue(dashboard)
    const use = vi.spyOn(api, 'getUsage').mockResolvedValue(usage)
    const store = useStatsStore()

    await Promise.all([store.load(), store.load()])
    expect(dash).toHaveBeenCalledTimes(1)
    expect(use).toHaveBeenCalledTimes(1)

    await store.prefetch()
    expect(dash).toHaveBeenCalledTimes(1)
  })
})
