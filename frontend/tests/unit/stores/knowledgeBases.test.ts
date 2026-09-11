import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as documentsApi from '@/api/documents'
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
    can_manage: true,
    can_write: true,
  }
}

function doc(knowledgeBaseId: string, updatedAt: string | null): documentsApi.DocumentSummary {
  return {
    id: `doc_${Math.random().toString(36).slice(2, 8)}`,
    knowledge_base_id: knowledgeBaseId,
    name: 'a.md',
    source_kind: 'upload',
    stage: 'indexed',
    size_bytes: 100,
    mime_type: 'text/markdown',
    page_count: null,
    is_split: false,
    error: null,
    chunk_count: 3,
    // G6：归属标注。未指定使用者时为 null / 空串
    uploaded_by: null,
    uploaded_by_name: '',
    created_at: updatedAt,
    updated_at: updatedAt,
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

  it('汇总文档数与最近更新，供侧栏与概览页共用', async () => {
    vi.spyOn(api, 'listKnowledgeBases').mockResolvedValue({
      items: [kb('kb_1', '手册'), kb('kb_2', '归档')],
    })
    vi.spyOn(documentsApi, 'listDocuments').mockImplementation(async (kbId: string) => ({
      items:
        kbId === 'kb_1'
          ? [doc('kb_1', '2026-09-01T09:00:00'), doc('kb_1', '2026-09-08T09:00:00')]
          : [],
    }))

    const store = useKnowledgeBaseStore()
    await store.load()
    await store.loadSummaries()

    expect(store.summaries['kb_1']).toEqual({ count: 2, updatedAt: '2026-09-08T09:00:00' })
    // 空库不进汇总表：界面据此显示占位符，而不是一个容易误读的 0
    expect(store.summaries['kb_2']).toBeUndefined()
  })

  it('汇总失败时留空表，不抛给界面', async () => {
    vi.spyOn(api, 'listKnowledgeBases').mockResolvedValue({ items: [kb('kb_1', '手册')] })
    vi.spyOn(documentsApi, 'listDocuments').mockRejectedValue(new Error('后端不可达'))

    const store = useKnowledgeBaseStore()
    await store.load()
    await store.loadSummaries()

    expect(store.summaries).toEqual({})
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
})
