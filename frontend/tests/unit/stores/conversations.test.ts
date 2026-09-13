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
import {
  clearConversationDetailCache,
  latestConversationId,
  useConversationStore,
} from '@/stores/conversations'
import type { ConversationDetail, ConversationSummary, StoredMessage } from '@/api/conversations'

vi.mock('@/api/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/conversations')>()
  return {
    ...actual,
    listConversations: vi.fn(),
    updateConversation: vi.fn(),
    deleteConversation: vi.fn(),
    getConversation: vi.fn(),
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

function detail(id: string, extra: Partial<ConversationDetail> = {}): ConversationDetail {
  return { ...summary(id), messages: [], ...extra }
}

function stored(content: string): StoredMessage {
  return { id: '', role: 'user', content, sources: [], created_at: null }
}

beforeEach(() => {
  setActivePinia(createPinia())
  clearConversationDetailCache()
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

describe('latestId（侧栏「对话」入口的落点）', () => {
  it('按最近活动挑，不按列表第一行（置顶的不算"最新"）', async () => {
    vi.mocked(api.listConversations).mockResolvedValue({
      items: [
        // 后端是"置顶优先"排的：c_old 置顶在前，但它一周没动过
        summary('c_old', { pinned: true, updated_at: '2026-09-01T00:00:00Z' }),
        summary('c_new', { updated_at: '2026-09-07T00:00:00Z' }),
        summary('c_mid', { updated_at: '2026-09-05T00:00:00Z' }),
      ],
    })

    expect(await useConversationStore().latestId()).toBe('c_new')
  })

  it('一条历史都没有时返回空串（调用方据此停在空态）', async () => {
    vi.mocked(api.listConversations).mockResolvedValue({ items: [] })

    expect(await useConversationStore().latestId()).toBe('')
  })

  it('列表里 updated_at 缺失的条目不会被当成最新', async () => {
    vi.mocked(api.listConversations).mockResolvedValue({
      items: [
        summary('c_unknown', { updated_at: null }),
        summary('c_known', { updated_at: '2026-09-07T00:00:00Z' }),
      ],
    })

    expect(await useConversationStore().latestId()).toBe('c_known')
  })

  it('清单被搜索筛过时，仍问后端要一页（子集里挑"最新"会挑错）', async () => {
    const store = useConversationStore()
    store.items = [summary('c_filtered', { updated_at: '2026-09-09T00:00:00Z' })]
    vi.mocked(api.listConversations).mockResolvedValue({
      items: [summary('c_new', { updated_at: '2026-09-07T00:00:00Z' })],
    })

    await store.load('眼科') // 筛过的清单
    expect(await store.latestId()).toBe('c_new')
    expect(api.listConversations).toHaveBeenCalledTimes(2)
  })

  it('已有完整清单时本地取最大，不再多一次往返（"点对话空白一下"的来源）', async () => {
    vi.mocked(api.listConversations).mockResolvedValue({
      items: [
        summary('c_old', { pinned: true }),
        summary('c_new', { updated_at: '2026-09-07T00:00:00Z' }),
      ],
    })
    const store = useConversationStore()
    await store.load()
    vi.mocked(api.listConversations).mockClear()

    expect(await store.latestId()).toBe('c_new')
    expect(api.listConversations).not.toHaveBeenCalled()
  })

  it('一个会话都没有时也认本地清单，不再为此回源', async () => {
    vi.mocked(api.listConversations).mockResolvedValue({ items: [] })
    const store = useConversationStore()
    await store.load()
    vi.mocked(api.listConversations).mockClear()

    expect(await store.latestId()).toBe('')
    expect(api.listConversations).not.toHaveBeenCalled()
  })
})

describe('latestConversationId（纯函数口径）', () => {
  it('取 updated_at 最大的一条，不被置顶排第一带偏', () => {
    const items = [
      summary('pinned_old', { pinned: true, updated_at: '2026-01-01T00:00:00Z' }),
      summary('new', { updated_at: '2026-09-13T00:00:00Z' }),
    ]

    expect(latestConversationId(items)).toBe('new')
  })

  it('空清单返回空串；缺失 updated_at 的不算最新；时间相同取先遇到的', () => {
    expect(latestConversationId([])).toBe('')
    expect(latestConversationId([summary('a', { updated_at: null })])).toBe('a')
    expect(latestConversationId([summary('x', { updated_at: null }), summary('y')])).toBe('y')
    expect(latestConversationId([summary('first'), summary('second')])).toBe('first')
  })
})

describe('会话正文缓存', () => {
  it('fetchDetail 命中同一会话的并发请求只回源一次', async () => {
    let resolve!: (value: ConversationDetail) => void
    vi.mocked(api.getConversation).mockReturnValue(
      new Promise<ConversationDetail>((r) => {
        resolve = r
      }),
    )
    const store = useConversationStore()

    const first = store.fetchDetail('c1')
    const second = store.fetchDetail('c1')
    resolve(detail('c1'))

    expect(await first).toEqual(await second)
    expect(api.getConversation).toHaveBeenCalledTimes(1)
    expect(store.cachedDetail('c1')?.id).toBe('c1')
  })

  it('缓存过期后 cachedDetail 返回 null（随后会回源）', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(api.getConversation).mockResolvedValue(detail('c1'))
      const store = useConversationStore()
      await store.fetchDetail('c1')
      expect(store.cachedDetail('c1')).not.toBeNull()

      vi.advanceTimersByTime(5 * 60_000 + 1)

      expect(store.cachedDetail('c1')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefetchDetail 已缓存或已在飞时不再请求；失败静默', async () => {
    vi.mocked(api.getConversation).mockResolvedValue(detail('c1'))
    const store = useConversationStore()
    await store.prefetchDetail('c1')
    await store.prefetchDetail('c1')
    expect(api.getConversation).toHaveBeenCalledTimes(1)

    vi.mocked(api.getConversation).mockRejectedValue(new Error('断网'))
    await expect(store.prefetchDetail('c2')).resolves.toBeUndefined()
  })

  it('rememberDetailMessages 用本地刚聊完的消息覆盖缓存（切走再切回不看到旧版）', () => {
    const store = useConversationStore()
    store.rememberDetail(detail('c1'))

    store.rememberDetailMessages('c1', [stored('第一句'), stored('第二句')])

    const cached = store.cachedDetail('c1')
    expect(cached?.messages.map((m) => m.content)).toEqual(['第一句', '第二句'])
    expect(cached?.message_count).toBe(2)
  })

  it('refreshDetail 同时校准缓存与侧栏那一条（标题、条数、时间）', async () => {
    const store = useConversationStore()
    store.items = [summary('c1', { title: '旧标题' })]
    store.loaded = true
    vi.mocked(api.getConversation).mockResolvedValue(
      detail('c1', { title: '新标题', message_count: 3, updated_at: '2026-09-13T00:00:00Z' }),
    )

    await store.refreshDetail('c1')

    expect(store.items[0].title).toBe('新标题')
    expect(store.items[0].message_count).toBe(3)
    expect(store.cachedDetail('c1')?.title).toBe('新标题')
  })

  it('refreshDetail 后顺序与后端一致：不把非置顶会话顶到置顶会话之上', async () => {
    const store = useConversationStore()
    store.items = [
      summary('c_pinned', { pinned: true, updated_at: '2026-09-01T00:00:00Z' }),
      summary('c_other', { updated_at: '2026-09-05T00:00:00Z' }),
      summary('c_chatted', { updated_at: '2026-09-06T00:00:00Z' }),
    ]
    store.loaded = true
    vi.mocked(api.getConversation).mockResolvedValue(
      detail('c_chatted', { updated_at: '2026-09-13T00:00:00Z' }),
    )

    await store.refreshDetail('c_chatted')

    // 置顶的仍在最前；刚聊过的排在其余之前
    expect(store.items.map((i) => i.id)).toEqual(['c_pinned', 'c_chatted', 'c_other'])
  })

  it('refreshDetail 只在 404 时把会话从清单摘掉，普通失败保持不动', async () => {
    const store = useConversationStore()
    store.items = [summary('c1'), summary('c2')]

    vi.mocked(api.getConversation).mockRejectedValue(
      Object.assign(new Error('boom'), { status: 500 }),
    )
    await store.refreshDetail('c1')
    expect(store.items.map((i) => i.id)).toEqual(['c1', 'c2'])

    vi.mocked(api.getConversation).mockRejectedValue(
      Object.assign(new Error('gone'), { status: 404 }),
    )
    await store.refreshDetail('c1')
    expect(store.items.map((i) => i.id)).toEqual(['c2'])
  })

  it('删除会话时把它从正文缓存里清掉', async () => {
    vi.mocked(api.deleteConversation).mockResolvedValue(undefined)
    const store = useConversationStore()
    store.rememberDetail(detail('c1'))

    await store.remove('c1')

    expect(store.cachedDetail('c1')).toBeNull()
  })
})
