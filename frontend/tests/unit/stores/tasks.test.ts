import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '@/api/tasks'
import { useTaskStore } from '@/stores/tasks'

function task(id: string, state: api.TaskState): api.TaskSummary {
  return {
    id,
    kind: 'parse',
    state,
    document_id: 'doc_1',
    knowledge_base_id: 'kb_1',
    document_name: 'a.md',
    attempts: 1,
    max_attempts: 5,
    error: null,
    next_run_at: null,
    lease_expires_at: null,
    created_at: '2026-09-12T00:00:00Z',
    updated_at: '2026-09-12T00:00:00Z',
    health: 'done',
    health_label: '已完成',
    health_detail: '',
  }
}

describe('useTaskStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('加载后写入列表并标记 loaded（界面据此不再显示骨架屏）', async () => {
    vi.spyOn(api, 'listTasks').mockResolvedValue({ items: [task('t1', 'succeeded')] })
    const store = useTaskStore()

    await store.load()

    expect(store.items).toHaveLength(1)
    expect(store.loaded).toBe(true)
    expect(store.error).toBe('')
  })

  it('并发 load 合并成一次请求', async () => {
    const list = vi.spyOn(api, 'listTasks').mockResolvedValue({ items: [] })
    const store = useTaskStore()

    await Promise.all([store.load(), store.load()])

    expect(list).toHaveBeenCalledTimes(1)
  })

  it('prefetch 失败静默：不在用户进页面之前弹错误', async () => {
    vi.spyOn(api, 'listTasks').mockRejectedValue(new Error('后端不可达'))
    const store = useTaskStore()

    await store.prefetch()

    expect(store.error).toBe('')
    expect(store.loaded).toBe(false)
    // 真正进页面时（load）才如实报错
    await store.load()
    expect(store.error).toBe('后端不可达')
  })

  it('prefetch 已有缓存时不重复请求', async () => {
    const list = vi.spyOn(api, 'listTasks').mockResolvedValue({ items: [] })
    const store = useTaskStore()
    await store.load()

    await store.prefetch()

    expect(list).toHaveBeenCalledTimes(1)
  })

  it('hasActive 反映"还有任务在跑"（决定要不要轮询）', async () => {
    vi.spyOn(api, 'listTasks').mockResolvedValue({
      items: [task('t1', 'succeeded'), task('t2', 'running')],
    })
    const store = useTaskStore()
    await store.load()

    expect(store.hasActive).toBe(true)
  })
})
