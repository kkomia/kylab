import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '@/api/knowledgeBases'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

function kb(id: string, name: string): api.KnowledgeBase {
  return {
    id,
    name,
    embedding_model_id: 'dev/deterministic-hash',
    embedding_dim: 256,
    chunk_strategy: 'fixed',
    chunk_size: 512,
    chunk_overlap: 64,
    created_at: '2026-09-10T00:00:00Z',
  }
}

describe('useKnowledgeBaseStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('加载后写入清单并清掉上次的错误', async () => {
    vi.spyOn(api, 'listKnowledgeBases').mockResolvedValue({ items: [kb('kb_1', '手册')] })
    const store = useKnowledgeBaseStore()
    store.error = '上一次失败了'

    await store.load()

    expect(store.items).toHaveLength(1)
    expect(store.error).toBe('')
    expect(store.loading).toBe(false)
  })

  it('加载失败时保留错误文案且不留下半截数据', async () => {
    vi.spyOn(api, 'listKnowledgeBases').mockRejectedValue(new Error('后端不可达'))
    const store = useKnowledgeBaseStore()

    await store.load()

    expect(store.error).toBe('后端不可达')
    expect(store.items).toEqual([])
  })

  it('新建后立刻进清单，界面不用等下一次刷新', async () => {
    vi.spyOn(api, 'createKnowledgeBase').mockResolvedValue(kb('kb_9', '新建的'))
    const store = useKnowledgeBaseStore()

    const created = await store.create({ name: '新建的' })

    expect(created.id).toBe('kb_9')
    expect(store.items.map((item) => item.id)).toEqual(['kb_9'])
  })

  it('§5.1：超过 12 条要切列表形态', async () => {
    vi.spyOn(api, 'listKnowledgeBases').mockResolvedValue({
      items: Array.from({ length: 12 }, (_, index) => kb(`kb_${index}`, `库${index}`)),
    })
    const store = useKnowledgeBaseStore()
    await store.load()
    expect(store.useCardGrid).toBe(true)

    store.items = [...store.items, kb('kb_13', '第十三个')]
    expect(store.useCardGrid).toBe(false)
  })

  it('byId 找不到时返回 undefined，不抛异常', () => {
    const store = useKnowledgeBaseStore()
    expect(store.byId('kb_missing')).toBeUndefined()
  })
})
