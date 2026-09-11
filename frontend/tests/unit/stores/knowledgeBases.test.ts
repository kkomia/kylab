import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '@/api/knowledgeBases'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

function kb(
  id: string,
  name: string,
  counts: { document_count?: number; last_activity?: string | null } = {},
): api.KnowledgeBase {
  return {
    id,
    name,
    embedding_model_id: 'dev/deterministic-hash',
    embedding_dim: 256,
    chunk_strategy: 'fixed',
    chunk_size: 512,
    chunk_overlap: 64,
    created_at: '2026-09-10T00:00:00Z',
    can_manage: true,
    can_write: true,
    document_count: counts.document_count ?? 0,
    last_activity: counts.last_activity ?? null,
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

  it('汇总（文档数 / 最近更新）随列表一次带回，不再逐库拉文档', async () => {
    const listDocuments = vi.spyOn(api, 'listKnowledgeBases').mockResolvedValue({
      items: [
        kb('kb_1', '手册', { document_count: 2, last_activity: '2026-09-08T09:00:00' }),
        kb('kb_2', '空库'),
      ],
    })

    const store = useKnowledgeBaseStore()
    await store.load()

    expect(store.summaries['kb_1']).toEqual({ count: 2, updatedAt: '2026-09-08T09:00:00' })
    // 空库也给 0/None：数字是后端聚合出来的，比占位符准
    expect(store.summaries['kb_2']).toEqual({ count: 0, updatedAt: null })
    expect(listDocuments).toHaveBeenCalledTimes(1)
  })

  it('forget 同时清掉该库的汇总数据', async () => {
    const store = useKnowledgeBaseStore()
    store.items = [kb('kb_1', '手册')]
    store.summaries = { kb_1: { count: 2, updatedAt: null } }

    store.forget('kb_1')

    expect(store.items).toEqual([])
    expect(store.summaries).toEqual({})
  })

  it('byId 找不到时返回 undefined，不抛异常', () => {
    const store = useKnowledgeBaseStore()
    expect(store.byId('kb_missing')).toBeUndefined()
  })

  it('重命名就地更新清单（侧栏与对话页共用同一份）', async () => {
    vi.spyOn(api, 'renameKnowledgeBase').mockResolvedValue(kb('kb_1', '新名字'))
    const store = useKnowledgeBaseStore()
    store.items = [kb('kb_1', '旧名字')]

    const updated = await store.rename('kb_1', '新名字')

    expect(updated.name).toBe('新名字')
    expect(store.items[0]?.name).toBe('新名字')
    // 改名不该把它的计数丢掉
    expect(store.summaries['kb_1']).toEqual({ count: 0, updatedAt: null })
  })

  it('删库成功后从清单与汇总里一起摘掉', async () => {
    vi.spyOn(api, 'deleteKnowledgeBase').mockResolvedValue({
      kind: 'knowledge_base',
      id: 'kb_1',
      name: '手册',
      documents: 2,
      chunks: 12,
      parts: 0,
      size_bytes: 1024,
      running_tasks: 0,
      document_names: [],
      restorable: false,
    })
    const store = useKnowledgeBaseStore()
    store.items = [kb('kb_1', '手册'), kb('kb_2', '归档')]
    store.summaries = { kb_1: { count: 2, updatedAt: null } }

    const report = await store.remove('kb_1')

    expect(report.documents).toBe(2)
    expect(store.items.map((item) => item.id)).toEqual(['kb_2'])
    expect(store.summaries).toEqual({})
  })
})
