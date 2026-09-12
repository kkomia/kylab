/**
 * 会话清单 store（含 v17 的置顶与搜索）。
 *
 * 这里钉的是**本地顺序**：置顶要"点完立刻见效"，所以 store 自己重排一份，
 * 而不是等重新拉列表。那份顺序必须与后端的 `pinned DESC, updated_at DESC` 一致——
 * 不一致的话，刷新一次页面看到的顺序会跳一下。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '@/api/conversations'
import { useConversationStore } from '@/stores/conversations'
import type { ConversationSummary } from '@/api/conversations'

vi.mock('@/api/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/conversations')>()
  return {
    ...actual,
    listConversations: vi.fn(),
    updateConversation: vi.fn(),
    deleteConversation: vi.fn(),
  }
})

function summary(id: string, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: id,
    kb_ids: [],
    model_pk: null,
    thinking: null,
    thinking_effort: null,
    pinned: false,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    message_count: 2,
    ...extra,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('load', () => {
  it('把搜索词交给后端（只筛已加载的 50 条会搜不到更早的会话）', async () => {
    vi.mocked(api.listConversations).mockResolvedValue({ items: [] })
    const store = useConversationStore()

    await store.load('眼科')

    expect(api.listConversations).toHaveBeenCalledWith(50, '眼科')
  })
})

describe('setPinned', () => {
  it('置顶后本地立刻排到最前，不重新拉列表', async () => {
    vi.mocked(api.updateConversation).mockResolvedValue(summary('c1', { pinned: true }))
    const store = useConversationStore()
    store.items = [
      summary('c1', { updated_at: '2026-09-01T00:00:00Z' }),
      summary('c2', { updated_at: '2026-09-09T00:00:00Z' }),
    ]

    await store.setPinned('c1', true)

    expect(store.items.map((item) => item.id)).toEqual(['c1', 'c2'])
    // 重排就够，不必再拉一次（那会让侧栏闪一下）
    expect(api.listConversations).not.toHaveBeenCalled()
  })

  it('取消置顶后回到"最近更新"的顺序', async () => {
    vi.mocked(api.updateConversation).mockResolvedValue(summary('c1', { pinned: false }))
    const store = useConversationStore()
    store.items = [
      summary('c1', { pinned: true, updated_at: '2026-09-01T00:00:00Z' }),
      summary('c2', { updated_at: '2026-09-09T00:00:00Z' }),
    ]

    await store.setPinned('c1', false)

    expect(store.items.map((item) => item.id)).toEqual(['c2', 'c1'])
  })

  it('排序口径与后端一致：置顶优先，其次按 updated_at 倒序', async () => {
    vi.mocked(api.updateConversation).mockResolvedValue(summary('c3', { pinned: true }))
    const store = useConversationStore()
    store.items = [
      summary('c1', { updated_at: '2026-09-05T00:00:00Z' }),
      summary('c2', { updated_at: '2026-09-07T00:00:00Z' }),
      summary('c3', { updated_at: '2026-09-01T00:00:00Z' }),
    ]

    await store.setPinned('c3', true)

    // c3 置顶在前；其余按时间倒序 c2 > c1
    expect(store.items.map((item) => item.id)).toEqual(['c3', 'c2', 'c1'])
  })
})

describe('rename / remove', () => {
  it('改名只换标题、不重排（改标题不该改变会话的时间顺序）', async () => {
    vi.mocked(api.updateConversation).mockResolvedValue(summary('c1', { title: '新名字' }))
    const store = useConversationStore()
    store.items = [summary('c1'), summary('c2')]

    await store.rename('c1', '新名字')

    expect(store.items.map((item) => item.id)).toEqual(['c1', 'c2'])
    expect(store.items[0].title).toBe('新名字')
    expect(api.updateConversation).toHaveBeenCalledWith('c1', { title: '新名字' })
  })

  it('删除后从列表里摘掉', async () => {
    vi.mocked(api.deleteConversation).mockResolvedValue(undefined)
    const store = useConversationStore()
    store.items = [summary('c1'), summary('c2')]

    await store.remove('c1')

    expect(store.items.map((item) => item.id)).toEqual(['c2'])
  })
})
